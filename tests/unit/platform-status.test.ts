import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlatformStatusSnapshot } from "../../src/surface/status.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      try {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
      } catch {
        // ignore cleanup failures
      }
    }),
  );
  tempDirs.length = 0;
});

function createConfig(installDir: string): ResolvedConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    providers: {
      ...structuredClone(DEFAULT_CONFIG.providers),
      installDir,
    },
    meta: {
      cwd: process.cwd(),
      userConfigPath: "user-config.toml",
      projectConfigPath: null,
      explicitConfigPath: null,
      loadedFiles: [],
      appliedEnvOverrides: [],
    },
    platform: {
      alpha: {
        enabled: true,
      },
    },
    api: {
      tavily: {
        apiKey: "tvly-test",
      },
    },
  };
}

describe("platform status snapshot", () => {
  it("marks providers unavailable when required config fields are missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-platform-status-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    await mkdir(path.join(installDir, "alpha"), { recursive: true });
    await writeFile(
      path.join(installDir, "alpha", "manifest.json"),
      JSON.stringify({
        id: "alpha",
        name: "Alpha Provider",
        version: "1.0.0",
        sourceType: "academic",
        permissions: { urls: ["https://alpha.example/*"] },
        configSchema: {
          apiKey: {
            type: "string",
            required: true,
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(installDir, "alpha", "provider.js"),
      "globalThis.__zrs_exports = { createProvider(){ return { async search(){ return { platform:'alpha', query:'', totalResults:0, items:[], page:1 }; } }; } };",
      "utf8",
    );

    const snapshot = await createPlatformStatusSnapshot(createConfig(installDir));
    expect(snapshot.availableTools).toContain("platform_status");
    expect(snapshot.availableTools).toContain("web_search");
    expect(snapshot.summary.configuredWebBackends).toBe(1);
    expect(snapshot.web).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tavily",
          configured: true,
          available: true,
        }),
        expect.objectContaining({
          id: "firecrawl",
          configured: false,
          missingConfigKeys: ["apiKey"],
        }),
      ]),
    );
    expect(snapshot.academic).toEqual([
      expect.objectContaining({
        id: "alpha",
        configured: false,
        available: false,
        missingConfigKeys: ["apiKey"],
      }),
    ]);
  });
});
