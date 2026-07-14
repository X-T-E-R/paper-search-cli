import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import {
  detectIdentifierType,
  runResourceLookup,
} from "../../src/lookup/resource.js";

function createConfig(): ResolvedConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    meta: {
      cwd: process.cwd(),
      userConfigPath: "user-config.toml",
      projectConfigPath: null,
      explicitConfigPath: null,
      loadedFiles: [],
      appliedEnvOverrides: [],
    },
  };
}

describe("resource lookup", () => {
  it("detects common identifier types", () => {
    expect(detectIdentifierType("10.1145/3366423.3380130")).toBe("doi");
    expect(detectIdentifierType("12345678")).toBe("pmid");
    expect(detectIdentifierType("arXiv:2401.01234")).toBe("arxiv");
    expect(detectIdentifierType("9780262046305")).toBe("isbn");
  });

  it("resolves DOI metadata through Crossref", async () => {
    const result = await runResourceLookup(
      createConfig(),
      {
        identifier: "10.1145/3366423.3380130",
      },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              message: {
                title: ["A Test-Driven Paper"],
                author: [{ given: "Ada", family: "Lovelace" }],
                DOI: "10.1145/3366423.3380130",
                URL: "https://doi.org/10.1145/3366423.3380130",
                type: "journal-article",
                issued: { "date-parts": [[2024, 5, 9]] },
                "container-title": ["Journal of Tests"],
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      },
    );

    expect(result.identifierType).toBe("doi");
    expect(result.resolvedBy).toBe("crossref");
    expect(result.item.title).toBe("A Test-Driven Paper");
    expect(result.item.creators).toEqual([
      expect.objectContaining({ firstName: "Ada", lastName: "Lovelace" }),
    ]);
    expect(result.item.publicationTitle).toBe("Journal of Tests");
  });

  it("captures URL metadata and enriches via detected DOI when available", async () => {
    let fetchCount = 0;
    const result = await runResourceLookup(
      createConfig(),
      {
        url: "https://example.com/paper",
        formats: ["markdown"],
        provider: "auto",
      },
      {
        fetch: async (input) => {
          fetchCount += 1;
          const url = String(input);
          if (url === "https://example.com/paper") {
            return new Response(
              [
                "<html><head>",
                '<meta name="citation_title" content="Page Title" />',
                '<meta name="citation_doi" content="10.1234/example.doi" />',
                '<meta name="description" content="Captured from the page." />',
                "</head><body></body></html>",
              ].join(""),
              {
                status: 200,
                headers: { "content-type": "text/html; charset=utf-8" },
              },
            );
          }
          return new Response(
            JSON.stringify({
              message: {
                title: ["Crossref Enriched Title"],
                DOI: "10.1234/example.doi",
                type: "journal-article",
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
      },
    );

    expect(fetchCount).toBe(2);
    expect(result.kind).toBe("url");
    expect(result.resolvedBy).toBe("url+crossref");
    expect(result.item.title).toBe("Crossref Enriched Title");
    expect(result.item.url).toBe("https://example.com/paper");
    expect(result.metadata?.detectedDoi).toBe("10.1234/example.doi");
    expect(result.warnings).toEqual([
      expect.stringContaining("metadata only"),
    ]);
  });
});
