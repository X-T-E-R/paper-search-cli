import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/program.js";
import {
  inspectProviderLifecycleHealth,
} from "../../src/commands/doctor.js";
import {
  PROVIDER_RECEIPT_FILENAME,
  sha256Bytes,
  type ProviderInstallReceipt,
  type ProviderRuntimeKind,
} from "../../src/providers/install/manualZip.js";
import { providerTargetPath, resolveProviderLifecyclePaths } from "../../src/providers/paths.js";
import { resolveSubscriptionPaths } from "../../src/subscriptions/paths.js";
import { readCurrentRegistrySnapshot } from "../../src/subscriptions/registry.js";
import { executeSubscriptionMutation, refreshSubscriptions } from "../../src/subscriptions/service.js";
import {
  readIdentity,
  readSubscriptionsFile,
  serializeSubscriptionsFile,
} from "../../src/subscriptions/store.js";

const roots: string[] = [];
const repositoryRoot = process.cwd();

function testEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPDATA: path.join(root, "appdata"),
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    PAPER_SEARCH_INSTALL_TEST_MODE: "1",
    PAPER_SEARCH_TEST_DATA_ROOT: path.join(root, "data"),
  };
}

function tomlPath(filePath: string): string {
  return filePath.replace(/\\/g, "\\\\");
}

async function addSubscription(
  env: NodeJS.ProcessEnv,
  id: string,
  registryPath: string,
  providerId: string,
): Promise<{
  sourceFingerprint: string;
  canonicalSource: string;
  registryDigest: string;
}> {
  await writeFile(
    registryPath,
    JSON.stringify({
      providers: [{
        id: providerId,
        version: "1.0.0",
        downloadUrl: `${providerId}.zip`,
        sha256: "a".repeat(64),
      }],
    }),
    "utf8",
  );
  await executeSubscriptionMutation(
    { operation: "add", id, url: registryPath, runtimeKind: "search" },
    true,
    env,
  );
  await refreshSubscriptions(id, env);
  const identity = await readIdentity(id, env);
  if (!identity) throw new Error(`missing fixture identity: ${id}`);
  const snapshot = await readCurrentRegistrySnapshot(id, identity, env);
  if (!snapshot) throw new Error(`missing fixture snapshot: ${id}`);
  return {
    sourceFingerprint: identity.sourceFingerprint,
    canonicalSource: identity.canonicalSource,
    registryDigest: snapshot.summary.registryDigest,
  };
}

