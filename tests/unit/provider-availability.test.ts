import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { resolveProviderAvailability } from "../../src/providers/runtime/availability.js";
import type { ProviderManifest } from "../../src/providers/sdk/types.js";

function config(platform: Record<string, Record<string, unknown>> = {}): ResolvedConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    platform,
    meta: {
      cwd: process.cwd(),
      userConfigPath: "user.toml",
      projectConfigPath: null,
      explicitConfigPath: null,
      loadedFiles: [],
      appliedEnvOverrides: [],
    },
  };
}

const manifest: ProviderManifest = {
  id: "credentialed",
  name: "Credentialed",
  version: "1.0.0",
  sourceType: "academic",
  permissions: { urls: ["https://example.com/*"] },
  configSchema: {
    enabled: { type: "boolean", default: false },
    apiKey: { type: "string", default: "", required: true, secret: true },
  },
};

describe("provider availability", () => {
  it("uses manifest enabled defaults and explicit config precedence", () => {
    expect(resolveProviderAvailability(config(), manifest)).toMatchObject({
      enabled: false,
      configured: false,
      available: false,
      missingConfigKeys: ["apiKey"],
    });
    expect(
      resolveProviderAvailability(
        config({ credentialed: { enabled: true, apiKey: "key" } }),
        manifest,
      ),
    ).toMatchObject({ enabled: true, configured: true, available: true });
  });

  it("does not treat an empty required default as configured", () => {
    const result = resolveProviderAvailability(
      config({ credentialed: { enabled: true, apiKey: "  " } }),
      manifest,
    );
    expect(result.configured).toBe(false);
    expect(result.missingConfigKeys).toEqual(["apiKey"]);
  });
});
