import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePaperSearchHome, resolvePaperSearchPaths } from "../../src/config/home.js";
import { resolveConfigBundlePaths } from "../../src/config/paths.js";
import { resolveInstallPaths } from "../../src/runtime/installLayout.js";

describe("Paper Search conventional home", () => {
  it("uses one home for config, data, providers, runs, storage, exports, and shims", () => {
    const userHome = path.resolve("fixture-user-home");
    const env = {
      APPDATA: path.resolve("ignored-appdata"),
      LOCALAPPDATA: path.resolve("ignored-localappdata"),
      XDG_CONFIG_HOME: path.resolve("ignored-xdg"),
    };
    const paths = resolvePaperSearchPaths(env, userHome);

    expect(paths.home).toBe(path.join(userHome, ".paper-search"));
    for (const value of Object.values(paths)) {
      expect(path.relative(paths.home, value)).not.toMatch(/^\.\.(?:[\\/]|$)/u);
    }
    expect(resolveConfigBundlePaths(env).root).not.toContain("ignored-appdata");
  });

  it("honors absolute PAPER_SEARCH_HOME before the gated install-test root", () => {
    const explicit = path.resolve("explicit-paper-search-home");
    const testRoot = path.resolve("test-paper-search-home");
    expect(resolvePaperSearchHome({
      PAPER_SEARCH_HOME: explicit,
      PAPER_SEARCH_INSTALL_TEST_MODE: "1",
      PAPER_SEARCH_TEST_DATA_ROOT: testRoot,
    })).toBe(explicit);
    expect(() => resolvePaperSearchHome({ PAPER_SEARCH_HOME: "relative-home" })).toThrow(
      /must be an absolute path/u,
    );
  });

  it("keeps PAPER_SEARCH_TEST_DATA_ROOT inert outside install test mode", () => {
    const userHome = path.resolve("real-user-home");
    const testRoot = path.resolve("inert-test-root");
    expect(resolvePaperSearchHome({ PAPER_SEARCH_TEST_DATA_ROOT: testRoot }, userHome)).toBe(
      path.join(userHome, ".paper-search"),
    );
    expect(resolvePaperSearchHome({
      PAPER_SEARCH_INSTALL_TEST_MODE: "1",
      PAPER_SEARCH_TEST_DATA_ROOT: testRoot,
    }, userHome)).toBe(testRoot);
  });

  it("keeps runtime install layout aligned with the low-level resolver", () => {
    const home = path.resolve("aligned-home");
    const env = { PAPER_SEARCH_HOME: home };
    const conventional = resolvePaperSearchPaths(env);
    const install = resolveInstallPaths(env);
    expect(install).toMatchObject({
      configRoot: conventional.configRoot,
      dataRoot: conventional.home,
      binRoot: conventional.binRoot,
      installStatePath: path.join(conventional.stateRoot, "install.json"),
    });
  });
});
