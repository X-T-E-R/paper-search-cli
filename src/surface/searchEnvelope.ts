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
  const diagnostics: ResultDiagnostics = {
    sourceCounts,
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
  ];
  return okEnvelope({
    capability: "discover",
    tool,
    data,
    diagnostics,
    ...(warnings.length > 0 ? { warnings } : {}),
    provenance,
  });
}
