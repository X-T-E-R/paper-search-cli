import type { SearchResult } from "../providers/sdk/types.js";
import {
  failEnvelope,
  okEnvelope,
  type ResultDiagnostics,
  type ResultEnvelope,
} from "./resultEnvelope.js";

export function buildSearchEnvelope(
  tool: "academic_search" | "patent_search",
  data: SearchResult | SearchResult[],
): ResultEnvelope<SearchResult | SearchResult[] | null> {
  const results = Array.isArray(data) ? data : [data];
  const publicResults = results.map(({ ordering: _ordering, ...result }) => result);
  const publicData = Array.isArray(data) ? publicResults : publicResults[0]!;
  const skipped = results.filter((entry) => entry.skipped === true);
  const failed = results.filter((entry) => Boolean(entry.error) && entry.skipped !== true);
  const succeeded = results.filter((entry) => !entry.error);
  const sourceCounts = Object.fromEntries(
    results.map((entry) => [entry.platform, entry.items.length]),
  );
  const failedSources = failed.map((entry) => entry.platform);
  const skippedSources = skipped.map((entry) => entry.platform);
  const elapsedValues = results
    .map((entry) => entry.elapsed)
    .filter(
      (entry): entry is number =>
        typeof entry === "number" && Number.isFinite(entry),
    );
  const ordering = Object.fromEntries(
    results.flatMap((entry) => entry.ordering && entry.ordering.requested !== "relevance"
      ? [[entry.platform, `${entry.ordering.requested}:${entry.ordering.mode === "post_page" ? "page-desc" : entry.ordering.mode}`]]
      : []),
  );
  const diagnostics: ResultDiagnostics = {
    sourceCounts,
    ...(Object.keys(ordering).length > 0 ? { ordering } : {}),
    ...(failedSources.length > 0 ? { failedSources } : {}),
    ...(skippedSources.length > 0 ? { skippedSources } : {}),
    ...(elapsedValues.length > 0
      ? { elapsedMs: Math.max(...elapsedValues) }
      : {}),
  };
  const provenance = { providerIds: results.map((entry) => entry.platform) };

  if (results.length === 0 || succeeded.length === 0) {
    const errors = [...failed, ...skipped]
      .map((entry) => entry.error?.trim())
      .filter((entry): entry is string => Boolean(entry));
    return failEnvelope({
      capability: "discover",
      tool,
      errors:
        errors.length > 0
          ? [...new Set(errors)]
          : ["Search did not produce a successful provider result"],
      diagnostics,
      provenance,
    });
  }

  const warnings = [
    ...failed.map((entry) => `${entry.platform}: ${entry.error ?? "provider failed"}`),
    ...skipped.map((entry) => `${entry.platform}: skipped (${entry.error ?? "not runnable"})`),
    ...results
      .filter((entry) => entry.ordering?.mode === "unsupported")
      .map((entry) =>
        `${entry.platform}: ${entry.ordering!.requested} ordering could not be verified because returned items expose no usable ${entry.ordering!.requested === "citations" ? "citationCount" : "date"}; provider order was preserved`,
      ),
  ];
  return okEnvelope({
    capability: "discover",
    tool,
    data: publicData,
    diagnostics,
    ...(warnings.length > 0 ? { warnings } : {}),
    provenance,
  });
}
