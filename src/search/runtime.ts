import type { ResolvedConfig } from "../config/schema.js";
import { loadProviderPackage } from "../providers/package/load.js";
import { resolveProviderPackageDirectory } from "../providers/paths.js";
import { listInstalledProviders, type InstalledProviderSummary } from "../providers/registry/sync.js";
import { createNodeCompatibilityApi } from "../providers/runtime/createApi.js";
import { invokeProviderFactoryInNode, type LoadedNodeProvider } from "../providers/runtime/invokeNodeFactory.js";
import type {
  ProviderManifest,
  ResourceItem,
  SearchOptions,
  SearchResult,
  SearchResultOrdering,
  SourceType,
} from "../providers/sdk/types.js";
import {
  getProviderConfig,
  resolveProviderAvailability,
} from "../providers/runtime/availability.js";
import {
  resolveExplicitProvider,
  resolveProviderSelection,
  type ProviderSelectionPlan,
  type ProviderSelectionRequest,
} from "./selection.js";
import { listProviderSelectionCandidates } from "./candidates.js";

export interface ProviderSearchRequest extends SearchOptions, ProviderSelectionRequest {
  query: string;
}

function flattenNestedRecord(prefix: string, value: unknown, target: Record<string, unknown>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    target[prefix] = value;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    flattenNestedRecord(`${prefix}.${key}`, child, target);
  }
}

export function buildGlobalPrefs(
  config: ResolvedConfig,
  allowedKeys: readonly string[] = [],
): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config.api)) {
    flattenNestedRecord(`api.${key}`, value, flattened);
  }
  const allowed = new Set(allowedKeys);
  return Object.fromEntries(
    Object.entries(flattened).filter(([key]) => allowed.has(key)),
  );
}

export function isProviderEnabled(
  config: ResolvedConfig,
  providerId: string,
  manifest?: ProviderManifest,
): boolean {
  return manifest
    ? resolveProviderAvailability(config, manifest).enabled
    : getProviderConfig(config, providerId).enabled !== false;
}

