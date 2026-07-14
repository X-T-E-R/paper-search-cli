import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfigBundlePaths } from "../../src/config/paths.js";
import { buildProgram } from "../../src/program.js";
import type { ResultEnvelope } from "../../src/surface/resultEnvelope.js";
import { providerTargetPath, resolveProviderLifecyclePaths } from "../../src/providers/paths.js";
import { inspectProviderReplacementPrecondition } from "../../src/providers/install/manualZip.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function runMigrate(args: string[]): Promise<ResultEnvelope> {
  let stdout = "";
  await buildProgram({
    stdout: { write(chunk: string) { stdout += chunk; } },
    stderr: { write() {} },
  })
    .exitOverride()
    .parseAsync(["node", "paper-search", "migrate", ...args]);
  return JSON.parse(stdout) as ResultEnvelope;
}

async function writeLegacySearchProvider(target: string, id: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const manifest = JSON.parse(await readFile(
    path.join("tests", "fixtures", "provider-packages", "fixture-academic", "manifest.json"),
    "utf8",
  )) as Record<string, unknown>;
  manifest.id = id;
  await writeFile(path.join(target, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await writeFile(path.join(target, "provider.js"), "globalThis.__zrs_exports = {};\n");
}

describe("migrate command", () => {
  it("registers a read-only plan by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-migrate-command-"));
    roots.push(root);
    const previous = {
      appData: process.env.APPDATA,
      testMode: process.env.PAPER_SEARCH_INSTALL_TEST_MODE,
      dataRoot: process.env.PAPER_SEARCH_TEST_DATA_ROOT,
    };
    process.env.APPDATA = path.join(root, "appdata");
    process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
    process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(root, "data");
    try {
      const invalid = path.join(root, "data", "providers", "invalid-provider");
      await mkdir(invalid, { recursive: true });
      await writeFile(path.join(invalid, "manifest.json"), "{}\n");
      const envelope = await runMigrate([]);
      expect(envelope).toMatchObject({
        ok: true,
        tool: "migrate",
        planned: true,
        data: {
          applied: false,
          plan: {
            config: expect.any(Object),
            providerDirectory: { status: "ready", plan: expect.any(Object) },
            blockers: expect.arrayContaining([
              expect.objectContaining({
                scope: "provider-directory",
                key: "invalid-provider",
                blocksAllApply: false,
              }),
            ]),
          },
        },
      });
      await expect(access(resolveConfigBundlePaths().config)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restoreEnv("APPDATA", previous.appData);
      restoreEnv("PAPER_SEARCH_INSTALL_TEST_MODE", previous.testMode);
      restoreEnv("PAPER_SEARCH_TEST_DATA_ROOT", previous.dataRoot);
    }
  });

  it("applies config then provider-directory migration and reruns idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-migrate-apply-"));
    roots.push(root);
    const previous = {
      appData: process.env.APPDATA,
      testMode: process.env.PAPER_SEARCH_INSTALL_TEST_MODE,
      dataRoot: process.env.PAPER_SEARCH_TEST_DATA_ROOT,
    };
    process.env.APPDATA = path.join(root, "appdata");
    process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
    process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(root, "data");
    try {
      const config = resolveConfigBundlePaths().config;
      await mkdir(path.dirname(config), { recursive: true });
      await writeFile(config, "[defaults]\nmaxResults = 33\n");
      await writeLegacySearchProvider(path.join(root, "data", "providers", "alpha"), "alpha");

      const applied = await runMigrate(["--apply"]);
      expect(applied).toMatchObject({
        ok: true,
        planned: false,
        data: {
          applied: true,
          changed: true,
          components: {
            config: { applied: true, changed: true },
            providerDirectory: { applied: true, migrated: ["alpha"], blocked: [] },
          },
        },
      });
      await expect(access(providerTargetPath("search", "alpha", process.env))).resolves.toBeUndefined();
      await expect(access(path.join(root, "data", "providers", "alpha"))).rejects.toMatchObject({ code: "ENOENT" });

      const rerun = await runMigrate(["--apply"]);
      expect(rerun).toMatchObject({
        ok: true,
        data: {
          applied: true,
          changed: false,
          components: {
            config: { changed: false },
            providerDirectory: { migrated: [] },
          },
        },
      });
    } finally {
      restoreEnv("APPDATA", previous.appData);
      restoreEnv("PAPER_SEARCH_INSTALL_TEST_MODE", previous.testMode);
      restoreEnv("PAPER_SEARCH_TEST_DATA_ROOT", previous.dataRoot);
    }
  });

  it("migrates config only for a custom compatibility root until the source is explicit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-migrate-custom-"));
    roots.push(root);
    const previous = {
      appData: process.env.APPDATA,
      testMode: process.env.PAPER_SEARCH_INSTALL_TEST_MODE,
      dataRoot: process.env.PAPER_SEARCH_TEST_DATA_ROOT,
    };
    process.env.APPDATA = path.join(root, "appdata");
    process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
    process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(root, "data");
    try {
      const customRoot = path.join(root, "custom-providers");
      const config = resolveConfigBundlePaths().config;
      await mkdir(path.dirname(config), { recursive: true });
      await writeFile(config, `[providers]\ninstallDir = "${customRoot.replace(/\\/g, "\\\\")}"\n`);
      await writeLegacySearchProvider(path.join(customRoot, "alpha"), "alpha");

      const configOnly = await runMigrate(["--apply"]);
      expect(configOnly).toMatchObject({
        ok: true,
        data: {
          applied: true,
          changed: true,
          plan: {
            providerDirectory: {
              status: "requires-explicit-source",
              operationalOwnership: "machine-data-root",
              plan: null,
            },
          },
          components: {
            config: { changed: true },
            providerDirectory: { applied: false, migrated: [] },
          },
        },
      });
      await expect(access(path.join(customRoot, "alpha"))).resolves.toBeUndefined();

      const explicit = await runMigrate(["--legacy-install-dir", customRoot, "--apply"]);
      expect(explicit).toMatchObject({
        ok: true,
        data: {
          components: {
            config: { changed: false },
            providerDirectory: { applied: true, migrated: ["alpha"] },
          },
        },
      });
      await expect(access(providerTargetPath("search", "alpha", process.env))).resolves.toBeUndefined();
    } finally {
      restoreEnv("APPDATA", previous.appData);
      restoreEnv("PAPER_SEARCH_INSTALL_TEST_MODE", previous.testMode);
      restoreEnv("PAPER_SEARCH_TEST_DATA_ROOT", previous.dataRoot);
    }
  });

  it("recovers pending provider journals before selecting and applying a new plan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-migrate-recover-command-"));
    roots.push(root);
    const previous = {
      appData: process.env.APPDATA,
      testMode: process.env.PAPER_SEARCH_INSTALL_TEST_MODE,
      dataRoot: process.env.PAPER_SEARCH_TEST_DATA_ROOT,
    };
    process.env.APPDATA = path.join(root, "appdata");
    process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
    process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(root, "data");
    try {
      const paths = resolveProviderLifecyclePaths(process.env);
      const source = path.join(paths.providersRoot, "alpha");
      await writeLegacySearchProvider(source, "alpha");
      const sourceState = await inspectProviderReplacementPrecondition(source);
      await mkdir(paths.searchInstallDir, { recursive: true });
      const staging = path.join(paths.searchInstallDir, "._migrate_alpha_command-interrupted");
      await rename(source, staging);
      await mkdir(paths.migrationStateDir, { recursive: true });
      const operationId = "command-interrupted";
      await writeFile(
        path.join(
          paths.migrationStateDir,
          `provider-${createHash("sha256").update(operationId).digest("hex")}.json`,
        ),
        JSON.stringify({
          schemaVersion: 1,
          operationId,
          providerId: "alpha",
          runtimeKind: "search",
          planDigest: "a".repeat(64),
          sourceRoot: paths.providersRoot,
          sourcePath: source,
          targetPath: providerTargetPath("search", "alpha", process.env),
          stagingPath: staging,
          strategy: "rename",
          sourceDigest: sourceState.digest,
          sourceHadReceipt: false,
          status: "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );

      const result = await runMigrate(["--apply"]);
      expect(result).toMatchObject({
        ok: true,
        data: {
          components: {
            providerDirectory: {
              applied: true,
              recovered: ["alpha"],
              migrated: ["alpha"],
            },
          },
        },
      });
      await expect(access(providerTargetPath("search", "alpha", process.env))).resolves.toBeUndefined();
    } finally {
      restoreEnv("APPDATA", previous.appData);
      restoreEnv("PAPER_SEARCH_INSTALL_TEST_MODE", previous.testMode);
      restoreEnv("PAPER_SEARCH_TEST_DATA_ROOT", previous.dataRoot);
    }
  });

  it("does not move providers when a config blocker prevents the combined apply", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-migrate-blocked-command-"));
    roots.push(root);
    const previous = {
      appData: process.env.APPDATA,
      testMode: process.env.PAPER_SEARCH_INSTALL_TEST_MODE,
      dataRoot: process.env.PAPER_SEARCH_TEST_DATA_ROOT,
    };
    process.env.APPDATA = path.join(root, "appdata");
    process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
    process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(root, "data");
    try {
      const config = resolveConfigBundlePaths().config;
      await mkdir(path.dirname(config), { recursive: true });
      await writeFile(config, "[unknown]\nvalue = true\n");
      const source = path.join(root, "data", "providers", "alpha");
      await writeLegacySearchProvider(source, "alpha");

      const result = await runMigrate(["--apply"]);
      expect(result).toMatchObject({
        ok: true,
        data: {
          applied: false,
          changed: false,
          blockers: expect.arrayContaining([
            expect.objectContaining({ scope: "config", blocksAllApply: true }),
          ]),
          components: {
            config: { applied: false, changed: false },
            providerDirectory: { applied: false, migrated: [] },
          },
        },
      });
      await expect(access(source)).resolves.toBeUndefined();
      await expect(access(providerTargetPath("search", "alpha", process.env))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restoreEnv("APPDATA", previous.appData);
      restoreEnv("PAPER_SEARCH_INSTALL_TEST_MODE", previous.testMode);
      restoreEnv("PAPER_SEARCH_TEST_DATA_ROOT", previous.dataRoot);
    }
  });
});
