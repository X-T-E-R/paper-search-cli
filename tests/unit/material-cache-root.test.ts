import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { resolveMaterialProviderCacheRoot } from "../../src/material/cache.js";

describe("material provider cache root", () => {
  it("derives replaceable cache state from the conventional user config home", () => {
    const paperSearchHome = path.resolve("test-user-home", ".paper-search");
    const config = {
      meta: {
        userConfigPath: path.join(paperSearchHome, "config.toml"),
      },
    } as Pick<ResolvedConfig, "meta">;

    expect(resolveMaterialProviderCacheRoot(config)).toBe(
      path.join(paperSearchHome, "cache", "material"),
    );
  });

  it("does not follow project workspace or explicit storage roots", () => {
    const paperSearchHome = path.resolve("test-profiles", "paper-search");
    const config = {
      meta: {
        userConfigPath: path.join(paperSearchHome, "config.toml"),
      },
      workspace: { root: path.resolve("test-project", "workspace") },
      storage: { artifactRoot: path.resolve("test-storage", "papers") },
    } as unknown as Pick<ResolvedConfig, "meta">;

    expect(resolveMaterialProviderCacheRoot(config)).toBe(
      path.join(paperSearchHome, "cache", "material"),
    );
  });
});
