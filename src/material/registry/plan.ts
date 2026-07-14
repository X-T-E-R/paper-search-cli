import path from "node:path";
import { loadMaterialProviderPackage } from "../package/load.js";
import type { MaterialProviderKind, MaterialProviderManifest } from "../types.js";
import { getSystemVersion, semverCompare, semverGte } from "../../runtime/version.js";
import { createPlanEnvelope, type PlannedOperationStep } from "../../surface/plan.js";
import type { ResultEnvelope } from "../../surface/resultEnvelope.js";
import { sanitizeUrlForDisplay } from "../../runtime/sanitizeUrl.js";
import {
  configuredProviderInstallDir,
  configuredProviderTargetPath,
  listProviderPackageDirectories,
} from "../../providers/paths.js";
import {
  resolveMaterialRegistryArchiveRef,
  resolveMaterialRegistryPackagePath,
  type LoadedMaterialProviderRegistryManifest,
  materialRegistryMinRequiredVersion,
  type MaterialProviderRegistryEntry,
} from "./load.js";

export type MaterialProviderRegistryPlanAction = "install" | "update" | "skip" | "blocked";

export interface InstalledMaterialProviderSummary {
  id: string;
  version?: string;
  path: string;
  layout: "kind" | "legacy";
  valid: boolean;
  manifest?: MaterialProviderManifest;
  error?: string;
}

export interface MaterialProviderRegistryPlanEntry {
  id: string;
  action: MaterialProviderRegistryPlanAction;
  reason: string;
  registryVersion: string;
  installedVersion?: string;
  minRequiredVersion?: string;
  packagePath?: string;
  archiveRef?: string;
  checksum?: { sha256?: string };
  installPath: string;
  provider?: {
    id: string;
    kind?: MaterialProviderKind;
    name?: string;
    version: string;
  };
}

export interface MaterialProviderRegistryPlanReport {
  currentVersion: string;
  source: string;
  resolvedFrom: string;
  installDir: string;
  selectedProviderIds: string[];
  actions: MaterialProviderRegistryPlanEntry[];
  counts: Record<MaterialProviderRegistryPlanAction, number>;
}

export interface MaterialProviderRegistryPlanData {
  intendedSteps: PlannedOperationStep[];
  selectedPolicy: string | null;
  selectedProvider: {
    id: string;
    kind: "material";
    capabilities: ["operate"];
  };
  targetPaths: string[];
  report: MaterialProviderRegistryPlanReport;
  actions: MaterialProviderRegistryPlanEntry[];
}

export class MaterialProviderRegistryPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialProviderRegistryPlanError";
  }
}