async function writeProvider(options: {
  env: NodeJS.ProcessEnv;
  runtimeKind: ProviderRuntimeKind;
  id: string;
  receipt: "missing" | "malformed" | "mismatched" | "unbound" | "bound";
  binding?: { subscriptionId: string; sourceFingerprint: string; canonicalSource: string; registryDigest: string };
}): Promise<string> {
  const target = providerTargetPath(options.runtimeKind, options.id, options.env);
  await mkdir(target, { recursive: true });
  const manifest = options.runtimeKind === "search"
    ? {
        id: options.id,
        name: options.id,
        version: "1.0.0",
        sourceType: "academic",
        permissions: { urls: ["https://example.test/*"] },
      }
    : {
        id: options.id,
        name: options.id,
        version: "1.0.0",
        kind: "extractor",
        entry: "provider.js",
        capabilities: { inputs: ["url"], outputs: ["markdown"], network: false },
        permissions: { localRead: true, localWrite: "cache" },
      };
  const manifestText = JSON.stringify(manifest);
  const entryText = options.runtimeKind === "search"
    ? "globalThis.__zrs_exports={};"
    : "globalThis.__material_provider_exports={};";
  await writeFile(path.join(target, "manifest.json"), manifestText, "utf8");
  await writeFile(path.join(target, "provider.js"), entryText, "utf8");
  if (options.receipt === "missing") return target;
  if (options.receipt === "malformed") {
    await writeFile(path.join(target, PROVIDER_RECEIPT_FILENAME), "{not-json", "utf8");
    return target;
  }
  const bound = options.receipt === "bound";
  const now = "2026-07-14T00:00:00.000Z";
  const receipt: ProviderInstallReceipt = {
    schemaVersion: 1,
    runtimeKind: options.runtimeKind,
    providerKind: options.runtimeKind === "search" ? "academic" : "extractor",
    id: options.id,
    version: "1.0.0",
    installType: bound ? "registry" : "manual-zip",
    bound,
    archiveSha256: "b".repeat(64),
    manifestSha256: options.receipt === "mismatched" ? "0".repeat(64) : sha256Bytes(manifestText),
    entryPath: "provider.js",
    entrySha256: sha256Bytes(entryText),
    installedAt: now,
    updatedAt: now,
    ...(bound ? options.binding : {}),
  };
  await writeFile(
    path.join(target, PROVIDER_RECEIPT_FILENAME),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  return target;
}

async function writeLifecycleState(root: string): Promise<{
  env: NodeJS.ProcessEnv;
  compatibilityRoot: string;
  currentRegistry: string;
}> {
  const env = testEnv(root);
  const currentRegistry = path.join(root, "current-registry.json");
  const movingRegistry = path.join(root, "moving-registry.json");
  const replacementRegistry = path.join(root, "replacement-registry.json");
  const current = await addSubscription(env, "current-source", currentRegistry, "bound-good");
  const moving = await addSubscription(env, "moving-source", movingRegistry, "moving-provider");
  await writeFile(replacementRegistry, JSON.stringify({ providers: [] }), "utf8");
  const subscriptions = await readSubscriptionsFile(env);
  subscriptions.subscriptions["moving-source"]!.url = replacementRegistry;
  await writeFile(
    resolveSubscriptionPaths(env).subscriptionsFile,
    serializeSubscriptionsFile(subscriptions),
    "utf8",
  );

  await Promise.all([
    writeProvider({
      env,
      runtimeKind: "search",
      id: "bound-good",
      receipt: "bound",
      binding: { subscriptionId: "current-source", ...current },
    }),
    writeProvider({
      env,
      runtimeKind: "search",
      id: "moving-provider",
      receipt: "bound",
      binding: { subscriptionId: "moving-source", ...moving },
    }),
    writeProvider({ env, runtimeKind: "search", id: "alpha", receipt: "unbound" }),
    writeProvider({ env, runtimeKind: "material", id: "alpha", receipt: "unbound" }),
    writeProvider({ env, runtimeKind: "search", id: "missing-receipt", receipt: "missing" }),
    writeProvider({ env, runtimeKind: "material", id: "malformed-receipt", receipt: "malformed" }),
    writeProvider({ env, runtimeKind: "search", id: "mismatched-receipt", receipt: "mismatched" }),
  ]);

  const lifecyclePaths = resolveProviderLifecyclePaths(env);
  const subscriptionPaths = resolveSubscriptionPaths(env);
  await Promise.all([
    mkdir(lifecyclePaths.migrationStateDir, { recursive: true }),
    mkdir(subscriptionPaths.operationsDir, { recursive: true }),
    mkdir(path.join(subscriptionPaths.locksDir, "provider"), { recursive: true }),
  ]);
  await writeFile(
    path.join(lifecyclePaths.migrationStateDir, "provider-pending.json"),
    JSON.stringify({ schemaVersion: 1, operationId: "migration-op", providerId: "legacy", status: "selected" }),
  );
  await writeFile(path.join(lifecyclePaths.migrationStateDir, "provider-corrupt.json"), "{broken");
  await writeFile(
    path.join(subscriptionPaths.operationsDir, "pending.json"),
    JSON.stringify({ schemaVersion: 1, operationId: "registry-op", subscriptionId: "current-source", status: "pending" }),
  );
  await writeFile(
    path.join(subscriptionPaths.locksDir, "provider", "alpha.lock"),
    JSON.stringify({
      schemaVersion: 1,
      token: "fixture-token",
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: "2026-07-14T00:00:00.000Z",
    }),
  );
  await writeFile(path.join(subscriptionPaths.locksDir, "bad.lock"), "{broken");
  await writeFile(path.join(subscriptionPaths.locksDir, "old.lock.stale-fixture"), "quarantine");
  return { env, compatibilityRoot: lifecyclePaths.providersRoot, currentRegistry };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  if (roots.some((root) => path.resolve(process.cwd()).startsWith(path.resolve(root)))) {
    process.chdir(repositoryRoot);
  }
  await Promise.all(roots.map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })));
  roots.length = 0;
});

