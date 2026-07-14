import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import {
  resolveConfigBundlePaths,
  resolveConfigFragmentDirectory,
  resolveDefaultUserConfigPath,
} from "../../src/config/paths.js";
import { buildProgram } from "../../src/program.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function withAppData<T>(root: string, run: () => Promise<T>): Promise<T> {
  const originalAppData = process.env.APPDATA;
  const originalTestMode = process.env.PAPER_SEARCH_INSTALL_TEST_MODE;
  const originalDataRoot = process.env.PAPER_SEARCH_TEST_DATA_ROOT;
  process.env.APPDATA = path.join(root, "appdata");
  process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
  process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(root, "data");
  try {
    return await run();
  } finally {
    restoreEnv("APPDATA", originalAppData);
    restoreEnv("PAPER_SEARCH_INSTALL_TEST_MODE", originalTestMode);
    restoreEnv("PAPER_SEARCH_TEST_DATA_ROOT", originalDataRoot);
  }
}

async function runConfigCommand(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  envelope: ResultEnvelope;
}> {
  let stdout = "";
  let stderr = "";
  await buildProgram({
    stdout: { write(chunk: string) { stdout += chunk; } },
    stderr: { write(chunk: string) { stderr += chunk; } },
  })
    .exitOverride()
    .parseAsync(["node", "paper-search", ...args]);
  const envelope = JSON.parse(stdout) as ResultEnvelope;
  expect(isResultEnvelope(envelope)).toBe(true);
  return { stdout, stderr, envelope };
}

