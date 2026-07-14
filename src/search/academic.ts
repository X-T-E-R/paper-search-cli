import type { ResolvedConfig } from "../config/schema.js";
import type { SearchOptions, SearchResult } from "../providers/sdk/types.js";
import { runProviderSearch } from "./runtime.js";

export interface AcademicSearchRequest extends SearchOptions {
  query: string;
  platform?: string;
}

export async function runAcademicSearch(
  config: ResolvedConfig,
  request: AcademicSearchRequest,
): Promise<SearchResult | SearchResult[]> {
  return runProviderSearch(config, "academic", request);
}
