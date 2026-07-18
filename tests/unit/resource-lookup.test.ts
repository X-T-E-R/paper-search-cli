import { describe, expect, it, vi } from "vitest";
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
    let fetchCount = 0;
    const result = await runResourceLookup(
      createConfig(),
      {
        identifier: "10.1145/3366423.3380130",
      },
      {
        now: () => new Date("2026-07-18T00:00:00.000Z"),
        fetch: async (input) => {
          fetchCount += 1;
          const url = String(input);
          return new Response(
            JSON.stringify({
              message: url.includes("filter=updates") ? {
                "total-results": 0,
                items: [],
              } : {
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
          );
        },
      },
    );

    expect(fetchCount).toBe(2);
    expect(result.identifierType).toBe("doi");
    expect(result.resolvedBy).toBe("crossref");
    expect(result.item.title).toBe("A Test-Driven Paper");
    expect(result.item.creators).toEqual([
      expect.objectContaining({ firstName: "Ada", lastName: "Lovelace" }),
    ]);
    expect(result.item.publicationTitle).toBe("Journal of Tests");
    expect(result.postPublication).toMatchObject({
      status: "clear",
      scope: "crossref-registered-updates",
      observedAt: "2026-07-18T00:00:00.000Z",
      provider: {
        id: "crossref",
        query: { filter: "updates", targetDoi: "10.1145/3366423.3380130", rows: 100 },
        resultCount: 0,
      },
      observations: [
        { signal: { eventType: "retraction" }, status: "not_found" },
        { signal: { eventType: "correction" }, status: "not_found" },
      ],
    });
  });

  it.each([
    ["retraction", "retracted"],
    ["correction", "corrected"],
  ] as const)("projects a Crossref %s update into assessment evidence", async (eventType, expectedStatus) => {
    const doi = "10.1000/original";
    const result = await runResourceLookup(
      createConfig(),
      { identifier: doi },
      {
        now: () => new Date("2026-07-18T00:00:00.000Z"),
        fetch: async (input) => {
          const url = String(input);
          return new Response(JSON.stringify({
            message: url.includes("filter=updates") ? {
              "total-results": 1,
              items: [{
                DOI: `10.1000/${eventType}-notice`,
                URL: `https://doi.org/10.1000/${eventType}-notice`,
                title: [`Registered ${eventType}`],
                "update-to": [{ DOI: doi, type: eventType, label: eventType }],
              }],
            } : {
              title: ["Original work"],
              DOI: doi,
              type: "journal-article",
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    );

    expect(result.postPublication?.status).toBe(expectedStatus);
    expect(result.postPublication?.observations).toContainEqual(expect.objectContaining({
      signal: { kind: "post_publication_event", eventType },
      status: "found",
      value: expect.objectContaining({ noticeId: `doi:10.1000/${eventType}-notice` }),
    }));
  });

  it("keeps provider failure unknown instead of manufacturing clear", async () => {
    const result = await runResourceLookup(
      createConfig(),
      { identifier: "10.1000/unknown" },
      {
        fetch: async (input) => {
          if (String(input).includes("filter=updates")) {
            return new Response("unavailable", { status: 503, statusText: "Unavailable" });
          }
          return new Response(JSON.stringify({
            message: { title: ["Original work"], DOI: "10.1000/unknown", type: "journal-article" },
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    );

    expect(result.postPublication).toMatchObject({
      status: "unknown",
      observations: [
        { status: "unavailable", diagnostics: { code: "provider_query_failed" } },
        { status: "unavailable", diagnostics: { code: "provider_query_failed" } },
      ],
    });
    expect(result.warnings).toEqual([expect.stringContaining("status remains unknown")]);
  });

  it("captures URL metadata and enriches via detected DOI when available", async () => {
    let fetchCount = 0;
    const extractUrl = vi.fn(async () => {
      throw new Error("primary success must not invoke managed extraction");
    });
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
          if (url.includes("filter=updates")) {
            return new Response(
              JSON.stringify({ message: { "total-results": 0, items: [] } }),
              { status: 200, headers: { "content-type": "application/json" } },
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
        extractUrl,
      },
    );

    expect(fetchCount).toBe(3);
    expect(extractUrl).not.toHaveBeenCalled();
    expect(result.kind).toBe("url");
    expect(result.resolvedBy).toBe("url+crossref");
    expect(result.item.title).toBe("Crossref Enriched Title");
    expect(result.item.url).toBe("https://example.com/paper");
    expect(result.metadata?.detectedDoi).toBe("10.1234/example.doi");
    expect(result.warnings).toEqual([
      expect.stringContaining("metadata only"),
    ]);
  });

  it("recovers a direct 403 through the managed exact-URL extraction provider", async () => {
    const url = "https://official.example/product/launch/";
    const extractUrl = vi.fn(async () => ({
      source: { kind: "url" as const, url },
      markdown: [
        "# Product Launch",
        "",
        "May 16, 2025",
        "",
        "Official launch details.",
      ].join("\n"),
      metadata: {
        request: { source: { kind: "url", url }, operation: "create-url-task" },
        taskId: "managed-task-1",
      },
      cacheHit: false,
      message: "Managed extraction completed.",
      provider: {
        id: "managed-html-extractor",
        name: "Managed HTML Extractor",
        version: "1.2.3",
        packagePath: "C:/providers/managed-html-extractor",
      },
      policy: "url-metadata-fallback",
    }));
    const result = await runResourceLookup(
      createConfig(),
      { url },
      {
        fetch: async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
        extractUrl,
      },
    );

    expect(extractUrl).toHaveBeenCalledWith(expect.any(Object), url);
    expect(result).toMatchObject({
      kind: "url",
      url,
      resolvedBy: "managed-html-extractor",
      item: {
        itemType: "webpage",
        title: "Product Launch",
        date: "2025-05-16",
        url,
        source: "managed-html-extractor-url-lookup",
      },
      metadata: {
        contentType: "text/markdown",
        titleSource: "provider-markdown-h1",
        publicationDateSource: "provider-markdown-top-date",
        fallback: {
          sourceUrl: url,
          provider: { id: "managed-html-extractor", version: "1.2.3" },
          policy: "url-metadata-fallback",
          primaryFailure: { status: 403, statusText: "Forbidden" },
          providerMetadata: { taskId: "managed-task-1" },
        },
      },
    });
    expect(result.warnings).toEqual([
      expect.stringContaining("HTTP 403 Forbidden"),
      expect.stringContaining("only fields explicitly established"),
    ]);
  });

  it("accepts structured exact-URL reader metadata without inferring extra fields", async () => {
    const url = "https://official.example/product/reader-launch/";
    const result = await runResourceLookup(
      createConfig(),
      { url },
      {
        fetch: async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
        extractUrl: async () => ({
          source: { kind: "url", url },
          markdown: [
            "Title: Reader Launch",
            `URL Source: ${url}`,
            "Published Time: 2025-05-16T10:00:00Z",
            "",
            "Markdown Content:",
            "Launch details without a heading.",
          ].join("\n"),
          cacheHit: false,
          provider: {
            id: "reader-provider",
            name: "Reader Provider",
            version: "1.0.0",
            packagePath: "builtin:test-reader",
          },
          policy: "url-metadata-fallback",
        }),
      },
    );

    expect(result).toMatchObject({
      resolvedBy: "reader-provider",
      item: { title: "Reader Launch", date: "2025-05-16", url },
      metadata: {
        titleSource: "provider-markdown-labeled-title",
        publicationDateSource: "provider-markdown-labeled-date",
        fallback: {
          attempts: [{ provider: "reader-provider", status: "succeeded" }],
        },
      },
    });
    expect(result.item.abstractNote).toBeUndefined();
  });

  it("keeps total URL-provider failure failed without inventing metadata or provenance", async () => {
    const url = "https://official.example/unavailable/";
    const extractUrl = vi.fn(async () => {
      throw new Error("managed provider unavailable");
    });

    await expect(runResourceLookup(
      createConfig(),
      { url },
      {
        fetch: async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
        extractUrl,
      },
    )).rejects.toThrow(
      "Direct URL metadata fetch failed (HTTP 403 Forbidden); exact-URL extraction fallbacks also failed: managed extraction provider: managed provider unavailable",
    );
    expect(extractUrl).toHaveBeenCalledTimes(1);
  });
});
