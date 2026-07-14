import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyMaterialProviderZipInstallPlan,
  inspectMaterialProviderZipFile,
  installMaterialProviderFromPackageDir,
  planMaterialProviderZipInstall,
  type InstallMaterialProviderResult,
  type MaterialProviderInstallExpectation,
} from "../install/package.js";
import { okEnvelope, type ResultEnvelope } from "../../surface/resultEnvelope.js";
import {
  resolveMaterialRegistryArchiveRef,
  resolveMaterialRegistryPackagePath,
  loadMaterialRegistryArchive,
  type LoadedMaterialProviderRegistryManifest,
  type MaterialProviderRegistryEntry,
} from "./load.js";
import {
  planMaterialProviderRegistry,
  type MaterialProviderRegistryPlanEntry,
  type MaterialProviderRegistryPlanReport,
} from "./plan.js";

export class MaterialProviderRegistryApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialProviderRegistryApplyError";
  }
}

export interface MaterialProviderRegistryAppliedEntry {
  id: string;
  action: "install" | "update";
  installPath: string;
  version: string;
  checksumTarget?: "archive" | "entry";
  archiveSha256?: string;
  replacedExisting: boolean;
}

export interface MaterialProviderRegistryApplyData {
  applied: MaterialProviderRegistryAppliedEntry[];
  skipped: MaterialProviderRegistryPlanEntry[];
  report: MaterialProviderRegistryPlanReport;
  actions: MaterialProviderRegistryPlanEntry[];
}

export type MaterialProviderMutationRunner = <T>(
  providerId: string,
  mutation: () => Promise<T>,
) => Promise<T>;

interface PreparedMaterialRegistryArchive {
  resolvedRef: string;
  bytes: Uint8Array;
  archiveSha256: string;
}

function fail(message: string): never {
  throw new MaterialProviderRegistryApplyError(message);
}

function checksumForEntry(
  entry: MaterialProviderRegistryEntry,
  target: "archive" | "entry",
): MaterialProviderInstallExpectation["registryChecksum"] | undefined {
  const sha256 = entry.checksum?.sha256 ?? entry.sha256;
  return sha256 ? { sha256, target } : undefined;
}

function registryEntryMap(
  registry: LoadedMaterialProviderRegistryManifest,
): Map<string, MaterialProviderRegistryEntry> {
  return new Map(registry.manifest.providers.map((entry) => [entry.id, entry]));
}

function assertInstalledMatchesPlan(
  planEntry: MaterialProviderRegistryPlanEntry,
  result: InstallMaterialProviderResult,
): void {
  if (result.id !== planEntry.id) {
    fail(`installed manifest id ${result.id} does not match planned provider id ${planEntry.id}`);
  }
  if (result.manifest.version !== planEntry.registryVersion) {
    fail(
      `installed manifest version ${result.manifest.version} does not match planned registry version ${planEntry.registryVersion}`,
    );
  }
}

