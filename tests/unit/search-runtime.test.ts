import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import {
  loadInstalledProviderRuntime,
  resolveScopedMaxResults,
} from "../../src/search/runtime.js";

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
): Promise<void> {
  await mkdir(providerPath, { recursive: true });
  await writeFile(
    path.join(providerPath, "manifest.json"),
    JSON.stringify({
      id: "alpha",
      name: "Alpha",
      version,
      sourceType: "academic",
      permissions: { urls: ["https://example.test/*"] },
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
});
