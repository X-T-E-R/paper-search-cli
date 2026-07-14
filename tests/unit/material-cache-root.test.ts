import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { resolveMaterialProviderCacheRoot } from "../../src/material/cache.js";

describe("material provider cache root", () => {
  it("derives replaceable cache state from the conventional user config home", () => {
    const config = {
      meta: {
        userConfigPath: path.join("C:\\Users\\researcher", ".paper-search", "config.toml"),
      },
    } as Pick<ResolvedConfig, "meta">;

    expect(resolveMaterialProviderCacheRoot(config)).toBe(
      path.join("C:\\Users\\researcher", ".paper-search", "cache", "material"),
    );
  });

  it("does not follow project workspace or explicit storage roots", () => {
    const config = {
      meta: {
        userConfigPath: path.join("D:\\profiles\\paper-search", "config.toml"),
      },
      workspace: { root: "E:\\project\\workspace" },
      storage: { artifactRoot: "F:\\papers" },
    } as unknown as Pick<ResolvedConfig, "meta">;

    expect(resolveMaterialProviderCacheRoot(config)).toBe(
      path.join("D:\\profiles\\paper-search", "cache", "material"),
    );
  });
});
