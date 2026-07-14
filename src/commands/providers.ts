import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/schema.js";
import {
  applyMaterialProviderZipInstallPlan,
  planMaterialProviderZipInstall,
} from "../material/install/package.js";
import { parseMaterialProviderManifest } from "../material/manifest.js";
import { loadMaterialProviderPackage } from "../material/package/load.js";
import { applyMaterialProviderRegistry } from "../material/registry/apply.js";
import { loadMaterialProviderRegistryManifest } from "../material/registry/load.js";
import { listInstalledMaterialProviders, planMaterialProviderRegistry } from "../material/registry/plan.js";
import { createMaterialRuntimeContext } from "../material/runtime/createContext.js";
import { inspectMaterialProviderPackageInNode } from "../material/runtime/invokeNodeFactory.js";
import {
  applyProviderZipInstallPlan,
  planProviderZipInstall,
} from "../providers/install/zip.js";
import {
  inspectProviderReplacementPrecondition,
  readProviderInstallReceipt,
} from "../providers/install/manualZip.js";
import { parseProviderManifest } from "../providers/manifest/validate.js";
import { loadProviderPackage } from "../providers/package/load.js";
import { loadRegistryManifest } from "../providers/registry/load.js";
import { applyRegistrySync, listInstalledProviders, planRegistrySync } from "../providers/registry/sync.js";
import { expandRegistryUrlCandidates } from "../providers/registry/urlCandidates.js";
import { createNodeCompatibilityApi } from "../providers/runtime/createApi.js";
import { inspectProviderPackageInNode } from "../providers/runtime/invokeNodeFactory.js";
import { listAvailableProviders } from "../providers/catalog.js";
import { inspectProviderDirectory } from "../providers/inventory.js";
import {
  configuredLegacyProviderTargetPath,
  configuredProviderInstallDir,
  configuredProviderTargetPath,
  legacyProviderTargetPath,
  providerTargetPath,
} from "../providers/paths.js";
import {
  executeProviderInstall,
  executeProviderUpdates,
  type AppliedProviderLifecyclePlan,
  type ProviderUpdatePlanSet,
} from "../providers/lifecycle.js";
import type { Io } from "../runtime/io.js";
import { tryAppendLifecycleEvent } from "../runtime/eventLedger.js";
import { withLocks } from "../subscriptions/locks.js";
import { failEnvelope, okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import { inventoryIsGeneralMember } from "../search/selection.js";

type ProviderKind = "search" | "material";

async function assertCompatibilityProviderOwnership(
  kind: ProviderKind,
  installDir: string,
  id: string,
): Promise<void> {
  const targetPath = configuredProviderTargetPath(installDir, kind, id);
  const comparablePath = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const targetKey = comparablePath(targetPath);
  const candidates: Array<{ label: string; path: string }> = [
    { label: "subscription-managed search namespace", path: providerTargetPath("search", id) },
    { label: "subscription-managed material namespace", path: providerTargetPath("material", id) },
    { label: "configured search namespace", path: configuredProviderTargetPath(installDir, "search", id) },
    { label: "configured material namespace", path: configuredProviderTargetPath(installDir, "material", id) },
  ];
  if (id !== "search" && id !== "material") {
    candidates.push(
      { label: "subscription-managed legacy flat namespace", path: legacyProviderTargetPath(id) },
      { label: "configured legacy flat namespace", path: configuredLegacyProviderTargetPath(installDir, id) },
    );
  }

  const seen = new Set<string>();
  const incompatibleOwners: Array<{ label: string; path: string }> = [];
  for (const candidate of candidates) {
    const key = comparablePath(candidate.path);
    if (key === targetKey || seen.has(key)) continue;
    seen.add(key);
    if ((await inspectProviderReplacementPrecondition(candidate.path)).state === "present") {
      incompatibleOwners.push(candidate);
    }
  }
  if (incompatibleOwners.length > 0) {
    throw new Error(
      `Provider ${id} already exists in ${incompatibleOwners.map((entry) => `${entry.label} (${entry.path})`).join(", ")}; refusing a duplicate compatibility install`,
    );
  }

  if ((await inspectProviderReplacementPrecondition(targetPath)).state === "absent") return;
  const receipt = await readProviderInstallReceipt(targetPath);
  if (receipt?.bound) {
    throw new Error(`Provider ${id} is subscription-bound; use providers update`);
  }
  if (receipt && (receipt.runtimeKind !== kind || receipt.id !== id)) {
    throw new Error(
      `Provider ${id} target is owned by ${receipt.runtimeKind}/${receipt.id}; refusing an implicit replacement`,
    );
  }
  try {
    const installed = await inspectProviderDirectory(kind, targetPath);
    if (installed.id !== id) {
      throw new Error(
        `Provider ${id} target contains manifest id ${installed.id}; refusing an implicit identity replacement`,
      );
    }
    return;
  } catch (sameKindError) {
    const otherKind: ProviderKind = kind === "search" ? "material" : "search";
    try {
      await inspectProviderDirectory(otherKind, targetPath);
    } catch {
      // Preserve compatibility for invalid legacy targets; the installer still
      // protects replacement with its exact filesystem precondition.
      if (
        sameKindError instanceof Error &&
        sameKindError.message.includes("refusing an implicit identity replacement")
      ) {
        throw sameKindError;
      }
      return;
    }
    throw new Error(
      `Provider ${id} is already installed as ${otherKind}; refusing an implicit cross-kind replacement`,
    );
  }
}

interface JsonOption {
  json?: boolean;
}

interface ProviderKindOption extends JsonOption {
  kind?: ProviderKind;
}

interface InstallZipOption extends ProviderKindOption {
  apply?: boolean;
}

interface ProviderSelectionOption extends ProviderKindOption {
  provider?: string[];
  apply?: boolean;
}

type ProviderToolBase =
  | "list_installed"
  | "registry_inventory"
  | "validate_manifest"
  | "inspect_package"
  | "registry_plan"
  | "registry_sync"
  | "registry_apply"
  | "install_zip";

interface ProviderCommandRegistration {
  defaultKind: ProviderKind;
  includeRegistryCandidates: boolean;
}

export function registerProviderCommands(program: Command, io: Io): void {
  const providers = program
    .command("providers")
    .description("Manage search and material provider packages. Use --kind search|material to select the runtime.")
    .option("--kind <kind>", "provider runtime to use (search or material)", parseProviderKind, "search");

  registerProviderManagementSubcommands(providers, io, {
    defaultKind: "search",
    includeRegistryCandidates: true,
  });
  registerProviderLifecycleSubcommands(providers, io);

  const materialProviders = program
    .command("material-providers")
    .description("Compatibility alias for material provider management; equivalent to providers --kind material.")
    .option("--kind <kind>", "provider runtime to use (search or material)", parseProviderKind, "material");

  registerProviderManagementSubcommands(materialProviders, io, {
    defaultKind: "material",
    includeRegistryCandidates: false,
  });
}

interface BoundInstallOptions extends JsonOption {
  from?: string;
  apply?: boolean;
}

interface BoundUpdateOptions extends JsonOption {
  apply?: boolean;
}

function registerProviderLifecycleSubcommands(providers: Command, io: Io): void {
  providers
    .command("available [query]")
    .description("List providers from current validated snapshots of all enabled subscriptions.")
    .option("--json", "emit machine-readable JSON")
    .action(async (query: string | undefined, options: JsonOption) => {
      await runBoundProviderAction({
        io,
        json: options.json,
        tool: "providers_available",
        planned: false,
        build: async () => {
          const catalog = await listAvailableProviders(query);
          return okEnvelope({
            capability: "operate",
            tool: "providers_available",
            data: catalog,
            warnings: catalog.issues.map((issue) => `${issue.subscriptionId}: ${issue.message}`),
            diagnostics: {
              candidateCount: catalog.candidates.length,
              ambiguousIds: [...new Set(catalog.candidates.filter((entry) => entry.ambiguous).map((entry) => entry.id))],
            },
          });
        },
        writeHuman: (envelope) => writeAvailableHuman(io, envelope),
      });
    });

  providers
    .command("install <id>")
    .description("Plan or apply a source-bound provider install from a validated subscription snapshot.")
    .option("--from <registry>", "select the subscription when the provider id is ambiguous")
    .option("--apply", "apply the exact displayed source, registry, archive, and installed-state plan")
    .option("--json", "emit machine-readable JSON")
    .action(async (id: string, options: BoundInstallOptions) => {
      await runBoundProviderAction({
        io,
        json: options.json,
        tool: "providers_install",
        planned: !options.apply,
        build: async () => {
          const result = await executeProviderInstall(id, {
            from: options.from,
            apply: Boolean(options.apply),
          });
          return okEnvelope({
            capability: "operate",
            tool: "providers_install",
            planned: !options.apply,
            data: result,
            warnings: result.auditWarnings,
            provenance: {
              providerIds: [result.plan.id],
              subscriptionId: result.plan.binding?.subscriptionId,
              sourceFingerprint: result.plan.binding?.sourceFingerprint,
              registryDigest: result.plan.binding?.registryDigest,
              archiveSha256: result.plan.archive?.archiveSha256,
            },
          });
        },
        writeHuman: (envelope) => writeBoundInstallHuman(io, envelope),
      });
    });

  providers
    .command("update [ids...]")
    .description("Plan or apply updates only from each installed provider receipt's bound source.")
    .option("--apply", "apply the exact displayed source, registry, archive, and installed-state plans")
    .option("--json", "emit machine-readable JSON")
    .action(async (ids: string[], options: BoundUpdateOptions) => {
      await runBoundProviderAction({
        io,
        json: options.json,
        tool: "providers_update",
        planned: !options.apply,
        build: async () => {
          const result = await executeProviderUpdates(ids, { apply: Boolean(options.apply) });
          return okEnvelope({
            capability: "operate",
            tool: "providers_update",
            planned: !options.apply,
            data: result,
            warnings: result.auditWarnings,
            diagnostics: { actionCounts: countActions(result.plan.plans) },
            provenance: { providerIds: result.plan.plans.map((plan) => plan.id) },
          });
        },
        writeHuman: (envelope) => writeBoundUpdateHuman(io, envelope),
      });
    });
}

async function runBoundProviderAction(options: {
  io: Io;
  json?: boolean;
  tool: string;
  planned: boolean;
  build: () => Promise<ResultEnvelope<unknown>>;
  writeHuman: (envelope: ResultEnvelope<unknown>) => void;
}): Promise<void> {
  try {
    const envelope = await options.build();
    if (options.json) options.io.writeJson(envelope);
    else options.writeHuman(envelope);
  } catch (error) {
    const envelope = failEnvelope({
      capability: "operate",
      tool: options.tool,
      errors: [formatError(error)],
    });
    if (options.json) options.io.writeJson(envelope);
    else throw error;
  }
}

function registerProviderManagementSubcommands(
  providers: Command,
  io: Io,
  registration: ProviderCommandRegistration,
): void {
  providers
    .command("list-installed")
    .description("List installed provider packages from the configured install directory.")
    .option("--kind <kind>", "provider runtime to use (search or material)", parseProviderKind)
    .option("--json", "emit machine-readable JSON")
    .action(async (options: ProviderKindOption, command: Command) => {
      await runProviderAction({
        io,
        options,
        command,
        defaultKind: registration.defaultKind,
        toolBase: "list_installed",
        build: async (kind) => {
          const config = await loadCommandConfig(command);
          return listInstalledEnvelope(kind, config);
        },
        writeHuman: (envelope, kind) => writeListInstalledHuman(io, envelope, kind),
      });
    });

  if (registration.includeRegistryCandidates) {
    providers
      .command("registry-candidates <input>")
      .description("Expand a search-provider registry URL or GitHub repo into candidate registry.json URLs.")
      .option("--json", "emit machine-readable JSON")
      .action((input: string, options: JsonOption) => {
        const candidates = expandRegistryUrlCandidates(input);
        if (options.json) {
          io.writeJson({ input, candidates });
          return;
        }
        io.writeLine(`input: ${input}`);
        for (const candidate of candidates) {
          io.writeLine(`- ${candidate}`);
        }
      });

    providers
      .command("inventory [source]")
      .description(
        "Report search entries, countable sources, views, aliases, service families, and retained entries from a registry.",
      )
      .option("--json", "emit machine-readable JSON")
      .action(async (source: string | undefined, options: JsonOption, command: Command) => {
        await runProviderAction({
          io,
          options,
          command,
          defaultKind: registration.defaultKind,
          toolBase: "registry_inventory",
          build: async (kind) => {
            if (kind !== "search") {
              throw new Error("providers inventory supports the search registry only");
            }
            const config = await loadCommandConfig(command);
            return registryInventoryEnvelope(config, source);
          },
          writeHuman: (envelope) => writeRegistryInventoryHuman(io, envelope),
        });
      });
  }

  providers
    .command("validate-manifest <manifest-path>")
    .description("Validate a provider manifest.json using the selected search or material contract.")
    .option("--kind <kind>", "provider runtime to use (search or material)", parseProviderKind)
    .option("--json", "emit machine-readable JSON")
    .action(async (manifestPath: string, options: ProviderKindOption, command: Command) => {
      await runProviderAction({
        io,
        options,
        command,
        defaultKind: registration.defaultKind,
        toolBase: "validate_manifest",
        build: async (kind) => validateManifestEnvelope(kind, manifestPath),
        writeHuman: (envelope, kind) => writeValidateManifestHuman(io, envelope, kind),
      });
    });

  providers
    .command("plan-registry [source]")
    .description(
      "Plan provider install/update actions from a registry.json source without writing files.",
    )
    .option("--provider <id>", "limit to one or more provider IDs", collectOption, [])
    .option("--kind <kind>", "provider runtime to use (search or material)", parseProviderKind)
    .option("--json", "emit machine-readable JSON")
    .action(async (source: string | undefined, options: ProviderSelectionOption, command: Command) => {
      await runProviderAction({
        io,
        options,
        command,
        defaultKind: registration.defaultKind,
        toolBase: "registry_plan",
        build: async (kind) => {
          const config = await loadCommandConfig(command);
          return planRegistryEnvelope(kind, config, source, options.provider ?? []);
        },
        writeHuman: (envelope, kind) => writeRegistryPlanHuman(io, envelope, kind),
      });
    });

  providers
    .command("sync-registry [source]")
    .description(
      "Plan or apply provider install/update actions from a registry.json source. Dry-run by default.",
    )
    .option("--provider <id>", "limit to one or more provider IDs", collectOption, [])
    .option("--kind <kind>", "provider runtime to use (search or material)", parseProviderKind)
    .option("--apply", "write provider changes to the install directory")
    .option("--json", "emit machine-readable JSON")
    .action(async (source: string | undefined, options: ProviderSelectionOption, command: Command) => {
      await runProviderAction({
        io,
        options,
        command,
        defaultKind: registration.defaultKind,
        toolBase: options.apply ? "registry_apply" : "registry_plan",
        build: async (kind) => {
          const config = await loadCommandConfig(command);
          return syncRegistryEnvelope(kind, config, source, options.provider ?? [], Boolean(options.apply));
        },
        writeHuman: (envelope, kind) => writeRegistrySyncHuman(io, envelope, kind, Boolean(options.apply)),
      });
    });

  providers
    .command("inspect-package <package-path>")
    .description(
      "Load a provider package and inspect its selected search or material runtime capabilities.",
    )
    .option("--kind <kind>", "provider runtime to use (search or material)", parseProviderKind)
    .option("--json", "emit machine-readable JSON")
    .action(async (packagePath: string, options: ProviderKindOption, command: Command) => {
      await runProviderAction({
        io,
        options,
        command,
        defaultKind: registration.defaultKind,
        toolBase: "inspect_package",
        build: async (kind) => {
          const config = await loadCommandConfig(command);
          return inspectPackageEnvelope(kind, config, packagePath);
        },
        writeHuman: (envelope, kind) => writeInspectPackageHuman(io, envelope, kind),
      });
    });

  providers
    .command("install-zip <zip-path>")
    .description("Plan or apply a manual provider ZIP install. Dry-run by default.")
    .option("--kind <kind>", "provider runtime to use (search or material)", parseProviderKind)
    .option("--apply", "write the validated provider and unbound receipt to the install directory")
    .option("--json", "emit machine-readable JSON")
    .action(async (zipPath: string, options: InstallZipOption, command: Command) => {
      await runProviderAction({
        io,
        options,
        command,
        defaultKind: registration.defaultKind,
        toolBase: "install_zip",
        build: async (kind) => {
          const config = await loadCommandConfig(command);
          return installZipEnvelope(kind, config, zipPath, Boolean(options.apply));
        },
        writeHuman: (envelope) => writeInstallZipHuman(io, envelope, Boolean(options.apply)),
      });
    });
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseProviderKind(value: string): ProviderKind {
  if (value === "search" || value === "material") return value;
  throw new InvalidArgumentError("--kind must be search or material");
}

function providerToolName(kind: ProviderKind, base: ProviderToolBase): string {
  return `${kind === "material" ? "material_provider" : "provider"}_${base}`;
}

function resolveProviderKind(
  options: ProviderKindOption,
  command: Command,
  defaultKind: ProviderKind,
): ProviderKind {
  const globalOptions = command.optsWithGlobals<{ kind?: ProviderKind }>();
  return options.kind ?? globalOptions.kind ?? defaultKind;
}

async function loadCommandConfig(command: Command): Promise<ResolvedConfig> {
  const globalOptions = command.optsWithGlobals<{ config?: string }>();
  return loadConfig({ explicitConfigPath: globalOptions.config });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function runProviderAction(options: {
  io: Io;
  options: ProviderKindOption;
  command: Command;
  defaultKind: ProviderKind;
  toolBase: ProviderToolBase;
  build: (kind: ProviderKind) => Promise<ResultEnvelope<unknown>>;
  writeHuman: (envelope: ResultEnvelope<unknown>, kind: ProviderKind) => void;
}): Promise<void> {
  const started = Date.now();
  const kind = resolveProviderKind(options.options, options.command, options.defaultKind);
  try {
    const envelope = await options.build(kind);
    if (options.options.json) {
      options.io.writeJson(envelope);
      return;
    }
    options.writeHuman(envelope, kind);
  } catch (error) {
    const envelope = failEnvelope({
      capability: "operate",
      tool: providerToolName(kind, options.toolBase),
      errors: [formatError(error)],
      diagnostics: { elapsedMs: Date.now() - started },
    });
    if (options.options.json) {
      options.io.writeJson(envelope);
      return;
    }
    throw error;
  }
}

function requireEnvelopeData<T>(envelope: ResultEnvelope<unknown>): T {
  if (envelope.data === null) {
    throw new Error(envelope.errors?.join("; ") || "Command returned no data");
  }
  return envelope.data as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function countActions(entries: Array<{ action: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.action] = (counts[entry.action] ?? 0) + 1;
  }
  return counts;
}

async function listInstalledEnvelope(
  kind: ProviderKind,
  config: ResolvedConfig,
): Promise<ResultEnvelope<unknown>> {
  const providersRoot = path.resolve(config.providers.installDir);
  const installDir = configuredProviderInstallDir(providersRoot, kind);
  if (kind === "material") {
    const installed = await listInstalledMaterialProviders(providersRoot);
    return okEnvelope({
      capability: "operate",
      tool: providerToolName(kind, "list_installed"),
      data: { kind, providersRoot, installDir, installed },
      diagnostics: {
        installedCount: installed.length,
        invalidCount: installed.filter((entry) => !entry.valid).length,
      },
      provenance: { providerIds: installed.filter((entry) => entry.valid).map((entry) => entry.id) },
    });
  }

  const installed = await listInstalledProviders(providersRoot);
  return okEnvelope({
    capability: "operate",
    tool: providerToolName(kind, "list_installed"),
    data: { kind, providersRoot, installDir, installed },
    diagnostics: {
      installedCount: installed.length,
      invalidCount: installed.filter((entry) => !entry.valid).length,
    },
    provenance: { providerIds: installed.filter((entry) => entry.valid).map((entry) => entry.id) },
  });
}

async function validateManifestEnvelope(
  kind: ProviderKind,
  manifestPath: string,
): Promise<ResultEnvelope<unknown>> {
  const raw = await readFile(manifestPath, "utf8");
  const manifest = kind === "material" ? parseMaterialProviderManifest(raw) : parseProviderManifest(raw);
  return okEnvelope({
    capability: "operate",
    tool: providerToolName(kind, "validate_manifest"),
    data: {
      kind,
      manifestPath: path.resolve(manifestPath),
      manifest,
    },
    provenance: { providerIds: [manifest.id] },
  });
}

async function inspectPackageEnvelope(
  kind: ProviderKind,
  config: ResolvedConfig,
  packagePath: string,
): Promise<ResultEnvelope<unknown>> {
  if (kind === "material") {
    const providerPackage = await loadMaterialProviderPackage(packagePath);
    const runtimeContext = createMaterialRuntimeContext({
      manifest: providerPackage.manifest,
      providerConfig: asRecord(config.platform[providerPackage.manifest.id]),
      policy: { name: "material-provider-inspect" },
      cacheRoot: path.join(config.workspace.root, ".paper-search", "material-provider-cache"),
      workspaceRoot: config.workspace.root,
      transport: {
        async get(): Promise<never> {
          throw new Error("Network access is disabled during material provider inspection");
        },
        async post(): Promise<never> {
          throw new Error("Network access is disabled during material provider inspection");
        },
      },
    });
    const inspection = await inspectMaterialProviderPackageInNode(providerPackage, runtimeContext);
    return okEnvelope({
      capability: "operate",
      tool: providerToolName(kind, "inspect_package"),
      data: {
        kind,
        packagePath: providerPackage.packagePath,
        manifestPath: providerPackage.manifestPath,
        entrypointPath: providerPackage.entrypointPath,
        manifest: providerPackage.manifest,
        inspection,
      },
      diagnostics: { methodCount: inspection.methods.length },
      provenance: { providerIds: [providerPackage.manifest.id] },
    });
  }

  const providerPackage = await loadProviderPackage(packagePath);
  const api = createNodeCompatibilityApi({
    manifest: providerPackage.manifest,
    providerConfig: asRecord(config.platform[providerPackage.manifest.id]),
    globalPrefs: asRecord(config.platform.global),
  });
  const inspection = await inspectProviderPackageInNode(providerPackage, api);
  return okEnvelope({
    capability: "operate",
    tool: providerToolName(kind, "inspect_package"),
    data: {
      kind,
      packagePath: providerPackage.packagePath,
      manifestPath: providerPackage.manifestPath,
      providerScriptPath: providerPackage.providerScriptPath,
      manifest: providerPackage.manifest,
      inspection,
    },
    diagnostics: {
      hasSearch: inspection.hasSearch,
      hasGetDetail: inspection.hasGetDetail,
    },
    provenance: { providerIds: [providerPackage.manifest.id] },
  });
}

async function planRegistryEnvelope(
  kind: ProviderKind,
  config: ResolvedConfig,
  source: string | undefined,
  selectedProviderIds: string[],
): Promise<ResultEnvelope<unknown>> {
  const registrySource = source ?? config.providers.registryUrl;
  if (kind === "material") {
    const registry = await loadMaterialProviderRegistryManifest(registrySource);
    return planMaterialProviderRegistry({
      registry,
      installDir: config.providers.installDir,
      selectedProviderIds,
    });
  }

  const registry = await loadRegistryManifest(registrySource);
  const plan = await planRegistrySync({
    registry,
    installDir: config.providers.installDir,
    selectedProviderIds,
  });
  return okEnvelope({
    capability: "operate",
    tool: providerToolName(kind, "registry_plan"),
    planned: true,
    data: {
      kind,
      providersRoot: path.resolve(config.providers.installDir),
      installDir: plan.installDir,
      plan,
    },
    diagnostics: { actionCounts: countActions(plan.entries) },
    provenance: {
      providerIds: plan.entries.map((entry) => entry.id),
      registrySource: plan.resolvedFrom,
      policy: "provider-registry-plan",
    },
  });
}

async function registryInventoryEnvelope(
  config: ResolvedConfig,
  source: string | undefined,
): Promise<ResultEnvelope<unknown>> {
  const registrySource = source ?? config.providers.registryUrl;
  const registry = await loadRegistryManifest(registrySource);
  const inventory = registry.manifest.inventory;
  const published = inventory.filter(
    (entry) => entry.publication.status === "published",
  );
  const retained = inventory.filter(
    (entry) => entry.publication.status === "retained-unpublished",
  );
  const sourceIds = new Set(
    published.flatMap((entry) =>
      entry.entryKind === "source" && entry.sourceId ? [entry.sourceId] : [],
    ),
  );
  const countFacet = (key: "domains" | "contentKinds" | "access") => {
    const values = new Map<string, number>();
    for (const entry of inventory) {
      for (const value of entry[key]) values.set(value, (values.get(value) ?? 0) + 1);
    }
    return Object.fromEntries([...values].sort(([left], [right]) => left.localeCompare(right)));
  };
  const counts = {
    entries: inventory.length,
    publishedEntries: published.length,
    publishedSearchSources: sourceIds.size,
    publishedViews: published.filter((entry) => entry.entryKind === "view").length,
    publishedGeneralPresetMembers: published.filter(inventoryIsGeneralMember).length,
    publishedDefaultInAll: published.filter(
      (entry) => entry.entryKind === "source" && entry.selection.defaultInAll,
    ).length,
    retainedUnpublishedEntries: retained.length,
    aliases: inventory.reduce(
      (total, entry) => total + (entry.aliases?.length ?? 0),
      0,
    ),
    publishedServiceFamilies: new Set(
      published.map((entry) => entry.serviceFamily),
    ).size,
    unknownClassification: registry.manifest.providers.filter(
      (provider) => !inventory.some((entry) => entry.id === provider.id),
    ).length,
  };

  return okEnvelope({
    capability: "operate",
    tool: providerToolName("search", "registry_inventory"),
    data: {
      registry: registry.resolvedFrom,
      counts,
      facets: {
        domains: countFacet("domains"),
        contentKinds: countFacet("contentKinds"),
        access: countFacet("access"),
      },
      inventory,
    },
    diagnostics: counts,
    provenance: {
      providerIds: published.map((entry) => entry.id),
      registrySource: registry.resolvedFrom,
      policy: "provider-registry-inventory",
    },
  });
}

async function syncRegistryEnvelope(
  kind: ProviderKind,
  config: ResolvedConfig,
  source: string | undefined,
  selectedProviderIds: string[],
  apply: boolean,
): Promise<ResultEnvelope<unknown>> {
  const registrySource = source ?? config.providers.registryUrl;
  if (kind === "material") {
    const registry = await loadMaterialProviderRegistryManifest(registrySource);
    const planned = await planMaterialProviderRegistry({
      registry,
      installDir: config.providers.installDir,
      selectedProviderIds,
    });
    if (apply) {
      const auditWarnings: string[] = [];
      const applied = await applyMaterialProviderRegistry({
        registry,
        installDir: config.providers.installDir,
        selectedProviderIds,
        runProviderMutation: (id, mutation) => withLocks(
          [`provider/${id}`],
          async () => {
            await assertCompatibilityProviderOwnership("material", config.providers.installDir, id);
            return mutation();
          },
          { command: "providers sync-registry" },
        ),
        onProviderApplied: async (entry, actions) => {
          const audit = await tryAppendLifecycleEvent({
            command: "providers sync-registry",
            planDigest: createHash("sha256").update(JSON.stringify(actions)).digest("hex"),
            affectedIds: [entry.id],
            ...(entry.archiveSha256
              ? { archiveSha256: entry.archiveSha256 }
              : {}),
            outcome: "applied",
          });
          if (audit.warning) auditWarnings.push(audit.warning);
        },
      });
      return {
        ...applied,
        ...(auditWarnings.length > 0 ? { warnings: [...(applied.warnings ?? []), ...auditWarnings] } : {}),
      };
    }
    return planned;
  }

  const registry = await loadRegistryManifest(registrySource);
  const plan = await planRegistrySync({
    registry,
    installDir: config.providers.installDir,
    selectedProviderIds,
  });

  if (!apply) {
    return okEnvelope({
      capability: "operate",
      tool: providerToolName(kind, "registry_sync"),
      planned: true,
      data: {
        kind,
        apply: false,
        providersRoot: path.resolve(config.providers.installDir),
        installDir: plan.installDir,
        plan,
      },
      diagnostics: { actionCounts: countActions(plan.entries) },
      provenance: {
        providerIds: plan.entries.map((entry) => entry.id),
        registrySource: plan.resolvedFrom,
        policy: "provider-registry-plan",
      },
    });
  }

  const auditWarnings: string[] = [];
  const summary = await applyRegistrySync({
    registry,
    installDir: config.providers.installDir,
    selectedProviderIds,
    runProviderMutation: (id, mutation) => withLocks(
      [`provider/${id}`],
      async () => {
        await assertCompatibilityProviderOwnership("search", config.providers.installDir, id);
        return mutation();
      },
      { command: "providers sync-registry" },
    ),
    onProviderApplied: async (entry, appliedPlan) => {
      const audit = await tryAppendLifecycleEvent({
        command: "providers sync-registry",
        planDigest: createHash("sha256").update(JSON.stringify(appliedPlan)).digest("hex"),
        affectedIds: [entry.id],
        archiveSha256: entry.archiveSha256,
        outcome: "applied",
      });
      if (audit.warning) auditWarnings.push(audit.warning);
    },
  });
  return okEnvelope({
    capability: "operate",
    tool: providerToolName(kind, "registry_apply"),
    data: {
      kind,
      apply: true,
      providersRoot: path.resolve(config.providers.installDir),
      installDir: summary.plan.installDir,
      plan: summary.plan,
      summary,
    },
    diagnostics: {
      actionCounts: countActions(summary.plan.entries),
      appliedCount: summary.applied.length,
      skippedCount: summary.skipped.length,
    },
    provenance: {
      providerIds: summary.plan.entries.map((entry) => entry.id),
      registrySource: summary.plan.resolvedFrom,
      policy: "provider-registry-apply",
    },
    warnings: auditWarnings,
  });
}

async function installZipEnvelope(
  kind: ProviderKind,
  config: ResolvedConfig,
  zipPath: string,
  apply: boolean,
): Promise<ResultEnvelope<unknown>> {
  const providersRoot = path.resolve(config.providers.installDir);
  const installDir = configuredProviderInstallDir(providersRoot, kind);
  if (kind === "material") {
    const plan = await planMaterialProviderZipInstall(zipPath, installDir);
    const result = apply
      ? await withLocks(
          [`provider/${plan.id}`],
          async () => {
            await assertCompatibilityProviderOwnership(
              "material",
              config.providers.installDir,
              plan.id,
            );
            return applyMaterialProviderZipInstallPlan(plan);
          },
          { command: "providers install-zip" },
        )
      : undefined;
    const audit = result
      ? await tryAppendLifecycleEvent({
          command: "providers install-zip",
          planDigest: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
          affectedIds: [plan.id],
          archiveSha256: plan.archiveSha256,
          outcome: "applied",
        })
      : undefined;
    return okEnvelope({
      capability: "operate",
      tool: providerToolName(kind, "install_zip"),
      planned: !apply,
      data: {
        kind,
        apply,
        providersRoot,
        installDir,
        plan,
        ...(result ? { result } : {}),
      },
      provenance: {
        providerIds: [plan.id],
        archiveSha256: plan.archiveSha256,
        installType: plan.installType,
      },
      warnings: audit?.warning ? [audit.warning] : undefined,
    });
  }

  const plan = await planProviderZipInstall(zipPath, installDir);
  const result = apply
    ? await withLocks(
        [`provider/${plan.id}`],
        async () => {
          await assertCompatibilityProviderOwnership("search", config.providers.installDir, plan.id);
          return applyProviderZipInstallPlan(plan);
        },
        { command: "providers install-zip" },
      )
    : undefined;
  const audit = result
    ? await tryAppendLifecycleEvent({
        command: "providers install-zip",
        planDigest: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
        affectedIds: [plan.id],
        archiveSha256: plan.archiveSha256,
        outcome: "applied",
      })
    : undefined;
  return okEnvelope({
    capability: "operate",
    tool: providerToolName(kind, "install_zip"),
    planned: !apply,
    data: {
      kind,
      apply,
      providersRoot,
      installDir,
      plan,
      ...(result ? { result } : {}),
    },
    provenance: {
      providerIds: [plan.id],
      archiveSha256: plan.archiveSha256,
      installType: plan.installType,
    },
    warnings: audit?.warning ? [audit.warning] : undefined,
  });
}

function writeListInstalledHuman(io: Io, envelope: ResultEnvelope<unknown>, kind: ProviderKind): void {
  const payload = requireEnvelopeData<{
    installDir: string;
    installed: Array<{ id: string; version?: string; valid: boolean; error?: string }>;
  }>(envelope);
  io.writeLine(`${kind} provider install dir: ${payload.installDir}`);
  if (payload.installed.length === 0) {
    io.writeLine("(no installed providers)");
    return;
  }
  for (const entry of payload.installed) {
    const suffix = entry.valid ? "" : ` (invalid: ${entry.error})`;
    io.writeLine(`- ${entry.id}${entry.version ? `@${entry.version}` : ""}${suffix}`);
  }
}

function writeValidateManifestHuman(io: Io, envelope: ResultEnvelope<unknown>, kind: ProviderKind): void {
  const payload = requireEnvelopeData<{ manifest: { id: string; version: string; sourceType?: string; kind?: string } }>(
    envelope,
  );
  const runtimeLabel = kind === "material" ? payload.manifest.kind : payload.manifest.sourceType;
  io.writeLine(`manifest ok: ${payload.manifest.id}@${payload.manifest.version} (${runtimeLabel})`);
}

function writeInspectPackageHuman(io: Io, envelope: ResultEnvelope<unknown>, kind: ProviderKind): void {
  const payload = requireEnvelopeData<{
    manifest: { id: string; version: string; sourceType?: string; kind?: string };
    inspection: { hasSearch?: boolean; hasGetDetail?: boolean; methods?: string[] };
  }>(envelope);
  const runtimeLabel = kind === "material" ? payload.manifest.kind : payload.manifest.sourceType;
  io.writeLine(`package ok: ${payload.manifest.id}@${payload.manifest.version} (${runtimeLabel})`);
  if (kind === "material") {
    io.writeLine(`methods: ${(payload.inspection.methods ?? []).join(", ") || "(none)"}`);
    return;
  }
  io.writeLine(
    `capabilities: search=${payload.inspection.hasSearch ? "yes" : "no"}, getDetail=${payload.inspection.hasGetDetail ? "yes" : "no"}`,
  );
}

function writeRegistryPlanHuman(io: Io, envelope: ResultEnvelope<unknown>, kind: ProviderKind): void {
  if (kind === "material") {
    const payload = requireEnvelopeData<{
      report: { installDir: string; resolvedFrom: string };
      actions: Array<{ id: string; action: string; reason: string; registryVersion: string; installedVersion?: string }>;
    }>(envelope);
    writePlanEntries(io, payload.report.installDir, payload.report.resolvedFrom, payload.actions);
    return;
  }

  const payload = requireEnvelopeData<{
    installDir: string;
    plan: {
      resolvedFrom: string;
      entries: Array<{ id: string; action: string; reason: string; registryVersion: string; installedVersion?: string }>;
    };
  }>(envelope);
  writePlanEntries(io, payload.installDir, payload.plan.resolvedFrom, payload.plan.entries);
}

function writeRegistryInventoryHuman(io: Io, envelope: ResultEnvelope<unknown>): void {
  const payload = requireEnvelopeData<{
    registry: string;
    counts: {
      entries: number;
      publishedEntries: number;
      publishedSearchSources: number;
      publishedViews: number;
      publishedGeneralPresetMembers: number;
      publishedDefaultInAll: number;
      retainedUnpublishedEntries: number;
      aliases: number;
      publishedServiceFamilies: number;
      unknownClassification: number;
    };
    inventory: Array<{
      id: string;
      sourceType: "academic" | "patent";
      entryKind: "source" | "view";
      sourceId?: string;
      backingSourceIds?: string[];
      serviceFamily: string;
      transport: string;
      domains: string[];
      contentKinds: string[];
      access: string[];
      selection: { defaultInAll: boolean };
      publication: { status: string; blockers?: string[] };
    }>;
  }>(envelope);
  io.writeLine(`registry: ${payload.registry}`);
  io.writeLine(
    `published: ${payload.counts.publishedSearchSources} sources / ${payload.counts.publishedEntries} entries / ${payload.counts.publishedViews} views`,
  );
  io.writeLine(
    `general preset: ${payload.counts.publishedGeneralPresetMembers}; legacy defaultInAll: ${payload.counts.publishedDefaultInAll}; service families: ${payload.counts.publishedServiceFamilies}; aliases: ${payload.counts.aliases}; retained: ${payload.counts.retainedUnpublishedEntries}; unknown: ${payload.counts.unknownClassification}`,
  );
  for (const entry of payload.inventory) {
    const identity =
      entry.entryKind === "source"
        ? entry.sourceId
        : `view of ${(entry.backingSourceIds ?? []).join(", ")}`;
    io.writeLine(
      `- ${entry.id}: ${entry.entryKind} (${identity}) [${entry.publication.status}; general=${inventoryIsGeneralMember(entry) ? "yes" : "no"}; legacyDefaultInAll=${entry.selection.defaultInAll ? "yes" : "no"}; domains=${entry.domains.join(",")}; content=${entry.contentKinds.join(",")}; access=${entry.access.join(",")}]`,
    );
  }
}

function writeRegistrySyncHuman(
  io: Io,
  envelope: ResultEnvelope<unknown>,
  kind: ProviderKind,
  apply: boolean,
): void {
  if (!apply) {
    io.writeLine("dry-run only; pass --apply to write changes.");
    writeRegistryPlanHuman(io, envelope, kind);
    return;
  }

  if (kind === "material") {
    const payload = requireEnvelopeData<{
      applied: Array<{ action: string; id: string; version: string; installPath: string }>;
      skipped: Array<{ id: string; reason: string }>;
    }>(envelope);
    writeApplyEntries(io, payload.applied, payload.skipped);
    return;
  }

  const payload = requireEnvelopeData<{
    summary: {
      applied: Array<{ action: string; id: string; version: string; installPath: string }>;
      skipped: Array<{ id: string; reason: string }>;
    };
  }>(envelope);
  writeApplyEntries(io, payload.summary.applied, payload.summary.skipped);
}

function writeInstallZipHuman(io: Io, envelope: ResultEnvelope<unknown>, apply: boolean): void {
  const payload = requireEnvelopeData<{
    plan: {
      id: string;
      version: string;
      runtimeKind: ProviderKind;
      providerKind: string;
      archiveSha256: string;
      targetPath: string;
      replacementPrecondition: { state: string };
    };
    result: { id: string; manifest: { version: string }; installPath: string };
  }>(envelope);
  if (!apply) {
    io.writeLine("dry-run only; pass --apply to install this ZIP.");
    io.writeLine(
      `${payload.plan.runtimeKind} provider: ${payload.plan.id}@${payload.plan.version} (${payload.plan.providerKind})`,
    );
    io.writeLine(`archive sha256: ${payload.plan.archiveSha256}`);
    io.writeLine(
      `target: ${payload.plan.targetPath} (${payload.plan.replacementPrecondition.state})`,
    );
    return;
  }
  io.writeLine(`installed ${payload.result.id}@${payload.result.manifest.version} -> ${payload.result.installPath}`);
}

function writePlanEntries(
  io: Io,
  installDir: string,
  registrySource: string,
  entries: Array<{ id: string; action: string; reason: string; registryVersion: string; installedVersion?: string }>,
): void {
  io.writeLine(`install dir: ${installDir}`);
  io.writeLine(`registry: ${registrySource}`);
  for (const entry of entries) {
    io.writeLine(
      `- ${entry.id}: ${entry.action} (${entry.reason}) [registry=${entry.registryVersion}${entry.installedVersion ? ` installed=${entry.installedVersion}` : ""}]`,
    );
  }
}

function writeApplyEntries(
  io: Io,
  applied: Array<{ action: string; id: string; version: string; installPath: string }>,
  skipped: Array<{ id: string; reason: string }>,
): void {
  for (const entry of applied) {
    io.writeLine(`- ${entry.action}: ${entry.id}@${entry.version} -> ${entry.installPath}`);
  }
  for (const entry of skipped) {
    io.writeLine(`- skip: ${entry.id} (${entry.reason})`);
  }
}

function writeAvailableHuman(io: Io, envelope: ResultEnvelope<unknown>): void {
  const catalog = requireEnvelopeData<{
    candidates: Array<{
      id: string;
      version: string;
      runtimeKind: ProviderKind;
      providerKind?: string;
      subscriptionId: string;
      status: string;
      blockedReason?: string;
      ambiguous: boolean;
    }>;
  }>(envelope);
  if (catalog.candidates.length === 0) {
    io.writeLine("(no providers in current enabled registry snapshots)");
    return;
  }
  for (const candidate of catalog.candidates) {
    const state = candidate.status === "blocked" ? `blocked: ${candidate.blockedReason}` : "available";
    const ambiguity = candidate.ambiguous ? " (ambiguous; use --from)" : "";
    io.writeLine(
      `- ${candidate.id}@${candidate.version} [${candidate.runtimeKind}${candidate.providerKind ? `/${candidate.providerKind}` : ""}] from=${candidate.subscriptionId} ${state}${ambiguity}`,
    );
  }
}

function writeLifecyclePlan(io: Io, plan: AppliedProviderLifecyclePlan["plan"]): void {
  io.writeLine(`${plan.id}: ${plan.action} (${plan.reason})`);
  io.writeLine(`target: ${plan.targetPath}`);
  if (plan.binding) {
    io.writeLine(`subscription: ${plan.binding.subscriptionId}`);
    io.writeLine(`source fingerprint: ${plan.binding.sourceFingerprint}`);
    io.writeLine(`registry digest: ${plan.binding.registryDigest}`);
  }
  if (plan.archive) io.writeLine(`archive sha256: ${plan.archive.archiveSha256}`);
  io.writeLine(`installed-state precondition: ${JSON.stringify(plan.installedStatePrecondition)}`);
  io.writeLine(`plan digest: ${plan.planDigest}`);
}

function writeBoundInstallHuman(io: Io, envelope: ResultEnvelope<unknown>): void {
  const result = requireEnvelopeData<AppliedProviderLifecyclePlan>(envelope);
  if (!result.applied) io.writeLine("dry-run only; pass --apply to execute this exact plan.");
  writeLifecyclePlan(io, result.plan);
  if (result.result) {
    io.writeLine(`installed ${result.result.id}@${result.result.version} -> ${result.result.installPath}`);
  }
}

function writeBoundUpdateHuman(io: Io, envelope: ResultEnvelope<unknown>): void {
  const result = requireEnvelopeData<{
    plan: ProviderUpdatePlanSet;
    results: AppliedProviderLifecyclePlan[];
  }>(envelope);
  if (result.results.length === 0) io.writeLine("dry-run only; pass --apply to execute actionable plans.");
  for (const plan of result.plan.plans) writeLifecyclePlan(io, plan);
  for (const applied of result.results.filter((entry) => entry.applied && entry.result)) {
    io.writeLine(`updated ${applied.result!.id}@${applied.result!.version} -> ${applied.result!.installPath}`);
  }
}
