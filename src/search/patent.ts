import type { ResolvedConfig } from "../config/schema.js";
import type { PatentDetailResult, SearchOptions, SearchResult } from "../providers/sdk/types.js";
import { loadInstalledProviderRuntime, runProviderSearch, type ProviderSearchRequest } from "./runtime.js";

export interface PatentSearchRequest extends SearchOptions {
  query: string;
  platform?: string;
  patentType?: string;
  legalStatus?: string;
  database?: string;
  sortField?: string;
  sortOrder?: string;
  queryMode?: string;
  rawQuery?: string;
}

export interface PatentDetailRequest {
  platform: string;
  sourceId: string;
  include?: string[];
}

function normalizePatentExtra(
  request: PatentSearchRequest,
): Record<string, unknown> | undefined {
  const extra = {
    ...(request.extra ?? {}),
    patentType: request.patentType,
    legalStatus: request.legalStatus,
    database: request.database,
    sortField: request.sortField,
    sortOrder: request.sortOrder,
    queryMode: request.queryMode,
    rawQuery:
      request.rawQuery ??
      (request.queryMode === "expert" ? request.query : undefined),
  };
  const cleaned = Object.fromEntries(
    Object.entries(extra).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export async function runPatentSearch(
  config: ResolvedConfig,
  request: PatentSearchRequest,
): Promise<SearchResult | SearchResult[]> {
  const normalized: ProviderSearchRequest = {
    query: request.query,
    platform: request.platform,
    maxResults: request.maxResults,
    page: request.page,
    sortBy: request.sortBy,
    extra: normalizePatentExtra(request),
  };
  return runProviderSearch(config, "patent", normalized);
}

export async function runPatentDetail(
  config: ResolvedConfig,
  request: PatentDetailRequest,
): Promise<PatentDetailResult> {
  const { provider, runtime } = await loadInstalledProviderRuntime(
    config,
    request.platform,
    "patent",
  );
  if (typeof runtime.provider.getDetail !== "function") {
    throw new Error(`Patent provider does not support detail lookup: ${provider.id}`);
  }
  return runtime.provider.getDetail(request.sourceId, {
    include: request.include,
  });
}
