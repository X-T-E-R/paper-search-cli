import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      try {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
      } catch {
        // ignore cleanup failures in tests
      }
    }),
  );
  tempDirs.length = 0;
});

describe("loadConfig", () => {
  it("merges user, project, and explicit TOML in the right order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-"));
    tempDirs.push(root);

    const userConfigDir = path.join(root, "appdata", "paper-search");
    const projectDir = path.join(root, "project");
    const explicitDir = path.join(root, "explicit");
    await mkdir(userConfigDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(explicitDir, { recursive: true });

    await writeFile(
      path.join(userConfigDir, "config.toml"),
      ["schemaVersion = 1", "", "[output]", 'locale = "en-US"', ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(projectDir, "paper-search.toml"),
      ["[defaults]", "maxResults = 25", "", "[workspace]", 'defaultCollection = "drafts"', ""].join(
        "\n",
      ),
      "utf8",
    );
    await writeFile(
      path.join(explicitDir, "override.toml"),
      ["[workspace]", 'defaultSink = "jsonl"', ""].join("\n"),
      "utf8",
    );

    const originalAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(root, "appdata");

    try {
      const config = await loadConfig({
        cwd: projectDir,
        explicitConfigPath: path.relative(projectDir, path.join(explicitDir, "override.toml")),
      });

      expect(config.output.locale).toBe("en-US");
      expect(config.defaults.maxResults).toBe(25);
      expect(config.workspace.defaultCollection).toBe("drafts");
      expect(config.workspace.defaultSink).toBe("jsonl");
      expect(config.meta.loadedFiles).toHaveLength(3);
      expect(config.meta.appliedEnvOverrides).toEqual([]);
    } finally {
      process.env.APPDATA = originalAppData;
    }
  });

  it("applies environment overrides after file-based config layers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-env-"));
    tempDirs.push(root);

    const projectDir = path.join(root, "project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "paper-search.toml"),
      [
        "[platform.patentstar]",
        'enabled = false',
        'loginName = "from-file"',
        "",
      ].join("\n"),
      "utf8",
    );

    const previousEnv = {
      PAPER_SEARCH_PROVIDERS_INSTALL_DIR: process.env.PAPER_SEARCH_PROVIDERS_INSTALL_DIR,
      PAPER_SEARCH_PLATFORM__PATENTSTAR__ENABLED: process.env.PAPER_SEARCH_PLATFORM__PATENTSTAR__ENABLED,
      PAPER_SEARCH_PLATFORM__PATENTSTAR__LOGIN_NAME: process.env.PAPER_SEARCH_PLATFORM__PATENTSTAR__LOGIN_NAME,
      PAPER_SEARCH_PLATFORM__PATENTSTAR__PASSWORD: process.env.PAPER_SEARCH_PLATFORM__PATENTSTAR__PASSWORD,
    };

    process.env.PAPER_SEARCH_PROVIDERS_INSTALL_DIR = path.join(root, "providers-from-env");
    process.env.PAPER_SEARCH_PLATFORM__PATENTSTAR__ENABLED = "true";
    process.env.PAPER_SEARCH_PLATFORM__PATENTSTAR__LOGIN_NAME = "from-env";
    process.env.PAPER_SEARCH_PLATFORM__PATENTSTAR__PASSWORD = "secret-env";

    try {
      const config = await loadConfig({ cwd: projectDir });
      expect(config.providers.installDir).toBe(path.join(root, "providers-from-env"));
      expect(config.platform.patentstar).toEqual(
        expect.objectContaining({
          enabled: true,
          loginName: "from-env",
          password: "secret-env",
        }),
      );
      expect(config.meta.appliedEnvOverrides).toEqual(
        expect.arrayContaining([
          "PAPER_SEARCH_PROVIDERS_INSTALL_DIR",
          "PAPER_SEARCH_PLATFORM__PATENTSTAR__ENABLED",
          "PAPER_SEARCH_PLATFORM__PATENTSTAR__LOGIN_NAME",
          "PAPER_SEARCH_PLATFORM__PATENTSTAR__PASSWORD",
        ]),
      );
      expect(config.meta.origins?.["platform.patentstar.password"]).toEqual({
        kind: "env",
        source: "PAPER_SEARCH_PLATFORM__PATENTSTAR__PASSWORD",
      });
    } finally {
      process.env.PAPER_SEARCH_PROVIDERS_INSTALL_DIR = previousEnv.PAPER_SEARCH_PROVIDERS_INSTALL_DIR;
      process.env.PAPER_SEARCH_PLATFORM__PATENTSTAR__ENABLED =
        previousEnv.PAPER_SEARCH_PLATFORM__PATENTSTAR__ENABLED;
      process.env.PAPER_SEARCH_PLATFORM__PATENTSTAR__LOGIN_NAME =
        previousEnv.PAPER_SEARCH_PLATFORM__PATENTSTAR__LOGIN_NAME;
      process.env.PAPER_SEARCH_PLATFORM__PATENTSTAR__PASSWORD =
        previousEnv.PAPER_SEARCH_PLATFORM__PATENTSTAR__PASSWORD;
    }
  });

  it("loads credentials after project/explicit config and before environment overrides", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-credentials-"));
    tempDirs.push(root);
    const appDir = path.join(root, "appdata", "paper-search");
    const projectDir = path.join(root, "project");
    const explicitDir = path.join(root, "explicit");
    await mkdir(appDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(explicitDir, { recursive: true });
    await writeFile(
      path.join(appDir, "config.toml"),
      ["schemaVersion = 1", "", "[output]", 'locale = "en-US"', ""].join("\n"),
    );
    await writeFile(
      path.join(appDir, "credentials.toml"),
      ["schemaVersion = 1", "", "[api.tavily]", 'apiKey = "credential-file"', ""].join("\n"),
    );
    await writeFile(
      path.join(projectDir, "paper-search.toml"),
      ["schemaVersion = 1", "", "[workspace]", 'defaultCollection = "project"', ""].join("\n"),
    );
    await writeFile(
      path.join(explicitDir, "config.toml"),
      ["schemaVersion = 1", "", "[workspace]", 'defaultCollection = "explicit"', ""].join("\n"),
    );

    const previous = {
      APPDATA: process.env.APPDATA,
      API_KEY: process.env.PAPER_SEARCH_API__TAVILY__API_KEY,
    };
    process.env.APPDATA = path.join(root, "appdata");
    process.env.PAPER_SEARCH_API__TAVILY__API_KEY = "environment";
    try {
      const config = await loadConfig({ cwd: projectDir, explicitConfigPath: explicitDir });
      expect(config.workspace.defaultCollection).toBe("explicit");
      expect(config.api.tavily).toEqual(expect.objectContaining({ apiKey: "environment" }));
      expect(config.meta.loadedFiles.at(-1)).toBe(path.join(appDir, "credentials.toml"));
      expect(config.meta.origins?.["api.tavily.apiKey"]).toEqual({
        kind: "env",
        source: "PAPER_SEARCH_API__TAVILY__API_KEY",
      });
    } finally {
      process.env.APPDATA = previous.APPDATA;
      process.env.PAPER_SEARCH_API__TAVILY__API_KEY = previous.API_KEY;
    }
  });

  it("rejects secrets and unknown namespaces while retaining one-off lifecycle overrides", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-strict-"));
    tempDirs.push(root);
    const projectDir = path.join(root, "project");
    await mkdir(projectDir, { recursive: true });

    await writeFile(
      path.join(projectDir, "paper-search.toml"),
      ["schemaVersion = 1", "", "[api.tavily]", 'apiKey = "forbidden"', ""].join("\n"),
    );
    await expect(loadConfig({ cwd: projectDir })).rejects.toThrow(/Secret-like key is forbidden/);

    await writeFile(
      path.join(projectDir, "paper-search.toml"),
      ["schemaVersion = 1", "", "[providers]", 'registryUrl = "https://untrusted.example/registry.json"', ""].join("\n"),
    );
    await expect(loadConfig({ cwd: projectDir })).resolves.toMatchObject({
      providers: { registryUrl: "https://untrusted.example/registry.json" },
    });

    await writeFile(
      path.join(projectDir, "paper-search.toml"),
      ["schemaVersion = 1", "", "[subscriptions.bad]", 'url = "https://untrusted.example"', ""].join("\n"),
    );
    await expect(loadConfig({ cwd: projectDir })).rejects.toThrow(/Unrecognized key/);
  });
});
