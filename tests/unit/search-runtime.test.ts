import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import {
  applyReturnedPageOrdering,
  loadInstalledProviderRuntime,
  resolveScopedMaxResults,
  resolveSearchOptions,
  runProviderSearch,
} from "../../src/search/runtime.js";
import type { ProviderInventoryEntry, ProviderManifest } from "../../src/providers/sdk/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function createConfig(root: string): ResolvedConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    providers: {
      ...structuredClone(DEFAULT_CONFIG.providers),
      installDir: path.join(root, "providers"),
    },
    meta: {
      cwd: root,
      userConfigPath: path.join(root, "config.toml"),
      projectConfigPath: null,
      explicitConfigPath: null,
      loadedFiles: [],
      appliedEnvOverrides: [],
    },
    platform: {},
    api: {},
  };
}

async function writeSearchProvider(
  providerPath: string,
  version: string,
  platform: string,
  options: { id?: string; inventory?: ProviderInventoryEntry; configSchema?: ProviderManifest["configSchema"] } = {},
): Promise<void> {
  const id = options.id ?? "alpha";
  await mkdir(providerPath, { recursive: true });
  await writeFile(
    path.join(providerPath, "manifest.json"),
    JSON.stringify({
      id,
      name: id,
      version,
      sourceType: "academic",
      permissions: { urls: ["https://example.test/*"] },
      ...(options.configSchema ? { configSchema: options.configSchema } : {}),
      ...(options.inventory ? { inventory: options.inventory } : {}),
    }),
    "utf8",
  );
  await writeFile(
    path.join(providerPath, "provider.js"),
    `globalThis.__zrs_exports={createProvider(){return {async search(query){return {platform:${JSON.stringify(platform)},query,totalResults:0,items:[],page:1};}}}};`,
    "utf8",
  );
}

describe("resolveScopedMaxResults", () => {
  it("uses configured or fallback defaults when request is omitted or zero", () => {
    expect(
      resolveScopedMaxResults({
        requested: undefined,
        configured: 25,
        fallback: 10,
        limit: 100,
      }),
    ).toBe(25);
    expect(
      resolveScopedMaxResults({
        requested: 0,
        configured: 25,
        fallback: 10,
        limit: 100,
      }),
    ).toBe(25);
  });

  it("treats -1 as the provider maximum when a limit exists", () => {
    expect(
      resolveScopedMaxResults({
        requested: -1,
        configured: 25,
        fallback: 10,
        limit: 80,
      }),
    ).toBe(80);
  });

  it("clamps explicit requests to the provider limit", () => {
    expect(
      resolveScopedMaxResults({
        requested: 120,
        configured: 25,
        fallback: 10,
        limit: 80,
      }),
    ).toBe(80);
  });
});

describe("search ordering defaults", () => {
  const manifest: ProviderManifest = {
    id: "alpha",
    name: "Alpha",
    version: "1.0.0",
    sourceType: "academic",
    permissions: { urls: ["https://example.test/*"] },
  };

  it("resolves explicit, provider, global, and built-in sort precedence", () => {
    const config = createConfig("C:/fixture");
    config.search.defaultAcademicSort = "citations";
    config.platform.alpha = { defaultSort: "date" };

    expect(resolveSearchOptions(config, manifest, { query: "q", sortBy: "relevance" }).sortBy)
      .toBe("relevance");
    expect(resolveSearchOptions(config, manifest, { query: "q" }).sortBy).toBe("date");

    config.platform.alpha = {};
    expect(resolveSearchOptions(config, manifest, { query: "q" }).sortBy).toBe("citations");

    config.search.defaultAcademicSort = "relevance";
    expect(resolveSearchOptions(config, manifest, { query: "q" }).sortBy).toBe("relevance");
  });

  it("sorts citation values descending, keeps ties stable, and moves missing values last", () => {
    const result = applyReturnedPageOrdering({
      platform: "alpha",
      query: "q",
      totalResults: 4,
      page: 1,
      items: [
        { itemType: "journalArticle", title: "low", citationCount: 2 },
        { itemType: "journalArticle", title: "high-a", citationCount: 9 },
        { itemType: "journalArticle", title: "missing" },
        { itemType: "journalArticle", title: "high-b", citationCount: 9 },
      ],
    }, { value: "citations", origin: "search_config" });

    expect(result.items.map((item) => item.title)).toEqual(["high-a", "high-b", "low", "missing"]);
    expect(result.ordering).toEqual({
      requested: "citations",
      origin: "search_config",
      scope: "returned_page",
      mode: "post_page",
      applied: true,
      direction: "desc",
      valueCount: 3,
      missingCount: 1,
      reordered: true,
    });
  });

  it("preserves provider order and reports unsupported metadata", () => {
    const result = applyReturnedPageOrdering({
      platform: "alpha",
      query: "q",
      totalResults: 2,
      page: 1,
      items: [
        { itemType: "journalArticle", title: "first" },
        { itemType: "journalArticle", title: "second" },
      ],
    }, { value: "citations", origin: "request" });

    expect(result.items.map((item) => item.title)).toEqual(["first", "second"]);
    expect(result.ordering).toMatchObject({ mode: "unsupported", applied: false, missingCount: 2 });
  });
});

