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
  it("derives auto/enabled/disabled intent without a parallel account system", () => {
    expect(resolveProviderAvailability(config(), manifest)).toMatchObject({
      intent: "auto",
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
    ).toMatchObject({ intent: "enabled", enabled: true, configured: true, available: true });
    expect(resolveProviderAvailability(
      config({ credentialed: { enabled: false, apiKey: "key" } }),
      manifest,
    )).toMatchObject({ intent: "disabled", enabled: false, configured: true, available: false });
  });

  it("does not treat an empty required default as configured", () => {
    const result = resolveProviderAvailability(
      config({ credentialed: { enabled: true, apiKey: "  " } }),
      manifest,
    );
    expect(result.configured).toBe(false);
    expect(result.missingConfigKeys).toEqual(["apiKey"]);
  });

  it("treats a schema placeholder default as setup-needed", () => {
    const withPlaceholder: ProviderManifest = {
      ...manifest,
      configSchema: {
        enabled: { type: "boolean", default: true },
        email: {
          type: "string",
          default: "xxx@example.com",
          placeholder: "xxx@example.com",
        },
      },
    };
    expect(resolveProviderAvailability(config(), withPlaceholder)).toMatchObject({
      intent: "auto",
      configured: false,
      missingConfigKeys: ["email"],
    });
    expect(resolveProviderAvailability(
      config({ credentialed: { email: "researcher@example.org" } }),
      withPlaceholder,
    )).toMatchObject({ configured: true, missingConfigKeys: [] });
    expect(resolveProviderAvailability(
      config({ credentialed: { email: "   " } }),
      withPlaceholder,
    )).toMatchObject({ configured: false, missingConfigKeys: ["email"] });
  });
});