describe("config command", () => {
  it("reports all bundle paths and explains the winning origin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-paths-"));
    tempDirs.push(root);
    await withAppData(root, async () => {
      const pathResult = await runConfigCommand(["config", "path", "--all"]);
      expect(pathResult.envelope).toMatchObject({
        ok: true,
        tool: "config_path",
        data: {
          configRoot: resolveConfigBundlePaths().root,
          config: resolveConfigBundlePaths().config,
          configFragments: resolveConfigFragmentDirectory(resolveConfigBundlePaths().config),
          subscriptions: resolveConfigBundlePaths().subscriptions,
          credentials: resolveConfigBundlePaths().credentials,
        },
      });

      await runConfigCommand(["config", "set", "defaults.maxResults", "41"]);
      const explainResult = await runConfigCommand(["config", "explain", "defaults.maxResults"]);
      expect(explainResult.envelope).toMatchObject({
        ok: true,
        tool: "config_explain",
        data: {
          key: "defaults.maxResults",
          value: 41,
          origin: { kind: "user", source: resolveDefaultUserConfigPath() },
        },
      });

      const validateResult = await runConfigCommand(["config", "validate"]);
      expect(validateResult.envelope).toMatchObject({
        ok: true,
        tool: "config_validate",
        data: { valid: true },
      });
    });
  });

  it("round-trips set, get, and unset through the user config file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-command-"));
    tempDirs.push(root);

    await withAppData(root, async () => {
      const setResult = await runConfigCommand(["config", "set", "defaults.maxResults", "42"]);
      expect(setResult.stderr).toBe("");
      expect(setResult.envelope).toMatchObject({
        ok: true,
        capability: "operate",
        tool: "config_set",
        data: { key: "defaults.maxResults", value: 42, masked: false },
      });

      const getResult = await runConfigCommand(["config", "get", "defaults.maxResults"]);
      expect(getResult.envelope).toMatchObject({
        ok: true,
        capability: "operate",
        tool: "config_get",
        data: { key: "defaults.maxResults", exists: true, value: 42, masked: false },
      });

      const unsetResult = await runConfigCommand(["config", "unset", "defaults.maxResults"]);
      expect(unsetResult.envelope).toMatchObject({
        ok: true,
        capability: "operate",
        tool: "config_unset",
        data: { key: "defaults.maxResults", removed: true },
      });

      const missingResult = await runConfigCommand(["config", "get", "defaults.maxResults"]);
      expect(missingResult.envelope).toMatchObject({
        ok: true,
        tool: "config_get",
        data: { key: "defaults.maxResults", exists: false, value: null, masked: false },
      });
    });
  });

  it("persists installed provider aliases as canonical ids in tags and presets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-canonical-source-"));
    tempDirs.push(root);

    await withAppData(root, async () => {
      const providerRoot = (await loadConfig({ cwd: root })).providers.installDir;
      const providerDir = path.join(providerRoot, "search", "pubmed");
      tempDirs.push(providerDir);
      await mkdir(providerDir, { recursive: true });
      await writeFile(path.join(providerDir, "manifest.json"), JSON.stringify({
        id: "pubmed",
        name: "PubMed",
        version: "1.0.0",
        sourceType: "academic",
        permissions: { urls: ["https://example.test/*"] },
        inventory: {
          schemaVersion: 1,
          id: "pubmed",
          kind: "search",
          sourceType: "academic",
          entryKind: "source",
          sourceId: "example.pubmed",
          aliases: ["medline"],
          serviceFamily: "example.pubmed-api",
          transport: "api",
          domains: ["biomedicine"],
          contentKinds: ["journal-article"],
          access: ["public"],
          selection: { defaultInAll: false },
          publication: { status: "published" },
        },
      }));
      await writeFile(
        path.join(providerDir, "provider.js"),
        "globalThis.__zrs_exports={createProvider(){return {async search(){return {platform:'pubmed',query:'',totalResults:0,items:[],page:1}}}}}",
      );
      const configPath = resolveDefaultUserConfigPath();

      const tagResult = await runConfigCommand([
        "config",
        "set",
        "search.classifications.lab.sources",
        '["medline"]',
      ]);
      expect(tagResult.envelope, JSON.stringify(tagResult.envelope)).toMatchObject({
        ok: true,
        data: { value: ["pubmed"] },
      });
      const presetResult = await runConfigCommand([
        "config",
        "set",
        "search.presets.custom.include",
        '["source:medline","domain:biomedicine"]',
      ]);
      expect(presetResult.envelope).toMatchObject({
        ok: true,
        data: { value: ["source:pubmed", "domain:biomedicine"] },
      });

      const raw = await readFile(configPath, "utf8");
      expect(raw).not.toContain("medline");
      const resolved = await loadConfig({ cwd: root });
      expect(resolved.search.classifications.lab?.sources).toEqual(["pubmed"]);
      expect(resolved.search.presets.custom?.include).toEqual([
        "source:pubmed",
        "domain:biomedicine",
      ]);
    });
  });

  it("rejects generic secret writes and masks dedicated credential reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-mask-"));
    tempDirs.push(root);

    await withAppData(root, async () => {
      const secret = "super-secret-config-value";
      const rejected = await runConfigCommand(["config", "set", "api.openai.apiKey", secret]);
      expect(rejected.envelope).toMatchObject({ ok: false, tool: "config_set" });
      expect(rejected.stdout).not.toContain(secret);

      const previous = process.env.PAPER_SEARCH_TEST_CREDENTIAL;
      process.env.PAPER_SEARCH_TEST_CREDENTIAL = secret;
      try {
        const setResult = await runConfigCommand([
          "config",
          "credentials",
          "set",
          "api.openai.apiKey",
          "--from-env",
          "PAPER_SEARCH_TEST_CREDENTIAL",
        ]);
        expect(setResult.stdout).not.toContain(secret);
        expect(setResult.envelope).toMatchObject({
          ok: true,
          tool: "config_credentials_set",
          data: { key: "api.openai.apiKey", value: "********", masked: true },
        });

        const getResult = await runConfigCommand(["config", "credentials", "get", "api.openai.apiKey"]);
        expect(getResult.stdout).not.toContain(secret);
        expect(getResult.envelope).toMatchObject({
          ok: true,
          tool: "config_credentials_get",
          data: { key: "api.openai.apiKey", exists: true, value: "********", masked: true },
        });

        const rawCredentials = await readFile(resolveConfigBundlePaths().credentials, "utf8");
        expect(rawCredentials).toContain(secret);
        expect(rawCredentials).toContain("schemaVersion = 1");
      } finally {
        restoreEnv("PAPER_SEARCH_TEST_CREDENTIAL", previous);
      }
    });
  });

  it("plans import-env by default and applies non-secrets and secrets to owning files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-import-env-"));
    tempDirs.push(root);
    const envPath = path.join(root, ".env");
    await writeFile(
      envPath,
      [
        "PAPER_SEARCH_DEFAULTS_MAX_RESULTS=77",
        "PAPER_SEARCH_API__OPENAI__API_KEY=file-secret",
        "",
      ].join("\n"),
      "utf8",
    );

    const originalApiKey = process.env.PAPER_SEARCH_API__OPENAI__API_KEY;
    delete process.env.PAPER_SEARCH_API__OPENAI__API_KEY;

    try {
      await withAppData(root, async () => {
        const planResult = await runConfigCommand(["config", "import-env", envPath]);
        expect(planResult.stdout).not.toContain("file-secret");
        expect(planResult.envelope).toMatchObject({
          ok: true,
          capability: "operate",
          tool: "config_import_env",
          planned: true,
          data: {
            applied: false,
            imported: expect.arrayContaining([
              {
                env: "PAPER_SEARCH_DEFAULTS_MAX_RESULTS",
                key: "defaults.maxResults",
                value: 77,
                masked: false,
                line: 1,
                target: "config",
                path: resolveDefaultUserConfigPath(),
              },
              {
                env: "PAPER_SEARCH_API__OPENAI__API_KEY",
                key: "api.openai.apiKey",
                value: "********",
                masked: true,
                line: 2,
                target: "credentials",
                path: resolveConfigBundlePaths().credentials,
              },
            ]),
            skippedShellEnv: [],
            ignored: [],
          },
        });
        await expect(readFile(resolveDefaultUserConfigPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        const importResult = await runConfigCommand(["config", "import-env", envPath, "--apply"]);
        expect(importResult.stdout).not.toContain("file-secret");
        expect(importResult.envelope).toMatchObject({
          ok: true,
          planned: false,
          data: { applied: true },
        });

        const rawUserConfig = await readFile(resolveDefaultUserConfigPath(), "utf8");
        expect(rawUserConfig).toContain("maxResults = 77");
        expect(rawUserConfig).not.toContain("file-secret");
        const rawCredentials = await readFile(resolveConfigBundlePaths().credentials, "utf8");
        expect(rawCredentials).toContain("file-secret");

        const resolved = await loadConfig({ cwd: root });
        expect(resolved.defaults.maxResults).toBe(77);
        expect(resolved.api.openai).toEqual(expect.objectContaining({ apiKey: "file-secret" }));
      });
    } finally {
      restoreEnv("PAPER_SEARCH_API__OPENAI__API_KEY", originalApiKey);
    }
  });
});
