import type { ResolvedConfig } from "../config/schema.js";
import type { ProviderManifest, SourceType } from "../providers/sdk/types.js";
import { listInstalledProviders, type InstalledProviderSummary } from "../providers/registry/sync.js";
import { getCanonicalToolNames } from "./toolCatalog.js";
import { getWebProviderHealth } from "../web/router.js";
import { resolveProviderAvailability } from "../providers/runtime/availability.js";

export interface PlatformStatusEntry {
  id: string;
  name: string;
  version?: string;
  sourceType: SourceType;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  missingConfigKeys: string[];
  summary?: string;
}

export interface PlatformStatusSnapshot {
  surface: "capability-first";
  providerInstallDir: string;
  availableTools: string[];
  summary: {
    installed: number;
    available: number;
    invalid: number;
    webBackends: number;
    configuredWebBackends: number;
  };
  academic: PlatformStatusEntry[];
  patent: PlatformStatusEntry[];
  web: PlatformStatusEntry[];
  invalidProviders: Array<{
    id: string;
    path: string;
    error?: string;
  }>;
}

function summarizeManifest(manifest: ProviderManifest): string | undefined {
  return manifest.help?.summaryZh || manifest.help?.summary || manifest.description;
}

function toStatusEntry(config: ResolvedConfig, provider: InstalledProviderSummary): PlatformStatusEntry {
  const manifest = provider.manifest!;
  const availability = resolveProviderAvailability(config, manifest);
  return {
    id: provider.id,
    name: manifest.name,
    version: provider.version,
    sourceType: manifest.sourceType,
    enabled: availability.enabled,
    configured: availability.configured,
    available: provider.valid && availability.available,
    missingConfigKeys: availability.missingConfigKeys,
    summary: summarizeManifest(manifest),
  };
}

function groupBySourceType(
  entries: PlatformStatusEntry[],
  sourceType: SourceType,
): PlatformStatusEntry[] {
  return entries
    .filter((entry) => entry.sourceType === sourceType)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function createPlatformStatusSnapshot(
  config: ResolvedConfig,
): Promise<PlatformStatusSnapshot> {
  const installed = await listInstalledProviders(config.providers.installDir);
  const validEntries = installed.filter((entry) => entry.valid && entry.manifest);
  const statusEntries = validEntries.map((entry) => toStatusEntry(config, entry));
  const webEntries = getWebProviderHealth(config);
  const invalidProviders = installed
    .filter((entry) => !entry.valid)
    .map((entry) => ({
      id: entry.id,
      path: entry.path,
      error: entry.error,
    }));

  return {
    surface: "capability-first",
    providerInstallDir: config.providers.installDir,
    availableTools: getCanonicalToolNames(),
    summary: {
      installed: validEntries.length,
      available: [
        ...statusEntries.filter((entry) => entry.available),
        ...webEntries.filter((entry) => entry.available),
      ].length,
      invalid: invalidProviders.length,
      webBackends: webEntries.length,
      configuredWebBackends: webEntries.filter((entry) => entry.available).length,
    },
    academic: groupBySourceType(statusEntries, "academic"),
    patent: groupBySourceType(statusEntries, "patent"),
    web: [...groupBySourceType(statusEntries, "web"), ...webEntries]
      .sort((left, right) => left.id.localeCompare(right.id)),
    invalidProviders,
  };
}
