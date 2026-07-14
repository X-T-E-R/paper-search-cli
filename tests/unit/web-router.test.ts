import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import {
  getWebProviderHealth,
  resolveWebIntent,
  resolveWebStrategy,
  routeWebSearch,
} from "../../src/web/router.js";

function createConfig(api: ResolvedConfig["api"]): ResolvedConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    providers: {
      ...structuredClone(DEFAULT_CONFIG.providers),
      installDir: "providers",
    },
    workspace: {
      ...structuredClone(DEFAULT_CONFIG.workspace),
      root: "workspace",
    },
    api,
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

describe("web router", () => {
  it("reports built-in web backend health from api config", () => {
    const config = createConfig({
      tavily: { apiKey: "tvly-test" },
      mysearch: { baseUrl: "http://127.0.0.1:8000" },
    });

    const health = getWebProviderHealth(config);
    expect(health).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tavily",
          configured: true,
          available: true,
          missingConfigKeys: [],
        }),
        expect.objectContaining({
          id: "firecrawl",
          configured: false,
          missingConfigKeys: ["apiKey"],
        }),
        expect.objectContaining({
          id: "mysearch",
          configured: true,
          available: true,
          missingConfigKeys: [],
        }),
      ]),
    );
  });

  it("routes docs/resource searches to firecrawl when configured", () => {
    const config = createConfig({
      tavily: { apiKey: "tvly-test" },
      firecrawl: { apiKey: "fc-test" },
    });

    expect(
      routeWebSearch(config, {
        query: "OpenAI API documentation",
        mode: "docs",
      }),
    ).toMatchObject({
      provider: "firecrawl",
      reason: "Docs/GitHub/PDF uses Firecrawl",
    });
  });

  it("resolves intent and strategy without network access", () => {
    const intent = resolveWebIntent("latest paper-search-cli release news", "auto", "auto", ["web"]);
    expect(intent).toBe("news");
    expect(resolveWebStrategy("auto", intent, "auto", ["web"], false)).toBe("fast");
    expect(resolveWebStrategy("research", "exploratory", "auto", ["web"], false)).toBe("deep");
  });
});
