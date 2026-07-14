import { describe, expect, it } from "vitest";
import {
  MaterialResolverResultValidationError,
  parseMaterialResolverResult,
  validateMaterialIdentifierInput,
} from "../../src/material/resolverResult.js";

function resolverResult(overrides: Record<string, unknown> = {}): unknown {
  return {
    identifier: { scheme: "doi", value: "10.1038/s41586-021-03828-1" },
    candidates: [
      {
        url: "https://europepmc.org/articles/pmc0000000?pdf=render",
        license: "cc-by",
        version: "publishedVersion",
        host: "repository",
        contentType: "application/pdf",
      },
      {
        url: "https://doi.org/10.1038/s41586-021-03828-1",
        host: "publisher",
        note: "landing page",
      },
    ],
    provenance: {
      providerId: "unpaywall",
      source: "unpaywall",
      retrievedAt: "2026-07-08T12:00:00.000Z",
    },
    ...overrides,
  };
}

describe("parseMaterialResolverResult", () => {
  it("accepts a valid resolver result and keeps candidate order", () => {
    const parsed = parseMaterialResolverResult(resolverResult());
    expect(parsed.identifier).toEqual({ scheme: "doi", value: "10.1038/s41586-021-03828-1" });
    expect(parsed.candidates.map((candidate) => candidate.host)).toEqual([
      "repository",
      "publisher",
    ]);
    expect(parsed.provenance.providerId).toBe("unpaywall");
    expect(parsed.provenance.retrievedAt).toBe("2026-07-08T12:00:00.000Z");
  });

  it("accepts an empty candidate list for a known identifier without open locations", () => {
    const parsed = parseMaterialResolverResult(resolverResult({ candidates: [] }));
    expect(parsed.candidates).toEqual([]);
  });

  it("trims the identifier value", () => {
    const parsed = parseMaterialResolverResult(
      resolverResult({ identifier: { scheme: "doi", value: "  10.1000/xyz123  " } }),
    );
    expect(parsed.identifier.value).toBe("10.1000/xyz123");
  });

  it("rejects a non-object result", () => {
    expect(() => parseMaterialResolverResult("nope")).toThrow(
      MaterialResolverResultValidationError,
    );
  });

  it("rejects an unknown identifier scheme", () => {
    expect(() =>
      parseMaterialResolverResult(resolverResult({ identifier: { scheme: "pmid", value: "123" } })),
    ).toThrow(/identifier.scheme must be one of: doi/);
  });

  it("rejects a malformed DOI value", () => {
    expect(() =>
      parseMaterialResolverResult(
        resolverResult({ identifier: { scheme: "doi", value: "not-a-doi" } }),
      ),
    ).toThrow(/is not a valid DOI/);
  });

  it("rejects candidates without an http(s) url", () => {
    expect(() =>
      parseMaterialResolverResult(resolverResult({ candidates: [{ url: "ftp://example.org/a" }] })),
    ).toThrow(/candidates\[0\].url must be an http\(s\) URL/);
  });

  it("rejects a missing candidates array", () => {
    expect(() => parseMaterialResolverResult(resolverResult({ candidates: undefined }))).toThrow(
      /candidates must be an array/,
    );
  });

  it("rejects provenance without a provider id", () => {
    expect(() =>
      parseMaterialResolverResult(resolverResult({ provenance: { source: "unpaywall" } })),
    ).toThrow(/provenance.providerId must be a material provider id/);
  });

  it("rejects a non-ISO retrievedAt", () => {
    expect(() =>
      parseMaterialResolverResult(
        resolverResult({ provenance: { providerId: "unpaywall", retrievedAt: "yesterday" } }),
      ),
    ).toThrow(/retrievedAt must be an ISO date-time string/);
  });
});

describe("validateMaterialIdentifierInput", () => {
  it("accepts a DOI identifier", () => {
    expect(validateMaterialIdentifierInput({ scheme: "doi", value: "10.1145/3366423.3380130" }))
      .toEqual({ scheme: "doi", value: "10.1145/3366423.3380130" });
  });

  it("rejects an empty identifier value", () => {
    expect(() => validateMaterialIdentifierInput({ scheme: "doi", value: "  " })).toThrow(
      MaterialResolverResultValidationError,
    );
  });
});
