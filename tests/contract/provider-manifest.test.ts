import { describe, expect, it } from "vitest";
import { ManifestValidationError, parseProviderManifest } from "../../src/providers/manifest/validate.js";

describe("parseProviderManifest", () => {
  it("accepts a valid academic provider manifest", () => {
    const manifest = parseProviderManifest(
      JSON.stringify({
        id: "crossref",
        name: "Crossref",
        version: "1.0.0",
        sourceType: "academic",
        permissions: {
          urls: ["https://api.crossref.org/*"],
        },
        configSchema: {
          enabled: { type: "boolean", default: true },
          apiKey: { type: "string", required: true, secret: true },
        },
      }),
    );

    expect(manifest.id).toBe("crossref");
    expect(manifest.permissions.urls).toEqual(["https://api.crossref.org/*"]);
    expect(manifest.configSchema?.apiKey).toMatchObject({ required: true, secret: true });
  });

  it("parses source and view inventory without counting aliases as providers", () => {
    const source = parseProviderManifest(
      JSON.stringify({
        id: "crossref",
        name: "Crossref",
        version: "1.0.0",
        sourceType: "academic",
        permissions: { urls: ["https://api.crossref.org/*"] },
        inventory: {
          schemaVersion: 1,
          id: "crossref",
          kind: "search",
          sourceType: "academic",
          entryKind: "source",
          sourceId: "org.crossref.works",
          aliases: ["cross_ref"],
          serviceFamily: "org.crossref.api",
          transport: "api",
          domains: ["multidisciplinary"],
          contentKinds: ["journal-article"],
          access: ["public"],
          selection: { defaultInAll: true },
          publication: { status: "published" },
        },
      }),
    );
    const view = parseProviderManifest(
      JSON.stringify({
        id: "acm",
        name: "ACM",
        version: "1.0.0",
        sourceType: "academic",
        permissions: { urls: ["https://api.crossref.org/*"] },
        inventory: {
          schemaVersion: 1,
          id: "acm",
          kind: "search",
          sourceType: "academic",
          entryKind: "view",
          backingSourceIds: ["org.crossref.works"],
          serviceFamily: "org.crossref.api",
          transport: "api",
          domains: ["computer-science"],
          contentKinds: ["conference-paper"],
          access: ["public"],
          selection: { defaultInAll: false },
          publication: { status: "published" },
        },
      }),
    );

    expect(source.inventory?.sourceId).toBe("org.crossref.works");
    expect(view.inventory?.backingSourceIds).toEqual(["org.crossref.works"]);
  });

  it("rejects inventory classification drift and views included in all", () => {
    const base = {
      id: "acm",
      name: "ACM",
      version: "1.0.0",
      sourceType: "academic",
      permissions: { urls: ["https://api.crossref.org/*"] },
      inventory: {
        schemaVersion: 1,
        id: "acm",
        kind: "search",
        sourceType: "patent",
        entryKind: "view",
        backingSourceIds: ["org.crossref.works"],
        serviceFamily: "org.crossref.api",
        transport: "api",
        domains: ["computer-science"],
        contentKinds: ["conference-paper"],
        access: ["public"],
        selection: { defaultInAll: true },
        publication: { status: "published" },
      },
    };
    expect(() => parseProviderManifest(JSON.stringify(base))).toThrow(/sourceType/);
    base.inventory.sourceType = "academic";
    expect(() => parseProviderManifest(JSON.stringify(base))).toThrow(
      /legacy selection\.defaultInAll/,
    );
  });

  it("rejects invalid provider IDs", () => {
    expect(() =>
      parseProviderManifest(
        JSON.stringify({
          id: "Bad Id",
          name: "Broken",
          version: "1.0.0",
          sourceType: "academic",
          permissions: {
            urls: ["https://example.com/*"],
          },
        }),
      ),
    ).toThrow(ManifestValidationError);
  });

  it("validates optional citation graph capability without requiring it", () => {
    const parsed = parseProviderManifest(
      JSON.stringify({
        id: "semantic",
        name: "Semantic Scholar",
        version: "1.2.0",
        sourceType: "academic",
        permissions: { urls: ["https://api.semanticscholar.org/*"] },
        capabilities: {
          citationGraph: {
            directions: ["backward", "forward"],
            targetIdentifierKinds: ["semantic", "doi", "arxiv"],
            maxPageSize: 100,
          },
        },
      }),
    );

    expect(parsed.capabilities?.citationGraph).toEqual({
      directions: ["backward", "forward"],
      targetIdentifierKinds: ["semantic", "doi", "arxiv"],
      maxPageSize: 100,
    });
  });

  it("rejects malformed citation graph promises", () => {
    const base = {
      id: "semantic",
      name: "Semantic Scholar",
      version: "1.2.0",
      sourceType: "academic",
      permissions: { urls: ["https://api.semanticscholar.org/*"] },
    };
    expect(() =>
      parseProviderManifest(
        JSON.stringify({
          ...base,
          capabilities: {
            citationGraph: {
              directions: ["backward", "backward"],
              targetIdentifierKinds: ["title"],
              maxPageSize: 0,
            },
          },
        }),
      ),
    ).toThrow(/directions/);
    expect(() =>
      parseProviderManifest(
        JSON.stringify({
          ...base,
          capabilities: {
            citationGraph: {
              directions: ["backward"],
              targetIdentifierKinds: ["doi"],
              maxPageSize: 1001,
            },
          },
        }),
      ),
    ).toThrow(/1 to 1000/);
  });
});