async function installRegistryEntry(options: {
  registry: LoadedMaterialProviderRegistryManifest;
  installDir: string;
  registryEntry: MaterialProviderRegistryEntry;
  planEntry: MaterialProviderRegistryPlanEntry;
  currentVersion: string;
  preparedArchive?: PreparedMaterialRegistryArchive;
}): Promise<MaterialProviderRegistryAppliedEntry> {
  const expectationBase = {
    id: options.registryEntry.id,
    version: options.registryEntry.version,
    ...(options.registryEntry.kind ? { kind: options.registryEntry.kind } : {}),
    currentVersion: options.currentVersion,
  };

  let checksumTarget: "archive" | "entry" | undefined;
  let result: InstallMaterialProviderResult;
  const archiveRef = resolveMaterialRegistryArchiveRef(options.registry, options.registryEntry);
  if (archiveRef) {
    checksumTarget = "archive";
    const archive = options.preparedArchive;
    if (!archive) fail(`registry archive was not prepared before mutation: ${options.registryEntry.id}`);
    const tempZipPath = path.join(
      os.tmpdir(),
      `paper-search-material-provider-${options.registryEntry.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
    );
    await writeFile(tempZipPath, archive.bytes, { flag: "wx", mode: 0o600 });
    try {
      await inspectMaterialProviderZipFile(tempZipPath, {
        ...expectationBase,
        registryChecksum: checksumForEntry(options.registryEntry, checksumTarget),
      });
      const installPlan = await planMaterialProviderZipInstall(tempZipPath, options.installDir, {
        currentVersion: options.currentVersion,
      });
      result = await applyMaterialProviderZipInstallPlan(installPlan);
    } finally {
      await rm(tempZipPath, { force: true });
    }
  } else if (options.registryEntry.packagePath) {
    checksumTarget = "entry";
    result = await installMaterialProviderFromPackageDir(
      resolveMaterialRegistryPackagePath(options.registry, options.registryEntry.packagePath),
      options.installDir,
      {
        ...expectationBase,
        registryChecksum: checksumForEntry(options.registryEntry, checksumTarget),
      },
    );
  } else {
    fail(`registry entry ${options.registryEntry.id} has no installable package path or archive ref`);
  }

  assertInstalledMatchesPlan(options.planEntry, result);
  return {
    id: result.id,
    action: options.planEntry.action as "install" | "update",
    installPath: result.installPath,
    version: result.manifest.version,
    replacedExisting: result.replacedExisting,
    ...(checksumTarget ? { checksumTarget } : {}),
    ...(options.preparedArchive ? { archiveSha256: options.preparedArchive.archiveSha256 } : {}),
  };
}

async function prepareRegistryArchive(options: {
  registry: LoadedMaterialProviderRegistryManifest;
  registryEntry: MaterialProviderRegistryEntry;
  currentVersion: string;
}): Promise<PreparedMaterialRegistryArchive | undefined> {
  if (!resolveMaterialRegistryArchiveRef(options.registry, options.registryEntry)) return undefined;
  const archive = await loadMaterialRegistryArchive(options.registry, options.registryEntry);
  const tempZipPath = path.join(
    os.tmpdir(),
    `paper-search-material-provider-prepare-${options.registryEntry.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
  );
  await writeFile(tempZipPath, archive.bytes, { flag: "wx", mode: 0o600 });
  try {
    await inspectMaterialProviderZipFile(tempZipPath, {
      id: options.registryEntry.id,
      version: options.registryEntry.version,
      ...(options.registryEntry.kind ? { kind: options.registryEntry.kind } : {}),
      currentVersion: options.currentVersion,
      registryChecksum: checksumForEntry(options.registryEntry, "archive"),
    });
  } finally {
    await rm(tempZipPath, { force: true });
  }
  return {
    ...archive,
    archiveSha256: createHash("sha256").update(archive.bytes).digest("hex"),
  };
}

export async function applyMaterialProviderRegistry(options: {
  registry: LoadedMaterialProviderRegistryManifest;
  installDir: string;
  currentVersion?: string;
  selectedProviderIds?: readonly string[];
  runProviderMutation?: MaterialProviderMutationRunner;
  /** Runs after the provider mutation runner has released its lock. */
  onProviderApplied?: (
    entry: MaterialProviderRegistryAppliedEntry,
    actions: readonly MaterialProviderRegistryPlanEntry[],
  ) => Promise<void> | void;
}): Promise<ResultEnvelope<MaterialProviderRegistryApplyData>> {
  const planEnvelope = await planMaterialProviderRegistry(options);
  if (!planEnvelope.data) fail("material provider registry plan did not include data");
  const planData = planEnvelope.data;

  const entriesById = registryEntryMap(options.registry);
  const applied: MaterialProviderRegistryAppliedEntry[] = [];
  const skipped: MaterialProviderRegistryPlanEntry[] = [];

  for (const planEntry of [...planData.actions].sort((left, right) => left.id.localeCompare(right.id))) {
    if (planEntry.action !== "install" && planEntry.action !== "update") {
      skipped.push(planEntry);
      continue;
    }
    const registryEntry = entriesById.get(planEntry.id);
    if (!registryEntry) fail(`Missing registry entry for ${planEntry.id}`);
    const preparedArchive = await prepareRegistryArchive({
      registry: options.registry,
      registryEntry,
      currentVersion: planData.report.currentVersion,
    });
    const mutate = async () => {
      const currentEnvelope = await planMaterialProviderRegistry({
        registry: options.registry,
        installDir: options.installDir,
        selectedProviderIds: [planEntry.id],
        currentVersion: planData.report.currentVersion,
      });
      if (!currentEnvelope.data) fail(`material provider registry re-plan did not include data: ${planEntry.id}`);
      const currentEntry = currentEnvelope.data.actions[0];
      if (!currentEntry || JSON.stringify(currentEntry) !== JSON.stringify(planEntry)) {
        fail(`Material provider registry plan became stale: ${planEntry.id}`);
      }
      return installRegistryEntry({
        registry: options.registry,
        installDir: planData.report.installDir,
        registryEntry,
        planEntry,
        currentVersion: planData.report.currentVersion,
        ...(preparedArchive ? { preparedArchive } : {}),
      });
    };
    const appliedEntry = options.runProviderMutation
      ? await options.runProviderMutation(planEntry.id, mutate)
      : await mutate();
    applied.push(appliedEntry);
    await options.onProviderApplied?.(appliedEntry, planData.actions);
  }

  return okEnvelope({
    capability: "operate",
    tool: "material_provider_registry_apply",
    data: {
      applied,
      skipped,
      report: planData.report,
      actions: planData.actions,
    },
    diagnostics: {
      actionCounts: planData.report.counts,
      appliedCount: applied.length,
      skippedCount: skipped.length,
    },
    provenance: {
      providerIds: planData.actions.map((entry) => entry.id),
      registrySource: options.registry.resolvedFrom,
      policy: "material-provider-registry-apply",
    },
  });
}