function readConfiguredNumber(providerConfig: Record<string, unknown>, key: string): number | undefined {
  const value = providerConfig[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readConfiguredSort(
  providerConfig: Record<string, unknown>,
  sourceType: SourceType,
): SearchOptions["sortBy"] | undefined {
  const value = providerConfig.defaultSort;
  if (value === "relevance" || value === "date") return value;
  return sourceType === "academic" && value === "citations" ? value : undefined;
}

interface ResolvedSearchSort {
  value: NonNullable<SearchOptions["sortBy"]>;
  origin: SearchResultOrdering["origin"];
}

function resolveSearchSort(
  config: ResolvedConfig,
  manifest: ProviderManifest,
  request: ProviderSearchRequest,
): ResolvedSearchSort {
  if (request.sortBy) return { value: request.sortBy, origin: "request" };
  const configured = readConfiguredSort(getProviderConfig(config, manifest.id), manifest.sourceType);
  if (configured) return { value: configured, origin: "provider_config" };
  const searchDefault = manifest.sourceType === "academic"
    ? config.search.defaultAcademicSort
    : manifest.sourceType === "patent"
      ? config.search.defaultPatentSort
      : undefined;
  if (searchDefault) return { value: searchDefault, origin: "search_config" };
  return { value: "relevance", origin: "builtin" };
}

function citationValue(item: ResourceItem): number | undefined {
  return typeof item.citationCount === "number" && Number.isFinite(item.citationCount) && item.citationCount >= 0
    ? item.citationCount
    : undefined;
}

function dateValue(item: ResourceItem): number | undefined {
  if (typeof item.date !== "string" || item.date.trim() === "") return undefined;
  const parsed = Date.parse(item.date);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function applyReturnedPageOrdering(
  result: SearchResult,
  resolved: ResolvedSearchSort,
): SearchResult {
  if (resolved.value === "relevance") {
    return {
      ...result,
      ordering: {
        requested: resolved.value,
        origin: resolved.origin,
        scope: "provider",
        mode: "provider",
        applied: true,
        valueCount: result.items.length,
        missingCount: 0,
        reordered: false,
      },
    };
  }

  const readValue = resolved.value === "citations" ? citationValue : dateValue;
  const indexed = result.items.map((item, index) => ({ item, index, value: readValue(item) }));
  const valueCount = indexed.filter((entry) => entry.value !== undefined).length;
  if (result.items.length > 0 && valueCount === 0) {
    return {
      ...result,
      ordering: {
        requested: resolved.value,
        origin: resolved.origin,
        scope: "returned_page",
        mode: "unsupported",
        applied: false,
        direction: "desc",
        valueCount: 0,
        missingCount: result.items.length,
        reordered: false,
      },
    };
  }

  const sorted = [...indexed].sort((left, right) => {
    if (left.value !== undefined && right.value !== undefined) {
      return right.value - left.value || left.index - right.index;
    }
    if (left.value !== undefined) return -1;
    if (right.value !== undefined) return 1;
    return left.index - right.index;
  });
  const reordered = sorted.some((entry, index) => entry.index !== index);
  return {
    ...result,
    items: sorted.map((entry) => entry.item),
    ordering: {
      requested: resolved.value,
      origin: resolved.origin,
      scope: "returned_page",
      mode: "post_page",
      applied: true,
      direction: "desc",
      valueCount,
      missingCount: result.items.length - valueCount,
      reordered,
    },
  };
}

function clampPositive(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

export function resolveScopedMaxResults(options: {
  requested?: number;
  configured?: number;
  fallback: number;
  limit?: number;
}): number {
  const { requested, configured, fallback, limit } = options;
  const sourceMaximum = limit && limit > 0 ? limit : undefined;

  let effective: number;
  if (requested === -1) {
    effective = sourceMaximum ?? clampPositive(configured ?? fallback, fallback);
  } else if (requested === 0 || requested === undefined) {
    effective = clampPositive(configured ?? fallback, fallback);
  } else {
    effective = clampPositive(requested, fallback);
  }

  if (sourceMaximum) {
    return Math.min(effective, sourceMaximum);
  }
  return effective;
}

export function resolveSearchOptions(
  config: ResolvedConfig,
  manifest: ProviderManifest,
  request: ProviderSearchRequest,
): SearchOptions {
  const providerConfig = getProviderConfig(config, manifest.id);
  const defaultMaxResults = clampPositive(config.defaults.maxResults, 10);
  const sort = resolveSearchSort(config, manifest, request);
  return {
    maxResults: resolveScopedMaxResults({
      requested: request.maxResults,
      configured: readConfiguredNumber(providerConfig, "maxResults"),
      fallback: defaultMaxResults,
      limit: manifest.maxResultsLimit,
    }),
    page: request.page && request.page > 0 ? Math.floor(request.page) : 1,
    year: request.year,
    author: request.author,
    sortBy: sort.value,
    extra: request.extra,
  };
}

export async function loadProviderRuntimeFromSummary(
  config: ResolvedConfig,
  provider: InstalledProviderSummary,
): Promise<LoadedNodeProvider> {
  const providerPath = await resolveProviderPackageDirectory(
    config.providers.installDir,
    "search",
    provider.id,
  );
  const providerPackage = await loadProviderPackage(providerPath);
  return invokeProviderFactoryInNode(
    providerPackage.bundleCode,
    providerPackage.manifest,
    createNodeCompatibilityApi({
      manifest: providerPackage.manifest,
      providerConfig: getProviderConfig(config, provider.id),
      globalPrefs: buildGlobalPrefs(config, providerPackage.manifest.allowedGlobalPrefs),
    }),
  );
}

function toProviderErrorResult(
  request: ProviderSearchRequest,
  providerId: string,
  error: unknown,
): SearchResult {
  return {
    platform: providerId,
    query: request.query,
    totalResults: 0,
    items: [],
    page: request.page ?? 1,
    error: error instanceof Error ? error.message : String(error),
  };
}

function toSkippedProviderResult(
  request: ProviderSearchRequest,
  providerId: string,
  reasons: readonly string[],
): SearchResult {
  return {
    platform: providerId,
    query: request.query,
    totalResults: 0,
    items: [],
    page: request.page ?? 1,
    skipped: true,
    error: reasons.length > 0 ? reasons.join("; ") : "provider is not runnable",
  };
}

export async function getInstalledProvidersByType(
  config: ResolvedConfig,
  sourceType: SourceType,
): Promise<InstalledProviderSummary[]> {
  const installed = await listInstalledProviders(config.providers.installDir);
  return installed.filter(
    (entry) =>
      entry.valid &&
      entry.manifest?.sourceType === sourceType &&
      resolveProviderAvailability(config, entry.manifest!).available,
  );
}

export async function runProviderSearch(
  config: ResolvedConfig,
  sourceType: SourceType,
  request: ProviderSearchRequest,
): Promise<SearchResult | SearchResult[]> {
  const selectionCandidates = await listProviderSelectionCandidates(config);
  const providers = selectionCandidates.installed;
  let plan: ProviderSelectionPlan;
  try {
    plan = resolveProviderSelection(config, sourceType, selectionCandidates.candidates, request);
    plan.warnings = [...new Set([...selectionCandidates.warnings, ...plan.warnings])]
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    return {
      platform: request.platform ?? request.provider ?? request.sources?.[0] ?? "default",
      query: request.query,
      totalResults: 0,
      items: [],
      page: request.page ?? 1,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const selectedEntries = plan.entries.filter((entry) => entry.selected);
  if (selectedEntries.length === 0) {
    const selectionLabel = plan.usedDefaults
      ? `default presets (${plan.defaultPresets.join(", ") || "none"})`
      : "requested selectors";
    return {
      platform: plan.usedDefaults ? "default" : request.platform ?? "selection",
      query: request.query,
      totalResults: 0,
      items: [],
      page: request.page ?? 1,
      error: `No installed ${sourceType} providers match ${selectionLabel}`,
    };
  }

  const providersById = new Map(providers.map((provider) => [provider.id, provider]));

  const runSingle = async (provider: InstalledProviderSummary): Promise<SearchResult> => {
    const runtime = await loadProviderRuntimeFromSummary(config, provider);
    const manifest = provider.manifest!;
    const options = resolveSearchOptions(config, manifest, request);
    const result = await runtime.provider.search(request.query, options);
    return applyReturnedPageOrdering(result, resolveSearchSort(config, manifest, request));
  };

  const settled = await Promise.allSettled(
    selectedEntries.map(async (entry): Promise<SearchResult> => {
      if (!entry.runnable) {
        return toSkippedProviderResult(request, entry.id, entry.readinessReasons);
      }
      const provider = providersById.get(entry.id);
      if (!provider) {
        return toSkippedProviderResult(request, entry.id, ["provider package is not installed"]);
      }
      return runSingle(provider);
    }),
  );
  const results = settled.map((result, index) => {
    const entry = selectedEntries[index]!;
    return result.status === "fulfilled"
      ? result.value
      : toProviderErrorResult(request, entry.id, result.reason);
  });
  return results.length === 1 ? results[0]! : results;
}

export async function createProviderSelectionPlan(
  config: ResolvedConfig,
  sourceType: SourceType,
  request: ProviderSelectionRequest = {},
): Promise<ProviderSelectionPlan> {
  const selectionCandidates = await listProviderSelectionCandidates(config);
  const plan = resolveProviderSelection(
    config,
    sourceType,
    selectionCandidates.candidates,
    request,
  );
  plan.warnings = [...new Set([...selectionCandidates.warnings, ...plan.warnings])]
    .sort((left, right) => left.localeCompare(right));
  return plan;
}

export async function loadInstalledProviderRuntime(
  config: ResolvedConfig,
  providerId: string,
  sourceType: SourceType,
): Promise<{
  provider: InstalledProviderSummary;
  runtime: LoadedNodeProvider;
}> {
  const providers = await getInstalledProvidersByType(config, sourceType);
  const provider = resolveExplicitProvider(providers, providerId);
  if (!provider) {
    throw new Error(`${sourceType} provider not installed, disabled, or unconfigured: ${providerId}`);
  }
  return {
    provider,
    runtime: await loadProviderRuntimeFromSummary(config, provider),
  };
}
