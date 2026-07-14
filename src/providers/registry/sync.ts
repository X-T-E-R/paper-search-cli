import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseProviderManifest } from "../manifest/validate.js";
import type { ProviderManifest } from "../sdk/types.js";
import { installProviderFromZipFile } from "../install/zip.js";
import { loadRegistryArchive, type LoadedRegistryManifest, type RegistryEntry } from "./load.js";
import { getSystemVersion, semverCompare, semverGte } from "../../runtime/version.js";
import { sanitizeUrlForDisplay } from "../../runtime/sanitizeUrl.js";
import {
  configuredProviderInstallDir,
  configuredProviderTargetPath,
  listProviderPackageDirectories,
} from "../paths.js";

export interface InstalledProviderSummary {
  id: string;
  version?: string;
  path: string;
  layout: "kind" | "legacy";
  valid: boolean;
  error?: string;
  manifest?: ProviderManifest;
}

export type RegistryPlanAction = "install" | "update" | "skip" | "blocked";

export interface RegistryPlanEntry {
  id: string;
  action: RegistryPlanAction;
  reason: string;
  registryVersion: string;
  installedVersion?: string;
  minRequiredVersion?: string;
  downloadRef: string;
  installPath: string;
}

export interface RegistrySyncPlan {
  currentVersion: string;
  source: string;
  resolvedFrom: string;
  installDir: string;
  entries: RegistryPlanEntry[];
}

export interface RegistryApplySummary {
  plan: RegistrySyncPlan;
  applied: Array<{
    id: string;
    action: "install" | "update";
    installPath: string;
    version: string;
    archiveSha256: string;
  }>;
  skipped: RegistryPlanEntry[];
}

export type ProviderMutationRunner = <T>(
  providerId: string,
  mutation: () => Promise<T>,
) => Promise<T>;

