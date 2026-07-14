import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProviderDirectoryMigration,
  planProviderDirectoryMigration,
  recoverProviderDirectoryMigrations,
} from "../../src/providers/migration.js";
import {
  inspectProviderReplacementPrecondition,
  PROVIDER_RECEIPT_FILENAME,
} from "../../src/providers/install/manualZip.js";
import { providerTargetPath, resolveProviderLifecyclePaths } from "../../src/providers/paths.js";

const roots: string[] = [];

function testEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPDATA: path.join(root, "appdata"),
    PAPER_SEARCH_INSTALL_TEST_MODE: "1",
    PAPER_SEARCH_TEST_DATA_ROOT: path.join(root, "data"),
  };
}

async function writeLegacySearchProvider(providerPath: string, id: string): Promise<void> {
  await mkdir(providerPath, { recursive: true });
  await writeFile(path.join(providerPath, "manifest.json"), JSON.stringify({
    id,
    name: id,
    version: "1.0.0",
    sourceType: "academic",
    permissions: { urls: ["https://example.test/*"] },
  }), "utf8");
  await writeFile(path.join(providerPath, "provider.js"), "globalThis.__zrs_exports={};", "utf8");
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("provider directory migration", () => {
  it("moves each valid flat provider under its runtime kind and writes an unbound receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-migrate-"));
    roots.push(root);
    const env = testEnv(root);
    const providersRoot = resolveProviderLifecyclePaths(env).providersRoot;
    const source = path.join(providersRoot, "alpha");
    await writeLegacySearchProvider(source, "alpha");

    const plan = await planProviderDirectoryMigration({ env });
    expect(plan.entries).toMatchObject([{
      id: "alpha",
      runtimeKind: "search",
      action: "migrate",
      strategy: "rename",
      sourcePrecondition: { state: "present", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      targetPrecondition: { state: "absent" },
    }]);
    const applied = await applyProviderDirectoryMigration(plan, env);
    expect(applied).toMatchObject({ migrated: ["alpha"], blocked: [] });
    await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
    const target = providerTargetPath("search", "alpha", env);
    const receipt = JSON.parse(await readFile(path.join(target, PROVIDER_RECEIPT_FILENAME), "utf8"));
    expect(receipt).toMatchObject({
      installType: "legacy-directory",
      bound: false,
      runtimeKind: "search",
      id: "alpha",
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      entrySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(receipt).not.toHaveProperty("archiveSha256");
  });

  it("leaves invalid packages and target conflicts untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-migrate-blocked-"));
    roots.push(root);
    const env = testEnv(root);
    const providersRoot = resolveProviderLifecyclePaths(env).providersRoot;
    const invalid = path.join(providersRoot, "invalid");
    await mkdir(invalid, { recursive: true });
    await writeFile(path.join(invalid, "manifest.json"), "{}", "utf8");
    const source = path.join(providersRoot, "alpha");
    await writeLegacySearchProvider(source, "alpha");
    const target = providerTargetPath("search", "alpha", env);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "marker.txt"), "existing", "utf8");

    const plan = await planProviderDirectoryMigration({ env });
    expect(plan.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "alpha", action: "blocked", reason: expect.stringContaining("global namespace owner") }),
      expect.objectContaining({ id: "invalid", action: "blocked" }),
    ]));
    const applied = await applyProviderDirectoryMigration(plan, env);
    expect(applied.migrated).toEqual([]);
    await expect(readFile(path.join(target, "marker.txt"), "utf8")).resolves.toBe("existing");
    await expect(access(source)).resolves.toBeUndefined();
    await expect(access(invalid)).resolves.toBeUndefined();
  });

  it("preserves a valid existing unbound receipt while changing only the directory layout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-migrate-receipt-"));
    roots.push(root);
    const env = testEnv(root);
    const source = path.join(resolveProviderLifecyclePaths(env).providersRoot, "alpha");
    await writeLegacySearchProvider(source, "alpha");
    const manifest = await readFile(path.join(source, "manifest.json"), "utf8");
    const entry = await readFile(path.join(source, "provider.js"));
    const receipt = {
      schemaVersion: 1,
      runtimeKind: "search",
      providerKind: "academic",
      id: "alpha",
      version: "1.0.0",
      installType: "manual-zip",
      bound: false,
      archiveSha256: "a".repeat(64),
      manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      entryPath: "provider.js",
      entrySha256: createHash("sha256").update(entry).digest("hex"),
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(path.join(source, PROVIDER_RECEIPT_FILENAME), `${JSON.stringify(receipt, null, 2)}\n`);

    const plan = await planProviderDirectoryMigration({ env });
    expect(plan.entries).toMatchObject([{ id: "alpha", action: "migrate", preserveReceipt: true }]);
    await applyProviderDirectoryMigration(plan, env);
    expect(JSON.parse(await readFile(
      path.join(providerTargetPath("search", "alpha", env), PROVIDER_RECEIPT_FILENAME),
      "utf8",
    ))).toEqual(receipt);
  });

  it("completes recovery after selecting a target with a preserved manual receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-migrate-selected-"));
    roots.push(root);
    const env = testEnv(root);
    const paths = resolveProviderLifecyclePaths(env);
    const source = path.join(paths.providersRoot, "alpha");
    await writeLegacySearchProvider(source, "alpha");
    const manifest = await readFile(path.join(source, "manifest.json"), "utf8");
    const entry = await readFile(path.join(source, "provider.js"));
    const receipt = {
      schemaVersion: 1,
      runtimeKind: "search",
      providerKind: "academic",
      id: "alpha",
      version: "1.0.0",
      installType: "manual-zip",
      bound: false,
      archiveSha256: "a".repeat(64),
      manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      entryPath: "provider.js",
      entrySha256: createHash("sha256").update(entry).digest("hex"),
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(path.join(source, PROVIDER_RECEIPT_FILENAME), `${JSON.stringify(receipt, null, 2)}\n`);
    const sourceState = await inspectProviderReplacementPrecondition(source);
    const target = providerTargetPath("search", "alpha", env);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(source, target);

    await mkdir(paths.migrationStateDir, { recursive: true });
    const operationId = "selected-with-receipt";
    const journalPath = path.join(
      paths.migrationStateDir,
      `provider-${createHash("sha256").update(operationId).digest("hex")}.json`,
    );
    await writeFile(journalPath, JSON.stringify({
      schemaVersion: 1,
      operationId,
      providerId: "alpha",
      runtimeKind: "search",
      planDigest: "b".repeat(64),
      sourceRoot: paths.providersRoot,
      sourcePath: source,
      targetPath: target,
      stagingPath: path.join(paths.searchInstallDir, "._migrate_alpha_selected"),
      strategy: "rename",
      sourceDigest: sourceState.digest,
      sourceHadReceipt: true,
      status: "selected",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }), "utf8");

    await expect(recoverProviderDirectoryMigrations(env)).resolves.toMatchObject({ recovered: ["alpha"] });
    await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(target, PROVIDER_RECEIPT_FILENAME), "utf8"))
      .resolves.toContain('"installType": "manual-zip"');
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ status: "complete" });
  });

  it("restores an interrupted same-volume staging rename without selecting a target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-migrate-recover-"));
    roots.push(root);
    const env = testEnv(root);
    const paths = resolveProviderLifecyclePaths(env);
    const source = path.join(paths.providersRoot, "alpha");
    await writeLegacySearchProvider(source, "alpha");
    const sourceState = await inspectProviderReplacementPrecondition(source);
    await mkdir(paths.searchInstallDir, { recursive: true });
    const staging = path.join(paths.searchInstallDir, "._migrate_alpha_interrupted");
    await rename(source, staging);
    await mkdir(paths.migrationStateDir, { recursive: true });
    const operationId = "interrupted";
    const journalPath = path.join(
      paths.migrationStateDir,
      `provider-${createHash("sha256").update(operationId).digest("hex")}.json`,
    );
    await writeFile(journalPath, JSON.stringify({
      schemaVersion: 1,
      operationId,
      providerId: "alpha",
      runtimeKind: "search",
      planDigest: "a".repeat(64),
      sourceRoot: paths.providersRoot,
      sourcePath: source,
      targetPath: providerTargetPath("search", "alpha", env),
      stagingPath: staging,
      strategy: "rename",
      sourceDigest: sourceState.digest,
      sourceHadReceipt: false,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }), "utf8");

    await expect(recoverProviderDirectoryMigrations(env)).resolves.toMatchObject({ recovered: ["alpha"] });
    await expect(access(source)).resolves.toBeUndefined();
    await expect(access(staging)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ status: "complete" });
  });

  it("refuses recovery when a selected target differs from the original directory plus its generated receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-migrate-changed-target-"));
    roots.push(root);
    const env = testEnv(root);
    const paths = resolveProviderLifecyclePaths(env);
    const source = path.join(paths.providersRoot, "alpha");
    await writeLegacySearchProvider(source, "alpha");
    await writeFile(path.join(source, "notes.txt"), "original", "utf8");
    const plan = await planProviderDirectoryMigration({ env });
    const entry = plan.entries[0]!;
    const sourceState = await inspectProviderReplacementPrecondition(source);
    const target = providerTargetPath("search", "alpha", env);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(path.join(target, PROVIDER_RECEIPT_FILENAME), JSON.stringify({
      schemaVersion: 1,
      runtimeKind: "search",
      providerKind: "academic",
      id: "alpha",
      version: "1.0.0",
      installType: "legacy-directory",
      bound: false,
      manifestSha256: entry.manifestSha256,
      entryPath: entry.entryPath,
      entrySha256: entry.entrySha256,
      installedAt: now,
      updatedAt: now,
    }), "utf8");
    await writeFile(path.join(target, "notes.txt"), "changed", "utf8");

    await mkdir(paths.migrationStateDir, { recursive: true });
    const operationId = "selected-with-generated-receipt";
    const journalPath = path.join(
      paths.migrationStateDir,
      `provider-${createHash("sha256").update(operationId).digest("hex")}.json`,
    );
    await writeFile(journalPath, JSON.stringify({
      schemaVersion: 1,
      operationId,
      providerId: "alpha",
      runtimeKind: "search",
      planDigest: plan.planDigest,
      sourceRoot: paths.providersRoot,
      sourcePath: source,
      targetPath: target,
      stagingPath: path.join(paths.searchInstallDir, "._migrate_alpha_selected"),
      strategy: "copy",
      sourceDigest: sourceState.digest,
      sourceHadReceipt: false,
      status: "selected",
      createdAt: now,
      updatedAt: now,
    }), "utf8");

    await expect(recoverProviderDirectoryMigrations(env)).rejects.toThrow(/unrecognized selected target/);
    await expect(readFile(path.join(source, "notes.txt"), "utf8")).resolves.toBe("original");
    await expect(readFile(path.join(target, "notes.txt"), "utf8")).resolves.toBe("changed");
  });
});
