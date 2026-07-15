import { describe, expect, it } from "vitest";
import type { SearchResult } from "../../src/providers/sdk/types.js";
import { buildSearchEnvelope } from "../../src/surface/searchEnvelope.js";

function result(
  platform: string,
  overrides: Partial<SearchResult> = {},
): SearchResult {
  return {
    platform,
    query: "probe",
    totalResults: 0,
    items: [],
    page: 1,
    ...overrides,
  };
}

describe("search result envelope", () => {
  it("keeps a successful zero-result response successful", () => {
    const envelope = buildSearchEnvelope("academic_search", result("alpha"));
    expect(envelope).toMatchObject({
      ok: true,
      data: { platform: "alpha", items: [] },
      diagnostics: { sourceCounts: { alpha: 0 } },
    });
  });

  it("omits internal relevance-ordering metadata from compact output", () => {
    const envelope = buildSearchEnvelope("academic_search", result("alpha", {
      ordering: {
        requested: "relevance",
        origin: "builtin",
        scope: "provider",
        mode: "provider",
        applied: true,
        valueCount: 0,
        missingCount: 0,
        reordered: false,
      },
    }));
    expect(envelope.data).not.toHaveProperty("ordering");
    expect(envelope.diagnostics).not.toHaveProperty("ordering");
  });

  it("fails when every provider result contains an error", () => {
    const envelope = buildSearchEnvelope("academic_search", [
      result("alpha", { error: "HTTP 429" }),
      result("beta", { error: "HTTP 503" }),
    ]);
    expect(envelope).toMatchObject({
      ok: false,
      data: null,
      errors: ["HTTP 429", "HTTP 503"],
      diagnostics: { failedSources: ["alpha", "beta"] },
      provenance: { providerIds: ["alpha", "beta"] },
    });
  });

  it("reports partial failures as warnings while preserving per-source data", () => {
    const envelope = buildSearchEnvelope("academic_search", [
      result("alpha", {
        totalResults: 1,
        items: [{ itemType: "journalArticle", title: "Found" }],
      }),
      result("beta", { error: "timed out" }),
    ]);
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(["beta: timed out"]);
    expect(envelope.diagnostics?.failedSources).toEqual(["beta"]);
    expect(Array.isArray(envelope.data)).toBe(true);
  });

  it("projects per-source ordering diagnostics and warns on unverified ordering", () => {
    const envelope = buildSearchEnvelope("academic_search", [
      result("alpha", {
        totalResults: 1,
        items: [{ itemType: "journalArticle", title: "No count" }],
        ordering: {
          requested: "citations",
          origin: "search_config",
          scope: "returned_page",
          mode: "unsupported",
          applied: false,
          direction: "desc",
          valueCount: 0,
          missingCount: 1,
          reordered: false,
        },
      }),
    ]);

    expect(envelope.diagnostics?.ordering).toEqual({ alpha: "citations:unsupported" });
    expect(envelope.data).not.toHaveProperty("ordering");
    expect(envelope.warnings).toEqual([
      "alpha: citations ordering could not be verified because returned items expose no usable citationCount; provider order was preserved",
    ]);
  });
});
