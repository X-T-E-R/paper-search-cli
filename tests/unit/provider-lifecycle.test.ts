import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import {
  listAvailableProviders,
  listAvailableSearchInventory,
} from "../../src/providers/catalog.js";
import { listInstalledMaterialProviders } from "../../src/material/registry/plan.js";
import { listInstalledProviders } from "../../src/providers/registry/sync.js";
import {
  applyProviderLifecyclePlan,
  executeProviderInstall,
  executeProviderUpdates,
  planProviderInstall,
} from "../../src/providers/lifecycle.js";
import { PROVIDER_RECEIPT_FILENAME } from "../../src/providers/install/manualZip.js";
import { providerTargetPath, resolveProviderLifecyclePaths } from "../../src/providers/paths.js";
import { listProviderSelectionCandidates } from "../../src/search/candidates.js";
import { resolveProviderSelection } from "../../src/search/selection.js";
import {
  executeSubscriptionMutation,
  refreshSubscriptions,
} from "../../src/subscriptions/service.js";

const roots: string[] = [];

function testEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPDATA: path.join(root, "appdata"),
    PAPER_SEARCH_INSTALL_TEST_MODE: "1",
    PAPER_SEARCH_TEST_DATA_ROOT: path.join(root, "data"),
  };
}

async function searchArchive(
  outputPath: string,
  id: string,
  version: string,
  marker = version,
): Promise<string> {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    id,
    name: id,
    version,
    sourceType: "academic",
    permissions: { urls: ["https://example.test/*"] },
  }));
  zip.file("provider.js", `globalThis.__zrs_exports={marker:${JSON.stringify(marker)}};`);
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(outputPath, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

async function materialArchive(outputPath: string, id: string, version: string): Promise<string> {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    id,
    name: id,
    version,
    kind: "extractor",
    entry: "provider.js",
    capabilities: { inputs: ["url"], outputs: ["markdown"], network: false },
    permissions: { localRead: true, localWrite: "cache" },
  }));
  zip.file("provider.js", "globalThis.__material_provider_exports={};");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(outputPath, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeRegistry(
  registryPath: string,
  entries: Array<{ id: string; version: string; downloadUrl: string; sha256?: string }>,
  inventory: unknown[] = [],
): Promise<void> {
  await writeFile(registryPath, JSON.stringify({ providers: entries, inventory }), "utf8");
}

async function addAndRefresh(
  env: NodeJS.ProcessEnv,
  id: string,
  registryPath: string,
): Promise<void> {
  await executeSubscriptionMutation(
    { operation: "add", id, url: registryPath, runtimeKind: "search" },
    true,
    env,
  );
  await refreshSubscriptions(id, env);
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("subscription-bound provider lifecycle", () => {
  it("retains validated search inventory metadata from active snapshots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-inventory-catalog-"));
    roots.push(root);
    const env = testEnv(root);
    const registryDir = path.join(root, "registry");
    await mkdir(registryDir);
    const registryPath = path.join(registryDir, "registry.json");
    await writeRegistry(
      registryPath,
      [{
        id: "alpha",
        version: "1.0.0",
        downloadUrl: "alpha.zip",
        sha256: "a".repeat(64),
      }, {
        id: "beta",
        version: "1.0.0",
        downloadUrl: "beta.zip",
        sha256: "b".repeat(64),
      }],
      [
        {
          id: "alpha",
          kind: "search",
          sourceType: "academic",
          entryKind: "source",
          sourceId: "example.alpha",
          aliases: ["a"],
          serviceFamily: "example.api",
          transport: "api",
          domains: ["multidisciplinary"],
          contentKinds: ["journal-article"],
          access: ["public"],
          selection: { defaultInAll: false },
          publication: { status: "published" },
        },
        {
          id: "beta",
          kind: "search",
          sourceType: "academic",
          entryKind: "source",
          sourceId: "example.beta",
          serviceFamily: "example.api",
          transport: "api",
          domains: ["multidisciplinary"],
          contentKinds: ["journal-article"],
          access: ["public"],
          selection: { defaultInAll: false },
          publication: { status: "published" },
        },
        {
          id: "retained",
          kind: "search",
          sourceType: "academic",
          entryKind: "source",
          sourceId: "example.retained",
          serviceFamily: "example.retained-html",
          transport: "html",
          domains: ["multidisciplinary"],
          contentKinds: ["journal-article"],
          access: ["public"],
          selection: { defaultInAll: false },
          publication: { status: "retained-unpublished", blockers: ["fixture"] },
        },
      ],
    );
    await addAndRefresh(env, "searches", registryPath);

    const catalog = await listAvailableSearchInventory(env);
    expect(catalog.issues).toEqual([]);
    expect(catalog.entries).toMatchObject([
      {
        id: "alpha",
        version: "1.0.0",
        subscriptionId: "searches",
        ambiguous: false,
        sourceCount: 1,
        inventory: {
          aliases: ["a"],
          domains: ["multidisciplinary"],
          publication: { status: "published" },
        },
      },
      {
        id: "beta",
        version: "1.0.0",
        subscriptionId: "searches",
      },
    ]);

    const config: ResolvedConfig = {
      ...structuredClone(DEFAULT_CONFIG),
      providers: {
        ...structuredClone(DEFAULT_CONFIG.providers),
        installDir: path.join(root, "empty-providers"),
      },
      meta: {
        cwd: root,
        userConfigPath: path.join(root, "config.toml"),
        projectConfigPath: null,
        explicitConfigPath: null,
        loadedFiles: [],
        appliedEnvOverrides: [],
      },
    };
    const invalidProviderDir = path.join(config.providers.installDir, "search", "beta");
    await mkdir(invalidProviderDir, { recursive: true });
    await writeFile(path.join(invalidProviderDir, "manifest.json"), "not-json", "utf8");
    const selectionCandidates = await listProviderSelectionCandidates(config, env);
    expect(selectionCandidates.candidates).toMatchObject([
      { id: "alpha", installed: false, valid: true },
      { id: "beta", installed: true, valid: false },
    ]);
    expect(selectionCandidates.candidates.find((entry) => entry.id === "beta")?.manifest)
      .toBeUndefined();
    expect(selectionCandidates.warnings).toContain(
      "Installed provider beta is invalid; registry classification was ignored",
    );
    expect(
      resolveProviderSelection(config, "academic", selectionCandidates.candidates),
    ).toMatchObject({
      selectedProviderIds: ["alpha"],
      runnableProviderIds: [],
      skippedProviderIds: ["alpha"],
    });
  });

  it("installs material archives into a kind-separated data-root location", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-bound-material-"));
    roots.push(root);
    const env = testEnv(root);
    const registryDir = path.join(root, "material-registry");
    await mkdir(registryDir);
    const archiveSha256 = await materialArchive(path.join(registryDir, "extractor.zip"), "extractor", "1.0.0");
    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(registryPath, JSON.stringify({ providers: [{
      id: "extractor",
      version: "1.0.0",
      kind: "extractor",
      archiveRef: "extractor.zip",
      sha256: archiveSha256,
      minCliVersion: "0.1.0",
    }] }));
    await executeSubscriptionMutation(
      { operation: "add", id: "materials", url: registryPath, runtimeKind: "material" },
      true,
      env,
    );
    await refreshSubscriptions("materials", env);
    const applied = await executeProviderInstall("extractor", { from: "materials", apply: true, env });
    expect(applied).toMatchObject({
      applied: true,
      plan: { runtimeKind: "material", providerKind: "extractor" },
      receipt: {
        installType: "registry",
        bound: true,
        runtimeKind: "material",
        providerKind: "extractor",
        archiveSha256,
      },
    });
    await expect(access(path.join(root, "data", "providers", "extractor")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(providerTargetPath("material", "extractor", env))).resolves.toBeUndefined();
    await expect(listInstalledMaterialProviders(resolveProviderLifecyclePaths(env).providersRoot))
      .resolves.toMatchObject([{ id: "extractor", valid: true }]);

    const searchDir = path.join(root, "search-registry");
    await mkdir(searchDir);
    const searchSha256 = await searchArchive(path.join(searchDir, "extractor.zip"), "extractor", "2.0.0");
    const searchRegistry = path.join(searchDir, "registry.json");
    await writeRegistry(searchRegistry, [{
      id: "extractor",
      version: "2.0.0",
      downloadUrl: "extractor.zip",
      sha256: searchSha256,
    }]);
    await addAndRefresh(env, "searches", searchRegistry);
    await expect(planProviderInstall("extractor", { from: "searches", env }))
      .resolves.toMatchObject({
        action: "blocked",
        reason: expect.stringContaining("material"),
      });
  });

  it("aggregates duplicate ids, requires --from, and installs a source-bound receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-bound-provider-"));
    roots.push(root);
    const env = testEnv(root);
    const firstDir = path.join(root, "first");
    const secondDir = path.join(root, "second");
    await Promise.all([mkdir(firstDir), mkdir(secondDir)]);
    const firstHash = await searchArchive(path.join(firstDir, "alpha.zip"), "alpha", "1.0.0", "first");
    const secondHash = await searchArchive(path.join(secondDir, "alpha.zip"), "alpha", "9.0.0", "second");
    const firstRegistry = path.join(firstDir, "registry.json");
    const secondRegistry = path.join(secondDir, "registry.json");
    await writeRegistry(firstRegistry, [{ id: "alpha", version: "1.0.0", downloadUrl: "alpha.zip", sha256: firstHash }]);
    await writeRegistry(secondRegistry, [{ id: "alpha", version: "9.0.0", downloadUrl: "alpha.zip", sha256: secondHash }]);
    await addAndRefresh(env, "source-one", firstRegistry);
    await addAndRefresh(env, "source-two", secondRegistry);

    const catalog = await listAvailableProviders(undefined, env);
    expect(catalog.candidates).toMatchObject([
      { id: "alpha", subscriptionId: "source-one", ambiguous: true, sourceCount: 2 },
      { id: "alpha", subscriptionId: "source-two", ambiguous: true, sourceCount: 2 },
    ]);
    await expect(planProviderInstall("alpha", { env })).rejects.toThrow(/--from/);

    const planned = await executeProviderInstall("alpha", { from: "source-one", env });
    expect(planned).toMatchObject({
      applied: false,
      plan: {
        action: "install",
        binding: {
          subscriptionId: "source-one",
          sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          registryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        archive: { archiveSha256: firstHash },
        installedStatePrecondition: {
          search: { state: "absent" },
          material: { state: "absent" },
          legacy: { state: "absent" },
        },
      },
    });
    await expect(access(providerTargetPath("search", "alpha", env))).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await applyProviderLifecyclePlan(planned.plan, env);
    expect(applied).toMatchObject({ applied: true, result: { id: "alpha", version: "1.0.0" } });
    const receipt = JSON.parse(await readFile(
      path.join(providerTargetPath("search", "alpha", env), PROVIDER_RECEIPT_FILENAME),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      installType: "registry",
      bound: true,
      runtimeKind: "search",
      id: "alpha",
      version: "1.0.0",
      subscriptionId: "source-one",
      sourceFingerprint: planned.plan.binding?.sourceFingerprint,
      registryDigest: planned.plan.binding?.registryDigest,
      archiveSha256: firstHash,
    });
    await expect(listInstalledProviders(resolveProviderLifecyclePaths(env).providersRoot))
      .resolves.toMatchObject([{ id: "alpha", valid: true }]);
    await expect(executeProviderUpdates(["alpha"], { env })).resolves.toMatchObject({
      plan: { plans: [{ action: "skip", version: "1.0.0", binding: { subscriptionId: "source-one" } }] },
    });
    const otherSource = await planProviderInstall("alpha", { from: "source-two", env });
    expect(otherSource).toMatchObject({ action: "blocked", reason: expect.stringContaining("already installed") });
  });

  it("blocks hashless bound installs and rejects a stale registry pin without writing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-bound-stale-"));
    roots.push(root);
    const env = testEnv(root);
    const registryDir = path.join(root, "registry");
    await mkdir(registryDir);
    const firstHash = await searchArchive(path.join(registryDir, "alpha-v1.zip"), "alpha", "1.0.0");
    const secondHash = await searchArchive(path.join(registryDir, "alpha-v2.zip"), "alpha", "2.0.0");
    const registryPath = path.join(registryDir, "registry.json");
    await writeRegistry(registryPath, [
      { id: "alpha", version: "1.0.0", downloadUrl: "alpha-v1.zip", sha256: firstHash },
      { id: "legacy", version: "1.0.0", downloadUrl: "legacy.zip" },
    ]);
    await addAndRefresh(env, "source", registryPath);

    const hashless = await planProviderInstall("legacy", { from: "source", env });
    expect(hashless).toMatchObject({ action: "blocked", reason: "missing-integrity", archive: null });
    await expect(executeProviderInstall("legacy", { from: "source", apply: true, env }))
      .resolves.toMatchObject({ applied: false, plan: { action: "blocked" } });

    const stale = await planProviderInstall("alpha", { from: "source", env });
    const tampered = { ...stale, currentCliVersion: "999.0.0" };
    await expect(applyProviderLifecyclePlan(tampered, env)).rejects.toThrow(/plan digest mismatch/);
    await expect(access(providerTargetPath("search", "alpha", env))).rejects.toMatchObject({ code: "ENOENT" });
    await writeRegistry(registryPath, [
      { id: "alpha", version: "2.0.0", downloadUrl: "alpha-v2.zip", sha256: secondHash },
    ]);
    await refreshSubscriptions("source", env);
    await expect(applyProviderLifecyclePlan(stale, env)).rejects.toThrow(/registry snapshot changed|source or registry snapshot changed/);
    await expect(access(providerTargetPath("search", "alpha", env))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent applies on the globally unique provider id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-bound-concurrent-"));
    roots.push(root);
    const env = testEnv(root);
    const registryDir = path.join(root, "registry");
    await mkdir(registryDir);
    const archiveSha256 = await searchArchive(path.join(registryDir, "alpha.zip"), "alpha", "1.0.0");
    const registryPath = path.join(registryDir, "registry.json");
    await writeRegistry(registryPath, [
      { id: "alpha", version: "1.0.0", downloadUrl: "alpha.zip", sha256: archiveSha256 },
    ]);
    await addAndRefresh(env, "source", registryPath);
    const plan = await planProviderInstall("alpha", { from: "source", env });
    const outcomes = await Promise.allSettled([
      applyProviderLifecyclePlan(plan, env),
      applyProviderLifecyclePlan(plan, env),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringContaining("changed after planning") }),
    });
  });

  it("updates only from the receipt origin and reports event-ledger failure without rollback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-bound-update-"));
    roots.push(root);
    const env = testEnv(root);
    const registryDir = path.join(root, "registry");
    await mkdir(registryDir);
    const firstHash = await searchArchive(path.join(registryDir, "alpha-v1.zip"), "alpha", "1.0.0", "v1");
    const secondHash = await searchArchive(path.join(registryDir, "alpha-v2.zip"), "alpha", "2.0.0", "v2");
    const registryPath = path.join(registryDir, "registry.json");
    await writeRegistry(registryPath, [
      { id: "alpha", version: "1.0.0", downloadUrl: "alpha-v1.zip", sha256: firstHash },
    ]);
    await addAndRefresh(env, "bound-source", registryPath);
    await executeProviderInstall("alpha", { from: "bound-source", apply: true, env });

    await writeRegistry(registryPath, [
      { id: "alpha", version: "2.0.0", downloadUrl: "alpha-v2.zip", sha256: secondHash },
    ]);
    await refreshSubscriptions("bound-source", env);
    const planned = await executeProviderUpdates(["alpha"], { env });
    expect(planned.plan.plans).toMatchObject([{
      action: "update",
      installedVersion: "1.0.0",
      version: "2.0.0",
      binding: { subscriptionId: "bound-source" },
      archive: { archiveSha256: secondHash },
    }]);

    const eventDir = path.join(resolveProviderLifecyclePaths(env).providersRoot, "..", "state", "events");
    await rm(eventDir, { recursive: true, force: true });
    await mkdir(path.dirname(eventDir), { recursive: true });
    await writeFile(eventDir, "blocks event directory", "utf8");
    const applied = await executeProviderUpdates(["alpha"], { apply: true, env });
    expect(applied).toMatchObject({
      results: [{ applied: true, result: { id: "alpha", version: "2.0.0" } }],
      auditWarnings: [expect.stringContaining("lifecycle event could not be recorded")],
    });
    const receipt = JSON.parse(await readFile(
      path.join(providerTargetPath("search", "alpha", env), PROVIDER_RECEIPT_FILENAME),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      subscriptionId: "bound-source",
      version: "2.0.0",
      archiveSha256: secondHash,
    });
  });

  it("blocks updates when a provider directory name no longer matches its manifest identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-directory-drift-"));
    roots.push(root);
    const env = testEnv(root);
    const registryDir = path.join(root, "registry");
    await mkdir(registryDir);
    const archiveSha256 = await searchArchive(path.join(registryDir, "alpha.zip"), "alpha", "1.0.0");
    const registryPath = path.join(registryDir, "registry.json");
    await writeRegistry(registryPath, [
      { id: "alpha", version: "1.0.0", downloadUrl: "alpha.zip", sha256: archiveSha256 },
    ]);
    await addAndRefresh(env, "bound-source", registryPath);
    await executeProviderInstall("alpha", { from: "bound-source", apply: true, env });
    await rename(
      providerTargetPath("search", "alpha", env),
      providerTargetPath("search", "wrong-folder", env),
    );

    const planned = await executeProviderUpdates(["alpha"], { env });
    expect(planned.plan.plans).toMatchObject([{
      action: "blocked",
      reason: expect.stringContaining("directory name wrong-folder differs from manifest id alpha"),
    }]);
    await expect(planProviderInstall("alpha", { from: "bound-source", env })).resolves.toMatchObject({
      action: "blocked",
      reason: expect.stringContaining("already installed in the global namespace"),
    });
  });
});
