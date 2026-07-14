import type { ResolvedConfig } from "../config/schema.js";
import { loadProviderPackage } from "../providers/package/load.js";
import { resolveProviderPackageDirectory } from "../providers/paths.js";
import { listInstalledProviders, type InstalledProviderSummary } from "../providers/registry/sync.js";
import { createNodeCompatibilityApi } from "../providers/runtime/createApi.js";
import { invokeProviderFactoryInNode, type LoadedNodeProvider } from "../providers/runtime/invokeNodeFactory.js";
import type {
  ProviderManifest,
  SearchOptions,
  SearchResult,
  SourceType,
} from "../providers/sdk/types.js";
import {
  getProviderConfig,
  resolveProviderAvailability,
} from "../providers/runtime/availability.js";

export interface ProviderSearchRequest extends SearchOptions {
  query: string;
  platform?: string;
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
): SearchOptions["sortBy"] | undefined {
  const value = providerConfig.defaultSort;
  return value === "relevance" || value === "date" || value === "citations" ? value : undefined;
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
    sortBy: request.sortBy ?? readConfiguredSort(providerConfig) ?? "relevance",
    extra: request.extra,
  };
}

async function loadRuntimeProvider(
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
  const providers = await getInstalledProvidersByType(config, sourceType);
  if (providers.length === 0) {
    return [
      {
        platform: request.platform ?? "all",
        query: request.query,
        totalResults: 0,
        items: [],
        page: request.page ?? 1,
        error: `No enabled ${sourceType} providers are installed`,
      },
    ];
  }

  const requestedPlatform = request.platform ?? "all";
  const selected =
    requestedPlatform === "all"
      ? providers
      : providers.filter((entry) => entry.id === requestedPlatform);

  if (selected.length === 0) {
    return {
      platform: requestedPlatform,
      query: request.query,
      totalResults: 0,
      items: [],
      page: request.page ?? 1,
      error: `${sourceType} provider not installed, disabled, or unconfigured: ${requestedPlatform}`,
    };
  }

  const runSingle = async (provider: InstalledProviderSummary): Promise<SearchResult> => {
    const runtime = await loadRuntimeProvider(config, provider);
    return runtime.provider.search(
      request.query,
      resolveSearchOptions(config, provider.manifest!, request),
    );
  };

  if (selected.length === 1) {
    try {
      return await runSingle(selected[0]!);
    } catch (error) {
      return toProviderErrorResult(request, selected[0]!.id, error);
    }
  }

  const settled = await Promise.allSettled(selected.map((provider) => runSingle(provider)));
  return settled.map((result, index) => {
    const provider = selected[index]!;
    return result.status === "fulfilled"
      ? result.value
      : toProviderErrorResult(request, provider.id, result.reason);
  });
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
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`${sourceType} provider not installed, disabled, or unconfigured: ${providerId}`);
  }
  return {
    provider,
    runtime: await loadRuntimeProvider(config, provider),
  };
}
