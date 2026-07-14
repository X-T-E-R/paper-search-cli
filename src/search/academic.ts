import type { ResolvedConfig } from "../config/schema.js";
import type { SearchResult } from "../providers/sdk/types.js";
import { runProviderSearch, type ProviderSearchRequest } from "./runtime.js";

export type AcademicSearchRequest = ProviderSearchRequest;

export async function runAcademicSearch(
  config: ResolvedConfig,
  request: AcademicSearchRequest,
): Promise<SearchResult | SearchResult[]> {
  return runProviderSearch(config, "academic", request);
}
