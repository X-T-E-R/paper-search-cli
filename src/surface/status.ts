import type { ResolvedConfig } from "../config/schema.js";
import type { ProviderManifest, SourceType } from "../providers/sdk/types.js";
import type { InstalledProviderSummary } from "../providers/registry/sync.js";
import { getCanonicalToolNames } from "./toolCatalog.js";
import { getWebProviderHealth } from "../web/router.js";
import { resolveProviderAvailability } from "../providers/runtime/availability.js";
import {
  resolveProviderSelection,
  type ProviderSelectionPlan,
} from "../search/selection.js";
import { listProviderSelectionCandidates } from "../search/candidates.js";

export interface PlatformStatusEntry {
  id: string;
  name: string;
  version?: string;
  sourceType: SourceType;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  runnable: boolean;
  includedInAll: boolean;
  includedInDefault: boolean;
  defaultPresets: string[];
  defaultSelectionReasons: string[];
  selectionReason: string;
  entryKind: "source" | "view";
  aliases: string[];
  domains: string[];
  contentKinds: string[];
  access: string[];
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

function toStatusEntry(
  config: ResolvedConfig,
  provider: InstalledProviderSummary,
  defaultPlan: ProviderSelectionPlan,
  allPlan: ProviderSelectionPlan,
): PlatformStatusEntry {
  const manifest = provider.manifest!;
  const availability = resolveProviderAvailability(config, manifest);
  const runnable = provider.valid && availability.available;
  const inventory = manifest.inventory;
  const defaultEntry = defaultPlan.entries.find((entry) => entry.id === provider.id);
  const allEntry = allPlan.entries.find((entry) => entry.id === provider.id);
  const includedInDefault = defaultEntry?.selected ?? false;
  const defaultSelectionReasons = defaultEntry?.selectionReasons ?? [];
  return {
    id: provider.id,
    name: manifest.name,
    version: provider.version,
    sourceType: manifest.sourceType,
    enabled: availability.enabled,
    configured: availability.configured,
    available: runnable,
    runnable,
    includedInAll: allEntry?.runnable ?? false,
    includedInDefault,
    defaultPresets: defaultPlan.defaultPresets,
    defaultSelectionReasons,
    selectionReason: !availability.enabled
      ? "provider disabled"
      : !availability.configured
        ? `missing required config: ${availability.missingConfigKeys.join(", ")}`
        : includedInDefault
          ? defaultSelectionReasons.join("; ") || "selected by command defaults"
          : "not selected by command defaults",
    entryKind: inventory?.entryKind ?? "source",
    aliases: inventory?.aliases ?? [],
    domains: inventory?.domains ?? [],
    contentKinds: inventory?.contentKinds ?? [],
    access: inventory?.access ?? [],
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
  const selectionCandidates = await listProviderSelectionCandidates(config);
  const installed = selectionCandidates.installed;
  const candidates = selectionCandidates.candidates;
  const validEntries = installed.filter((entry) => entry.valid && entry.manifest);
  const academicDefault = resolveProviderSelection(config, "academic", candidates);
  const academicAll = resolveProviderSelection(config, "academic", candidates, { platform: "all" });
  const patentDefault = resolveProviderSelection(config, "patent", candidates);
  const patentAll = resolveProviderSelection(config, "patent", candidates, { platform: "all" });
  const webDefault = resolveProviderSelection(config, "web", candidates);
  const webAll = resolveProviderSelection(config, "web", candidates, { platform: "all" });
  const plansBySourceType: Record<SourceType, {
    defaultPlan: ProviderSelectionPlan;
    allPlan: ProviderSelectionPlan;
  }> = {
    academic: { defaultPlan: academicDefault, allPlan: academicAll },
    patent: { defaultPlan: patentDefault, allPlan: patentAll },
    web: { defaultPlan: webDefault, allPlan: webAll },
  };
  const statusEntries = validEntries.map((entry) => {
    const plans = plansBySourceType[entry.manifest!.sourceType];
    return toStatusEntry(
      config,
      entry,
      plans.defaultPlan,
      plans.allPlan,
    );
  });
  const webEntries: PlatformStatusEntry[] = getWebProviderHealth(config).map((entry) => ({
    ...entry,
    runnable: entry.available,
    includedInAll: false,
    includedInDefault: false,
    defaultPresets: [],
    defaultSelectionReasons: [],
    selectionReason: "web backend is selected by web routing, not search presets",
    entryKind: "source",
    aliases: [],
    domains: [],
    contentKinds: [],
    access: [],
  }));
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
