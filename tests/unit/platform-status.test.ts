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
        inventory: {
          schemaVersion: 1,
          id: "alpha",
          kind: "search",
          sourceType: "academic",
          entryKind: "source",
          sourceId: "example.alpha",
          aliases: ["a"],
          serviceFamily: "example.alpha-api",
          transport: "api",
          domains: ["computer-science"],
          contentKinds: ["conference-paper"],
          access: ["credentialed"],
          selection: { defaultInAll: true },
          publication: { status: "published" },
        },
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
    expect(snapshot.availableTools).not.toContain("web_search");
    expect(snapshot.summary.externalSearchConfigured).toBe(false);
    expect(snapshot.externalSearch.state).toBe("disabled");
    expect(snapshot.web).toEqual([]);
    expect(snapshot.academic).toEqual([
      expect.objectContaining({
        id: "alpha",
        configured: false,
        available: false,
        runnable: false,
        includedInAll: false,
        includedInDefault: false,
        defaultPresets: ["general"],
        defaultSelectionReasons: [],
        selectionReason: "missing required config: apiKey",
        aliases: ["a"],
        domains: ["computer-science"],
        contentKinds: ["conference-paper"],
        access: ["credentialed"],
        missingConfigKeys: ["apiKey"],
      }),
    ]);
  });
});