describe("exact default-disabled provider intervention", () => {
  it("offers enable action for auto/default-off but stays silent for explicit disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-runtime-default-off-"));
    tempDirs.push(root);
    const config = createConfig(root);
    await writeSearchProvider(
      path.join(config.providers.installDir, "search", "googlescholar"),
      "1.0.0",
      "googlescholar",
      {
        id: "googlescholar",
        configSchema: { enabled: { type: "boolean", default: false } },
      },
    );

    await expect(runProviderSearch(config, "academic", {
      query: "graph",
      platform: "googlescholar",
    })).resolves.toMatchObject({
      skipped: true,
      action: { command: "paper-search configure googlescholar" },
    });

    const broadSearch = await runProviderSearch(config, "academic", {
      query: "graph",
      platform: "all",
    });
    expect(broadSearch).not.toHaveProperty("action");

    config.platform.googlescholar = { enabled: false };
    const explicitlyDisabled = await runProviderSearch(config, "academic", {
      query: "graph",
      platform: "googlescholar",
    });
    expect(explicitlyDisabled).toMatchObject({ skipped: true });
    expect(explicitlyDisabled).not.toHaveProperty("action");
  });
});

describe("search provider runtime paths", () => {
  it("reads a legacy flat provider and prefers the v1 search path when both exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-runtime-paths-"));
    tempDirs.push(root);
    const config = createConfig(root);
    const providersRoot = config.providers.installDir;
    const legacyPath = path.join(providersRoot, "alpha");
    const kindPath = path.join(providersRoot, "search", "alpha");
    await writeSearchProvider(legacyPath, "1.0.0", "legacy");

    const legacy = await loadInstalledProviderRuntime(config, "alpha", "academic");
    expect(legacy.provider).toMatchObject({
      id: "alpha",
      version: "1.0.0",
      path: legacyPath,
      layout: "legacy",
    });
    await expect(legacy.runtime.provider.search("query", {})).resolves.toMatchObject({
      platform: "legacy",
    });

    await writeSearchProvider(kindPath, "2.0.0", "kind");
    const kind = await loadInstalledProviderRuntime(config, "alpha", "academic");
    expect(kind.provider).toMatchObject({
      id: "alpha",
      version: "2.0.0",
      path: kindPath,
      layout: "kind",
    });
    await expect(kind.runtime.provider.search("query", {})).resolves.toMatchObject({
      platform: "kind",
    });
  });

  it("excludes source views from all while allowing explicit view searches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-runtime-views-"));
    tempDirs.push(root);
    const config = createConfig(root);
    const providersRoot = path.join(config.providers.installDir, "search");
    const sourceInventory: ProviderInventoryEntry = {
      schemaVersion: 1,
      id: "crossref",
      kind: "search",
      sourceType: "academic",
      entryKind: "source",
      sourceId: "org.crossref.works",
      serviceFamily: "org.crossref.api",
      transport: "api",
      domains: ["multidisciplinary"],
      contentKinds: ["journal-article"],
      access: ["public"],
      selection: { defaultInAll: true },
      publication: { status: "published" },
    };
    const viewInventory: ProviderInventoryEntry = {
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
    };
    await writeSearchProvider(
      path.join(providersRoot, "crossref"),
      "1.0.0",
      "crossref",
      { id: "crossref", inventory: sourceInventory },
    );
    await writeSearchProvider(path.join(providersRoot, "acm"), "1.0.0", "acm", {
      id: "acm",
      inventory: viewInventory,
    });
    config.platform = {
      crossref: { enabled: true },
      acm: { enabled: true },
    };

    await expect(
      runProviderSearch(config, "academic", { query: "graph", platform: "all" }),
    ).resolves.toMatchObject({ platform: "crossref" });
    await expect(
      runProviderSearch(config, "academic", { query: "graph", platform: "acm" }),
    ).resolves.toMatchObject({ platform: "acm" });
  });

  it("keeps domain-specific sources out of general while literal all and explicit aliases include them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-runtime-selection-"));
    tempDirs.push(root);
    const config = createConfig(root);
    const providerPath = path.join(config.providers.installDir, "search", "pubmed");
    await writeSearchProvider(providerPath, "1.0.0", "pubmed", {
      id: "pubmed",
      inventory: {
        schemaVersion: 1,
        id: "pubmed",
        kind: "search",
        sourceType: "academic",
        entryKind: "source",
        sourceId: "gov.ncbi.pubmed",
        aliases: ["medline"],
        serviceFamily: "gov.ncbi.eutils",
        transport: "api",
        domains: ["biomedicine"],
        contentKinds: ["journal-article"],
        access: ["public"],
        selection: { defaultInAll: false },
        publication: { status: "published" },
      },
    });
    config.platform = { pubmed: { enabled: true } };

    await expect(
      runProviderSearch(config, "academic", { query: "cancer" }),
    ).resolves.toMatchObject({ error: expect.stringContaining("default presets") });
    await expect(
      runProviderSearch(config, "academic", { query: "cancer", platform: "all" }),
    ).resolves.toMatchObject({ platform: "pubmed" });
    await expect(
      runProviderSearch(config, "academic", { query: "cancer", platform: "pubmed" }),
    ).resolves.toMatchObject({ platform: "pubmed" });
    await expect(
      runProviderSearch(config, "academic", { query: "cancer", platform: "medline" }),
    ).resolves.toMatchObject({ platform: "pubmed" });
  });
});