describe("provider lifecycle health reporting", () => {
  it("reconciles authoritative kind-separated providers, subscriptions, recovery, and locks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-health-"));
    roots.push(root);
    const fixture = await writeLifecycleState(root);

    const report = await inspectProviderLifecycleHealth(fixture.compatibilityRoot, fixture.env);
    expect(report.paths.authoritativeRoot).toBe(fixture.compatibilityRoot);
    expect(report.inventory).toMatchObject({
      status: "available",
      total: 7,
      duplicateGlobalIds: ["alpha"],
      receiptHealth: { healthy: 4, missing: 1, malformed: 1, mismatched: 1 },
      byKind: {
        search: { total: 5 },
        material: { total: 2 },
      },
    });
    expect(report.inventory.byKind.search.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bound-good", healthy: true, bindingStatus: "current" }),
      expect.objectContaining({ id: "moving-provider", healthy: false, bindingStatus: "rebind-pending" }),
      expect.objectContaining({ id: "missing-receipt", receiptStatus: "missing" }),
      expect.objectContaining({ id: "mismatched-receipt", receiptStatus: "mismatched" }),
    ]));
    expect(report.inventory.byKind.material.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "malformed-receipt", receiptStatus: "malformed" }),
    ]));
    expect(report.subscriptions).toMatchObject({
      status: "available",
      total: 2,
      rebindPendingIds: ["moving-source"],
    });
    expect(report.subscriptions.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "current-source", snapshot: expect.objectContaining({ status: "current" }) }),
      expect.objectContaining({ id: "moving-source", snapshot: { status: "rebind-pending" } }),
    ]));
    expect(report.recovery.providerMigrations).toMatchObject({ pending: [{ subjectId: "legacy", status: "selected" }] });
    expect(report.recovery.providerMigrations.corrupt).toHaveLength(1);
    expect(report.recovery.registryOperations.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: "current-source", status: "pending" }),
    ]));
    expect(report.locks.observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "provider/alpha", valid: true }),
      expect.objectContaining({ scope: "bad", valid: false }),
    ]));
    expect(report.locks.recoveryArtifacts).toHaveLength(1);
    expect(report.health.status).toBe("unhealthy");
    expect(report.health.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "duplicate-provider-ids",
      "provider-integrity",
      "unbound-providers",
      "subscriptions-rebind-pending",
      "provider-migration-pending",
      "provider-migration-pending-corrupt",
      "registry-operation-pending",
      "lifecycle-locks-corrupt",
      "lock-recovery-artifacts",
    ]));
  });

  it("surfaces lifecycle reconciliation through doctor while status remains informational", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-health-command-"));
    roots.push(root);
    const fixture = await writeLifecycleState(root);
    const workspace = path.join(root, "workspace");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${tomlPath(fixture.compatibilityRoot)}"`,
        `registryUrl = "${tomlPath(fixture.currentRegistry)}"`,
        "",
        "[workspace]",
        `root = "${tomlPath(workspace)}"`,
        "",
      ].join("\n"),
      "utf8",
    );
    for (const [name, value] of Object.entries(fixture.env)) {
      if (value !== undefined && [
        "APPDATA", "HOME", "USERPROFILE", "LOCALAPPDATA",
        "PAPER_SEARCH_INSTALL_TEST_MODE", "PAPER_SEARCH_TEST_DATA_ROOT",
      ].includes(name)) vi.stubEnv(name, value);
    }
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      let stdout = "";
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write() {} },
      }).parseAsync(["node", "paper-search", "status", "--json"]);
      const status = JSON.parse(stdout);
      expect(status.data.providerLifecycle).toMatchObject({
        inventory: { total: 7, duplicateGlobalIds: ["alpha"] },
        health: { status: "unhealthy" },
      });
      expect(status.diagnostics.authoritativeProviderCounts).toEqual({ search: 5, material: 2 });
      expect(status.warnings?.some((warning: string) => warning.startsWith("Provider lifecycle"))).toBeFalsy();

      stdout = "";
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write() {} },
      }).parseAsync(["node", "paper-search", "doctor"]);
      const doctor = JSON.parse(stdout);
      expect(doctor.data.providerLifecycle.health.status).toBe("unhealthy");
      expect(doctor.diagnostics.providerLifecycleHealth).toBe("unhealthy");
      expect(doctor.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("Provider lifecycle duplicate-provider-ids"),
        expect.stringContaining("Provider lifecycle provider-integrity"),
      ]));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("reports absent and corrupt lifecycle state without throwing or writing recovery state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-health-corrupt-"));
    roots.push(root);
    const env = testEnv(root);
    const paths = resolveSubscriptionPaths(env);
    await mkdir(path.dirname(paths.subscriptionsFile), { recursive: true });
    await writeFile(paths.subscriptionsFile, "not-valid = [", "utf8");

    const report = await inspectProviderLifecycleHealth(path.join(root, "legacy"), env);
    expect(report.inventory).toMatchObject({ status: "available", total: 0 });
    expect(report.subscriptions).toMatchObject({ status: "unavailable", total: 0 });
    expect(report.health.status).toBe("unavailable");
    expect(report.health.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "subscription-state-unavailable", severity: "error" }),
    ]));
    await expect(readFile(path.join(root, "data", "state", "migrations", "provider-any.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