function fail(message: string): never {
  throw new MaterialProviderRegistryPlanError(message);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function checksumForEntry(entry: MaterialProviderRegistryEntry): { sha256?: string } | undefined {
  const sha256 = entry.checksum?.sha256 ?? entry.sha256;
  return sha256 ? { sha256 } : entry.checksum;
}

async function inspectRegistryEntryPackage(
  registry: LoadedMaterialProviderRegistryManifest,
  entry: MaterialProviderRegistryEntry,
): Promise<{
  packagePath?: string;
  provider?: MaterialProviderRegistryPlanEntry["provider"];
  blockedReason?: string;
}> {
  if (!entry.packagePath) return {};

  const packagePath = resolveMaterialRegistryPackagePath(registry, entry.packagePath);
  try {
    const loaded = await loadMaterialProviderPackage(packagePath);
    const manifest = loaded.manifest;
    if (manifest.id !== entry.id) {
      return {
        packagePath,
        provider: {
          id: manifest.id,
          kind: manifest.kind,
          name: manifest.name,
          version: manifest.version,
        },
        blockedReason: `package manifest id ${manifest.id} does not match registry id ${entry.id}`,
      };
    }
    if (manifest.version !== entry.version) {
      return {
        packagePath,
        provider: {
          id: manifest.id,
          kind: manifest.kind,
          name: manifest.name,
          version: manifest.version,
        },
        blockedReason: `package manifest version ${manifest.version} does not match registry version ${entry.version}`,
      };
    }
    if (entry.kind && manifest.kind !== entry.kind) {
      return {
        packagePath,
        provider: {
          id: manifest.id,
          kind: manifest.kind,
          name: manifest.name,
          version: manifest.version,
        },
        blockedReason: `package manifest kind ${manifest.kind} does not match registry kind ${entry.kind}`,
      };
    }
    return {
      packagePath,
      provider: {
        id: manifest.id,
        kind: manifest.kind,
        name: manifest.name,
        version: manifest.version,
      },
    };
  } catch (error) {
    return {
      packagePath,
      blockedReason: `package could not be loaded: ${formatError(error)}`,
    };
  }
}

export async function listInstalledMaterialProviders(
  installDir: string,
): Promise<InstalledMaterialProviderSummary[]> {
  const resolvedInstallDir = path.resolve(installDir);
  const materialInstallDir = configuredProviderInstallDir(resolvedInstallDir, "material");
  const providerPaths = await listProviderPackageDirectories(resolvedInstallDir, "material");
  const summaries: InstalledMaterialProviderSummary[] = [];

  for (const packagePath of providerPaths) {
    const layout = path.dirname(packagePath) === materialInstallDir ? "kind" : "legacy";
    try {
      const loaded = await loadMaterialProviderPackage(packagePath);
      summaries.push({
        id: loaded.manifest.id,
        version: loaded.manifest.version,
        path: packagePath,
        layout,
        valid: true,
        manifest: loaded.manifest,
      });
    } catch (error) {
      summaries.push({
        id: path.basename(packagePath),
        path: packagePath,
        layout,
        valid: false,
        error: formatError(error),
      });
    }
  }

  return summaries.sort((left, right) => left.id.localeCompare(right.id));
}

function selectRegistryEntries(
  registry: LoadedMaterialProviderRegistryManifest,
  selectedProviderIds: readonly string[],
): MaterialProviderRegistryEntry[] {
  if (selectedProviderIds.length === 0) return registry.manifest.providers;
  const wanted = new Set(selectedProviderIds);
  const matched = registry.manifest.providers.filter((entry) => wanted.has(entry.id));
  const missing = selectedProviderIds.filter((id) => !matched.some((entry) => entry.id === id));
  if (missing.length > 0) {
    fail(`Material provider(s) not found in registry: ${missing.join(", ")}`);
  }
  return matched;
}

function countActions(
  entries: readonly MaterialProviderRegistryPlanEntry[],
): Record<MaterialProviderRegistryPlanAction, number> {
  const counts: Record<MaterialProviderRegistryPlanAction, number> = {
    install: 0,
    update: 0,
    skip: 0,
    blocked: 0,
  };
  for (const entry of entries) {
    counts[entry.action] += 1;
  }
  return counts;
}

function buildEntryStep(entry: MaterialProviderRegistryPlanEntry): PlannedOperationStep {
  const verb =
    entry.action === "install"
      ? "Install"
      : entry.action === "update"
        ? "Update"
        : entry.action === "skip"
          ? "Skip"
          : "Block";
  return {
    id: `material-provider-${entry.action}-${entry.id}`,
    action: entry.action === "skip" || entry.action === "blocked" ? "compute" : "write",
    description: `${verb} material provider ${entry.id}: ${entry.reason}`,
    targetPaths: [entry.installPath],
    providerId: entry.id,
    policy: "material-provider-registry-plan",
  };
}

export async function planMaterialProviderRegistry(options: {
  registry: LoadedMaterialProviderRegistryManifest;
  installDir: string;
  currentVersion?: string;
  selectedProviderIds?: readonly string[];
}): Promise<ResultEnvelope<MaterialProviderRegistryPlanData>> {
  const currentVersion = options.currentVersion ?? getSystemVersion();
  const providersRoot = path.resolve(options.installDir);
  const installDir = configuredProviderInstallDir(providersRoot, "material");
  const installed = await listInstalledMaterialProviders(providersRoot);
  const selectedProviderIds = [...(options.selectedProviderIds ?? [])];
  const selectedEntries = selectRegistryEntries(options.registry, selectedProviderIds);

  const actions: MaterialProviderRegistryPlanEntry[] = [];
  for (const entry of selectedEntries) {
    const installPath = configuredProviderTargetPath(providersRoot, "material", entry.id);
    const coordinateEntry = installed.find((candidate) => path.basename(candidate.path) === entry.id);
    const installedEntry = coordinateEntry?.valid && coordinateEntry.id === entry.id
      ? coordinateEntry
      : undefined;
    const packageInspection = await inspectRegistryEntryPackage(options.registry, entry);
    const resolvedArchiveRef = resolveMaterialRegistryArchiveRef(options.registry, entry);
    const archiveRef = resolvedArchiveRef
      ? sanitizeUrlForDisplay(resolvedArchiveRef)
      : undefined;
    const base = {
      id: entry.id,
      registryVersion: entry.version,
      installedVersion: installedEntry?.version,
      minRequiredVersion: materialRegistryMinRequiredVersion(entry),
      packagePath: packageInspection.packagePath,
      archiveRef,
      checksum: checksumForEntry(entry),
      installPath,
      provider:
        packageInspection.provider ?? {
          id: entry.id,
          version: entry.version,
          ...(entry.kind ? { kind: entry.kind } : {}),
        },
    };

    const minRequiredVersion = materialRegistryMinRequiredVersion(entry);
    if (minRequiredVersion && !semverGte(currentVersion, minRequiredVersion)) {
      actions.push({
        ...base,
        action: "blocked",
        reason: `requires paper-search-cli >= ${minRequiredVersion}`,
      });
      continue;
    }

    if (packageInspection.blockedReason) {
      actions.push({
        ...base,
        action: "blocked",
        reason: packageInspection.blockedReason,
      });
      continue;
    }

    if (coordinateEntry?.layout === "legacy") {
      if (!installedEntry?.version) {
        actions.push({
          ...base,
          action: "blocked",
          reason: "legacy flat provider must be migrated before registry writes",
        });
        continue;
      }
      const versionCompare = semverCompare(installedEntry.version, entry.version);
      if (versionCompare < 0) {
        actions.push({
          ...base,
          action: "blocked",
          reason: "legacy flat provider must be migrated before update",
        });
        continue;
      }
      actions.push({
        ...base,
        action: "skip",
        reason: versionCompare === 0
          ? "already up to date (legacy flat read fallback)"
          : "installed version is newer than registry (legacy flat read fallback)",
      });
      continue;
    }

    if (!installedEntry?.version) {
      actions.push({
        ...base,
        action: "install",
        reason: "not installed",
      });
      continue;
    }

    const versionCompare = semverCompare(installedEntry.version, entry.version);
    if (versionCompare < 0) {
      actions.push({
        ...base,
        action: "update",
        reason: "registry version is newer",
      });
      continue;
    }

    actions.push({
      ...base,
      action: "skip",
      reason:
        versionCompare === 0 ? "already up to date" : "installed version is newer than registry",
    });
  }

  const intendedSteps = actions.map((entry) => buildEntryStep(entry));
  const report: MaterialProviderRegistryPlanReport = {
    currentVersion,
    source: options.registry.source,
    resolvedFrom: options.registry.resolvedFrom,
    installDir,
    selectedProviderIds,
    actions,
    counts: countActions(actions),
  };
  const envelope = createPlanEnvelope({
    capability: "operate",
    tool: "material_provider_registry_plan",
    intendedSteps,
    selectedPolicy: "material-provider-registry-plan",
    selectedProvider: {
      id: "material-provider-registry",
      kind: "material",
      capabilities: ["operate"],
    },
    targetPaths: [installDir, ...actions.map((entry) => entry.installPath)],
    diagnostics: { actionCounts: report.counts },
    provenance: {
      providerIds: actions.map((entry) => entry.id),
      registrySource: options.registry.resolvedFrom,
    },
  });
  if (!envelope.data) fail("material provider registry plan envelope did not include data");

  return {
    ...envelope,
    data: {
      intendedSteps: envelope.data.intendedSteps,
      selectedPolicy: envelope.data.selectedPolicy,
      selectedProvider: {
        id: "material-provider-registry",
        kind: "material",
        capabilities: ["operate"],
      },
      targetPaths: envelope.data.targetPaths,
      report,
      actions,
    },
  };
}