export async function listInstalledProviders(
  installDir: string,
): Promise<InstalledProviderSummary[]> {
  const resolvedInstallDir = path.resolve(installDir);
  const searchInstallDir = configuredProviderInstallDir(resolvedInstallDir, "search");
  const providerPaths = await listProviderPackageDirectories(resolvedInstallDir, "search");
  const summaries: InstalledProviderSummary[] = [];
  for (const providerPath of providerPaths) {
    const layout = path.dirname(providerPath) === searchInstallDir ? "kind" : "legacy";
    try {
      const manifestText = await readFile(path.join(providerPath, "manifest.json"), "utf8");
      await readFile(path.join(providerPath, "provider.js"));
      const manifest = parseProviderManifest(manifestText);
      summaries.push({
        id: manifest.id,
        version: manifest.version,
        path: providerPath,
        layout,
        valid: true,
        manifest,
      });
    } catch (error) {
      summaries.push({
        id: path.basename(providerPath),
        path: providerPath,
        layout,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summaries.sort((left, right) => left.id.localeCompare(right.id));
}

function selectRegistryEntries(
  registry: LoadedRegistryManifest,
  selectedProviderIds: string[],
): RegistryEntry[] {
  if (selectedProviderIds.length === 0) {
    return registry.manifest.providers;
  }
  const wanted = new Set(selectedProviderIds);
  const matched = registry.manifest.providers.filter((entry) => wanted.has(entry.id));
  const missing = selectedProviderIds.filter((id) => !matched.some((entry) => entry.id === id));
  if (missing.length > 0) {
    throw new Error(`Provider(s) not found in registry: ${missing.join(", ")}`);
  }
  return matched;
}

export async function planRegistrySync(options: {
  registry: LoadedRegistryManifest;
  installDir: string;
  currentVersion?: string;
  selectedProviderIds?: string[];
}): Promise<RegistrySyncPlan> {
  const currentVersion = options.currentVersion ?? getSystemVersion();
  const providersRoot = path.resolve(options.installDir);
  const installDir = configuredProviderInstallDir(providersRoot, "search");
  const installed = await listInstalledProviders(providersRoot);
  const selectedEntries = selectRegistryEntries(options.registry, options.selectedProviderIds ?? []);

  const entries: RegistryPlanEntry[] = selectedEntries.map((entry) => {
    const coordinateEntry = installed.find((candidate) => path.basename(candidate.path) === entry.id);
    const installedEntry = coordinateEntry?.valid && coordinateEntry.id === entry.id
      ? coordinateEntry
      : undefined;
    const downloadRef = sanitizeUrlForDisplay(entry.downloadUrl);
    const installPath = configuredProviderTargetPath(providersRoot, "search", entry.id);
    const base = {
      id: entry.id,
      registryVersion: entry.version,
      installedVersion: installedEntry?.version,
      minRequiredVersion: entry.minPluginVersion,
      downloadRef,
      installPath,
    };
    if (entry.minPluginVersion && !semverGte(currentVersion, entry.minPluginVersion)) {
      return {
        ...base,
        action: "blocked",
        reason: `requires paper-search-cli >= ${entry.minPluginVersion}`,
      };
    }
    if (coordinateEntry?.layout === "legacy") {
      if (!installedEntry?.version) {
        return {
          ...base,
          action: "blocked",
          reason: "legacy flat provider must be migrated before registry writes",
        };
      }
      const versionCompare = semverCompare(installedEntry.version, entry.version);
      if (versionCompare < 0) {
        return {
          ...base,
          action: "blocked",
          reason: "legacy flat provider must be migrated before update",
        };
      }
      return {
        ...base,
        action: "skip",
        reason: versionCompare === 0
          ? "already up to date (legacy flat read fallback)"
          : "installed version is newer than registry (legacy flat read fallback)",
      };
    }
    if (!installedEntry?.version) {
      return {
        ...base,
        action: "install",
        reason: "not installed",
      };
    }
    const versionCompare = semverCompare(installedEntry.version, entry.version);
    if (versionCompare < 0) {
      return {
        ...base,
        action: "update",
        reason: "registry version is newer",
      };
    }
    if (versionCompare === 0) {
      return {
        ...base,
        action: "skip",
        reason: "already up to date",
      };
    }
    return {
      ...base,
      action: "skip",
      reason: "installed version is newer than registry",
    };
  });

  return {
    currentVersion,
    source: options.registry.source,
    resolvedFrom: options.registry.resolvedFrom,
    installDir,
    entries,
  };
}

export async function applyRegistrySync(options: {
  registry: LoadedRegistryManifest;
  installDir: string;
  selectedProviderIds?: string[];
  currentVersion?: string;
  runProviderMutation?: ProviderMutationRunner;
  /** Runs after the provider mutation runner has released its lock. */
  onProviderApplied?: (
    entry: RegistryApplySummary["applied"][number],
    plan: RegistrySyncPlan,
  ) => Promise<void> | void;
}): Promise<RegistryApplySummary> {
  const plan = await planRegistrySync(options);
  const selectedEntries = selectRegistryEntries(options.registry, options.selectedProviderIds ?? []);
  const registryEntryMap = new Map(selectedEntries.map((entry) => [entry.id, entry]));
  const applied: RegistryApplySummary["applied"] = [];
  const skipped: RegistryPlanEntry[] = [];

  for (const entry of [...plan.entries].sort((left, right) => left.id.localeCompare(right.id))) {
    if (entry.action !== "install" && entry.action !== "update") {
      skipped.push(entry);
      continue;
    }
    const registryEntry = registryEntryMap.get(entry.id);
    if (!registryEntry) {
      throw new Error(`Missing registry entry for ${entry.id}`);
    }
    const archive = await loadRegistryArchive(options.registry, registryEntry);
    const mutate = async () => {
      const currentPlan = await planRegistrySync({
        ...options,
        selectedProviderIds: [entry.id],
        currentVersion: plan.currentVersion,
      });
      const currentEntry = currentPlan.entries[0];
      if (!currentEntry || JSON.stringify(currentEntry) !== JSON.stringify(entry)) {
        throw new Error(`Provider registry plan became stale: ${entry.id}`);
      }
      const tempZipPath = path.join(
        os.tmpdir(),
        `paper-search-provider-${entry.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
      );
      await writeFile(tempZipPath, archive.bytes, { flag: "wx", mode: 0o600 });
      try {
        const result = await installProviderFromZipFile(tempZipPath, plan.installDir, {
          id: registryEntry.id,
          version: registryEntry.version,
          sha256: registryEntry.sha256,
          currentVersion: plan.currentVersion,
        });
        if (result.id !== entry.id || result.manifest.version !== entry.registryVersion) {
          throw new Error(`Installed provider identity differs from registry plan: ${entry.id}`);
        }
        return result;
      } finally {
        await rm(tempZipPath, { force: true });
      }
    };
    const result = options.runProviderMutation
      ? await options.runProviderMutation(entry.id, mutate)
      : await mutate();
    const appliedEntry: RegistryApplySummary["applied"][number] = {
      id: result.id,
      action: entry.action,
      installPath: result.installPath,
      version: result.manifest.version,
      archiveSha256: result.receipt.archiveSha256!,
    };
    applied.push(appliedEntry);
    await options.onProviderApplied?.(appliedEntry, plan);
  }

  return { plan, applied, skipped };
}
