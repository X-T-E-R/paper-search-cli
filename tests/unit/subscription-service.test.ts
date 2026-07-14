import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "@iarna/toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfigBundlePaths } from "../../src/config/paths.js";
import { identityPath, resolveSubscriptionPaths, tombstonesPath } from "../../src/subscriptions/paths.js";
import {
  executeSubscriptionMutation,
  listSubscriptions,
  refreshSubscriptions,
  showSubscription,
} from "../../src/subscriptions/service.js";
import { canonicalizeRegistrySource } from "../../src/subscriptions/source.js";
import { fetchAndValidateRegistry } from "../../src/subscriptions/registry.js";

const roots: string[] = [];

function testEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPDATA: path.join(root, "appdata"),
    PAPER_SEARCH_INSTALL_TEST_MODE: "1",
    PAPER_SEARCH_TEST_DATA_ROOT: path.join(root, "data"),
  };
}

async function registry(root: string, name: string, providers: unknown[]): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, JSON.stringify({ providers }), "utf8");
  return file;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("registry subscriptions", () => {
  it("canonicalizes exact sources and rejects unsafe identities", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-source-"));
    roots.push(root);
    const local = await registry(root, "registry.json", []);
    const first = await canonicalizeRegistrySource(local, "search");
    const second = await canonicalizeRegistrySource(local, "search");
    expect(first.sourceFingerprint).toBe(second.sourceFingerprint);
    expect(first.sourceType).toBe("local");
    await expect(canonicalizeRegistrySource("http://example.test/registry.json", "search")).rejects.toThrow(/HTTPS/);
    await expect(canonicalizeRegistrySource("https://example.test/registry", "search")).rejects.toThrow(/exact JSON/);
    await expect(canonicalizeRegistrySource("https://example.test/registry.json?token=secret", "search")).rejects.toThrow(/credential-like/);
    await expect(canonicalizeRegistrySource("https://example.test/registry.json?apikey=secret", "search")).rejects.toThrow(/credential-like/);
  });

  it("rejects an HTTPS registry redirect that downgrades on an intermediate hop", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "http://registry.example.test/insecure.json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAndValidateRegistry({
      schemaVersion: 1,
      subscriptionId: "official-search",
      runtimeKind: "search",
      sourceType: "https",
      canonicalSource: "https://registry.example.test/registry.json",
      sourceFingerprint: "a".repeat(64),
      configuredUrlDigest: "b".repeat(64),
      createdAt: new Date().toISOString(),
      latestRegistryDigest: null,
    })).rejects.toThrow(/remain on HTTPS/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a safe HTTPS registry redirect and records the resolved source", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const url = String(input);
      if (url.startsWith("https://registry.example.test/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.test/releases/registry.json" },
        });
      }
      return new Response(JSON.stringify({ providers: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAndValidateRegistry({
      schemaVersion: 1,
      subscriptionId: "official-search",
      runtimeKind: "search",
      sourceType: "https",
      canonicalSource: "https://registry.example.test/registry.json",
      sourceFingerprint: "a".repeat(64),
      configuredUrlDigest: "b".repeat(64),
      createdAt: new Date().toISOString(),
      latestRegistryDigest: null,
    })).resolves.toMatchObject({
      resolvedSource: "https://cdn.example.test/releases/registry.json",
      candidates: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("plans before writing, stores hashed identity state, and detects direct URL edits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-subscription-"));
    roots.push(root);
    const env = testEnv(root);
    const first = await registry(root, "first.json", []);
    const second = await registry(root, "second.json", []);

    const planned = await executeSubscriptionMutation(
      { operation: "add", id: "alpha-search", url: first, runtimeKind: "search" },
      false,
      env,
    );
    expect(planned.applied).toBe(false);
    await expect(readFile(resolveConfigBundlePaths(env).subscriptions, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await executeSubscriptionMutation(
      { operation: "add", id: "alpha-search", url: first, runtimeKind: "search" },
      true,
      env,
    );
    expect(await readFile(identityPath("alpha-search", env), "utf8")).toContain('"subscriptionId": "alpha-search"');
    expect(path.basename(identityPath("alpha-search", env))).not.toContain("alpha-search");
    expect((await listSubscriptions(env))).toMatchObject([{ id: "alpha-search", status: "active" }]);

    const configPath = resolveConfigBundlePaths(env).subscriptions;
    const document = parse(await readFile(configPath, "utf8")) as Record<string, any>;
    document.subscriptions["alpha-search"].url = second;
    await writeFile(configPath, stringify(document as never), "utf8");
    expect((await showSubscription("alpha-search", env)).status).toBe("rebind-pending");
    await expect(
      executeSubscriptionMutation({ operation: "enable", id: "alpha-search" }, false, env),
    ).rejects.toThrow(/requires rebind/);
    await expect(
      executeSubscriptionMutation({ operation: "disable", id: "alpha-search" }, true, env),
    ).resolves.toMatchObject({ applied: true });
    expect((await showSubscription("alpha-search", env)).status).toBe("rebind-pending");
    await rm(first);
    expect((await listSubscriptions(env))[0]).toMatchObject({ id: "alpha-search", status: "rebind-pending" });
    await executeSubscriptionMutation({ operation: "remove", id: "alpha-search" }, true, env);
    expect(await listSubscriptions(env)).toEqual([]);
    expect(JSON.parse(await readFile(tombstonesPath("alpha-search", env), "utf8"))).toHaveLength(1);
  });

  it("blocks dependent rebinds unless orphaning is explicit and retains a tombstone", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-dependent-"));
    roots.push(root);
    const env = testEnv(root);
    const first = await registry(root, "first.json", []);
    const second = await registry(root, "second.json", []);
    await executeSubscriptionMutation(
      { operation: "add", id: "bound", url: first, runtimeKind: "search" },
      true,
      env,
    );
    const identity = JSON.parse(await readFile(identityPath("bound", env), "utf8"));
    const providerDir = path.join(resolveSubscriptionPaths(env).providersDir, "search", "alpha");
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      path.join(providerDir, "receipt.json"),
      JSON.stringify({ providerId: "alpha", subscriptionId: "bound", sourceFingerprint: identity.sourceFingerprint }),
    );

    await expect(
      executeSubscriptionMutation({ operation: "rebind", id: "bound", url: second }, false, env),
    ).rejects.toThrow(/--orphan-dependents/);
    await executeSubscriptionMutation(
      { operation: "rebind", id: "bound", url: second, orphanDependents: true },
      true,
      env,
    );
    const tombstones = JSON.parse(await readFile(tombstonesPath("bound", env), "utf8"));
    expect(tombstones).toMatchObject([{ reason: "rebind", dependentIds: ["alpha"] }]);
  });

  it("reconfirms an equivalent canonical source without orphaning dependents or discarding its snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-equivalent-rebind-"));
    roots.push(root);
    const env = testEnv(root);
    const source = await registry(root, "registry.json", []);
    await executeSubscriptionMutation(
      { operation: "add", id: "bound", url: source, runtimeKind: "search" },
      true,
      env,
    );
    await refreshSubscriptions("bound", env);
    const before = JSON.parse(await readFile(identityPath("bound", env), "utf8"));
    const providerDir = path.join(resolveSubscriptionPaths(env).providersDir, "search", "alpha");
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      path.join(providerDir, "receipt.json"),
      JSON.stringify({ providerId: "alpha", subscriptionId: "bound", sourceFingerprint: before.sourceFingerprint }),
    );

    const equivalentUrl = pathToFileURL(source).toString();
    await expect(executeSubscriptionMutation(
      { operation: "rebind", id: "bound", url: equivalentUrl },
      true,
      env,
    )).resolves.toMatchObject({ applied: true, plan: { dependents: [] } });

    const after = JSON.parse(await readFile(identityPath("bound", env), "utf8"));
    expect(after).toMatchObject({
      sourceFingerprint: before.sourceFingerprint,
      latestRegistryDigest: before.latestRegistryDigest,
      createdAt: before.createdAt,
    });
    expect(after.configuredUrlDigest).not.toBe(before.configuredUrlDigest);
    await expect(readFile(tombstonesPath("bound", env), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(showSubscription("bound", env)).resolves.toMatchObject({ status: "active" });
  });

  it("blocks trust changes when dependent receipts outlive missing identity state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-missing-identity-"));
    roots.push(root);
    const env = testEnv(root);
    const first = await registry(root, "first.json", []);
    const second = await registry(root, "second.json", []);
    await executeSubscriptionMutation(
      { operation: "add", id: "bound", url: first, runtimeKind: "search" },
      true,
      env,
    );
    const identity = JSON.parse(await readFile(identityPath("bound", env), "utf8"));
    const providerDir = path.join(resolveSubscriptionPaths(env).providersDir, "search", "alpha");
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      path.join(providerDir, "receipt.json"),
      JSON.stringify({ providerId: "alpha", subscriptionId: "bound", sourceFingerprint: identity.sourceFingerprint }),
    );
    await rm(identityPath("bound", env));

    await expect(executeSubscriptionMutation(
      { operation: "rebind", id: "bound", url: second, orphanDependents: true },
      false,
      env,
    )).rejects.toThrow(/old origin cannot be tombstoned safely/);
    await expect(executeSubscriptionMutation(
      { operation: "enable", id: "bound" },
      false,
      env,
    )).rejects.toThrow(/requires rebind/);
  });

  it("refreshes explicit metadata into a content-addressed snapshot without installing providers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-refresh-"));
    roots.push(root);
    const env = testEnv(root);
    const source = await registry(root, "registry.json", [
      { id: "verified", version: "1.0.0", downloadUrl: "verified.zip", sha256: "a".repeat(64) },
      { id: "legacy", version: "1.0.0", downloadUrl: "legacy.zip" },
    ]);
    await executeSubscriptionMutation(
      { operation: "add", id: "refreshable", url: source, runtimeKind: "search" },
      true,
      env,
    );
    const [summary] = await refreshSubscriptions("refreshable", env);
    expect(summary).toBeDefined();
    if (!summary) throw new Error("missing refresh summary");
    expect(summary.candidates).toEqual([
      expect.objectContaining({ id: "verified", status: "available", archiveSha256: "a".repeat(64) }),
      expect.objectContaining({ id: "legacy", status: "blocked", blockedReason: "missing-integrity" }),
    ]);
    const current = path.join(
      resolveSubscriptionPaths(env).cacheDir,
      summary.sourceFingerprint,
      "current.json",
    );
    expect(JSON.parse(await readFile(current, "utf8"))).toMatchObject({ registryDigest: summary.registryDigest });
    const currentBeforeFailure = await readFile(current, "utf8");
    await expect(readFile(path.join(resolveSubscriptionPaths(env).providersDir, "search", "verified", "manifest.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const materialSource = await registry(root, "material.json", [
      {
        id: "extractor",
        version: "1.0.0",
        kind: "extractor",
        archiveRef: "extractor.zip",
        checksum: { sha256: "d".repeat(64) },
      },
    ]);
    await executeSubscriptionMutation(
      { operation: "add", id: "material-local", url: materialSource, runtimeKind: "material" },
      true,
      env,
    );
    await expect(refreshSubscriptions("material-local", env)).resolves.toMatchObject([
      { runtimeKind: "material", candidates: [{ id: "extractor", status: "available" }] },
    ]);

    await writeFile(source, JSON.stringify({ providers: [
      { id: "duplicate", version: "1.0.0", downloadUrl: "a.zip", sha256: "b".repeat(64) },
      { id: "duplicate", version: "2.0.0", downloadUrl: "b.zip", sha256: "c".repeat(64) },
    ] }));
    await expect(refreshSubscriptions("refreshable", env)).rejects.toThrow(/duplicate provider id/);
    await expect(readFile(current, "utf8")).resolves.toBe(currentBeforeFailure);
  });

  it("restores subscription identity when the validated snapshot pointer cannot advance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-refresh-rollback-"));
    roots.push(root);
    const env = testEnv(root);
    const source = await registry(root, "registry.json", []);
    await executeSubscriptionMutation(
      { operation: "add", id: "rollback", url: source, runtimeKind: "search" },
      true,
      env,
    );
    const identityFile = identityPath("rollback", env);
    const before = await readFile(identityFile, "utf8");
    const identity = JSON.parse(before) as { sourceFingerprint: string };
    const current = path.join(
      resolveSubscriptionPaths(env).cacheDir,
      identity.sourceFingerprint,
      "current.json",
    );
    await mkdir(current, { recursive: true });

    await expect(refreshSubscriptions("rollback", env)).rejects.toThrow();
    await expect(readFile(identityFile, "utf8")).resolves.toBe(before);
    await expect(lstat(current)).resolves.toMatchObject({});
    expect((await lstat(current)).isDirectory()).toBe(true);
  });
});
