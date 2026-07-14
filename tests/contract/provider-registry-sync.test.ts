import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { loadRegistryManifest } from "../../src/providers/registry/load.js";
import {
  applyRegistrySync,
  listInstalledProviders,
  planRegistrySync,
} from "../../src/providers/registry/sync.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirs.map(async (dir) => {
      try {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
      } catch {
        // ignore cleanup failures
      }
    }),
  );
  tempDirs.length = 0;
});

async function createProviderZip(
  outputPath: string,
  id: string,
  version: string,
  options: { nested?: boolean } = {},
): Promise<void> {
  const zip = new JSZip();
  const prefix = options.nested ? `${id}/` : "";
  zip.file(
    `${prefix}manifest.json`,
    JSON.stringify(
      {
        id,
        name: id,
        version,
        sourceType: "academic",
        permissions: { urls: ["https://example.com/*"] },
      },
      null,
      2,
    ),
  );
  zip.file(
    `${prefix}provider.js`,
    "var __zrs_exports={createProvider(){return {async search(query){return {platform:'test',query,totalResults:0,items:[],page:1};}}}};globalThis.__zrs_exports=__zrs_exports;",
  );
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(outputPath, bytes);
}

describe("provider registry sync", () => {
  it("rejects registry ids that cannot be safe provider directory names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registry-invalid-id-"));
    tempDirs.push(root);
    const registryPath = path.join(root, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        providers: [{ id: "../outside", version: "1.0.0", downloadUrl: "./outside.zip" }],
      }),
      "utf8",
    );

    await expect(loadRegistryManifest(registryPath)).rejects.toThrow();
  });

  it("rejects duplicate ids within one search registry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registry-duplicate-id-"));
    tempDirs.push(root);
    const registryPath = path.join(root, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        providers: [
          { id: "alpha", version: "1.0.0", downloadUrl: "./alpha-v1.zip" },
          { id: "alpha", version: "2.0.0", downloadUrl: "./alpha-v2.zip" },
        ],
      }),
      "utf8",
    );

    await expect(loadRegistryManifest(registryPath)).rejects.toThrow(/duplicate provider id: alpha/);
  });

  it("masks remote registry credentials when a network request fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("simulated network failure");
    });
    let failure: unknown;
    try {
      await loadRegistryManifest(
        "https://registry.example.test/registry.json?token=top-secret",
      );
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("token=%3Cmasked%3E");
    expect(String(failure)).toContain("request failed");
    expect(String(failure)).not.toContain("top-secret");
  });

  it("plans against a missing install directory without creating it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registry-read-only-plan-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const registryPath = path.join(root, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        providers: [{ id: "alpha", version: "1.0.0", downloadUrl: "./alpha.zip" }],
      }),
      "utf8",
    );

    const plan = await planRegistrySync({
      registry: await loadRegistryManifest(registryPath),
      installDir,
      currentVersion: "1.0.0",
    });

    expect(plan.entries).toEqual([
      expect.objectContaining({ id: "alpha", action: "install", reason: "not installed" }),
    ]);
    await expect(access(installDir)).rejects.toBeDefined();
  });

  it("plans install, update, skip, and blocked actions from a local registry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registry-plan-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const searchInstallDir = path.join(installDir, "search");
    const registryDir = path.join(root, "registry");
    await mkdir(searchInstallDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });

    await mkdir(path.join(searchInstallDir, "up-to-date"), { recursive: true });
    await writeFile(
      path.join(searchInstallDir, "up-to-date", "manifest.json"),
      JSON.stringify({
        id: "up-to-date",
        name: "up-to-date",
        version: "1.0.0",
        sourceType: "academic",
        permissions: { urls: ["https://example.com/*"] },
      }),
    );
    await writeFile(path.join(searchInstallDir, "up-to-date", "provider.js"), "globalThis.__zrs_exports={};");

    await mkdir(path.join(searchInstallDir, "needs-update"), { recursive: true });
    await writeFile(
      path.join(searchInstallDir, "needs-update", "manifest.json"),
      JSON.stringify({
        id: "needs-update",
        name: "needs-update",
        version: "0.9.0",
        sourceType: "academic",
        permissions: { urls: ["https://example.com/*"] },
      }),
    );
    await writeFile(path.join(searchInstallDir, "needs-update", "provider.js"), "globalThis.__zrs_exports={};");

    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          providers: [
            { id: "fresh-install", version: "1.0.0", downloadUrl: "./fresh-install.zip" },
            { id: "up-to-date", version: "1.0.0", downloadUrl: "./up-to-date.zip" },
            { id: "needs-update", version: "1.0.0", downloadUrl: "./needs-update.zip" },
            {
              id: "future-only",
              version: "1.0.0",
              downloadUrl: "./future-only.zip",
              minPluginVersion: "9.9.9",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = await loadRegistryManifest(registryPath);
    const plan = await planRegistrySync({
      registry,
      installDir,
      currentVersion: "0.1.0",
    });

    expect(plan.installDir).toBe(searchInstallDir);
    expect(plan.entries).toEqual([
      expect.objectContaining({
        id: "fresh-install",
        action: "install",
        installPath: path.join(searchInstallDir, "fresh-install"),
      }),
      expect.objectContaining({ id: "up-to-date", action: "skip", reason: "already up to date" }),
      expect.objectContaining({ id: "needs-update", action: "update" }),
      expect.objectContaining({ id: "future-only", action: "blocked" }),
    ]);
  });

  it("reads a legacy flat provider but blocks registry writes until migration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registry-legacy-fallback-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const legacyDir = path.join(installDir, "alpha");
    const searchTarget = path.join(installDir, "search", "alpha");
    const registryPath = path.join(root, "registry.json");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "manifest.json"),
      JSON.stringify({
        id: "alpha",
        name: "alpha",
        version: "1.0.0",
        sourceType: "academic",
        permissions: { urls: ["https://example.com/*"] },
      }),
    );
    await writeFile(path.join(legacyDir, "provider.js"), "globalThis.__zrs_exports={};");
    await writeFile(
      registryPath,
      JSON.stringify({
        providers: [{ id: "alpha", version: "1.0.0", downloadUrl: "./alpha.zip" }],
      }),
      "utf8",
    );

    const installed = await listInstalledProviders(installDir);
    expect(installed).toEqual([
      expect.objectContaining({ id: "alpha", layout: "legacy", path: legacyDir, valid: true }),
    ]);
    const currentPlan = await planRegistrySync({
      registry: await loadRegistryManifest(registryPath),
      installDir,
      currentVersion: "1.0.0",
    });
    expect(currentPlan).toMatchObject({
      installDir: path.join(installDir, "search"),
      entries: [{
        id: "alpha",
        action: "skip",
        reason: "already up to date (legacy flat read fallback)",
        installPath: searchTarget,
      }],
    });

    await writeFile(
      registryPath,
      JSON.stringify({
        providers: [{ id: "alpha", version: "2.0.0", downloadUrl: "./alpha.zip" }],
      }),
      "utf8",
    );
    const summary = await applyRegistrySync({
      registry: await loadRegistryManifest(registryPath),
      installDir,
      currentVersion: "1.0.0",
    });
    expect(summary.applied).toEqual([]);
    expect(summary.skipped).toEqual([
      expect.objectContaining({
        id: "alpha",
        action: "blocked",
        reason: "legacy flat provider must be migrated before update",
      }),
    ]);
    await expect(access(searchTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(legacyDir)).resolves.toBeUndefined();
  });

  it("applies registry sync from local zip files and installs provider directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registry-apply-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const searchInstallDir = path.join(installDir, "search");
    const registryDir = path.join(root, "registry");
    await mkdir(installDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });

    await createProviderZip(path.join(registryDir, "alpha.zip"), "alpha", "1.0.0", { nested: true });
    await createProviderZip(path.join(registryDir, "beta.zip"), "beta", "1.2.0");
    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          providers: [
            { id: "alpha", version: "1.0.0", downloadUrl: "./alpha.zip" },
            { id: "beta", version: "1.2.0", downloadUrl: "./beta.zip" },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = await loadRegistryManifest(registryPath);
    const summary = await applyRegistrySync({
      registry,
      installDir,
      currentVersion: "0.1.0",
      runProviderMutation: async (id, mutation) => {
        // The archive must already be fetched and verified before the caller
        // enters its provider mutation lock.
        await rm(path.join(registryDir, `${id}.zip`));
        return mutation();
      },
    });

    expect(summary.applied).toHaveLength(2);
    const installed = await listInstalledProviders(installDir);
    expect(installed.filter((entry) => entry.valid).map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      "alpha@1.0.0",
      "beta@1.2.0",
    ]);
    expect(summary.plan.installDir).toBe(searchInstallDir);
    expect(summary.applied.map((entry) => entry.installPath)).toEqual([
      path.join(searchInstallDir, "alpha"),
      path.join(searchInstallDir, "beta"),
    ]);
    const alphaProviderJs = await readFile(path.join(searchInstallDir, "alpha", "provider.js"), "utf8");
    expect(alphaProviderJs).toContain("__zrs_exports");
    await expect(access(path.join(installDir, "alpha"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an existing provider when an update archive disagrees with the registry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registry-mismatch-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const searchInstallDir = path.join(installDir, "search");
    const registryDir = path.join(root, "registry");
    const existingDir = path.join(searchInstallDir, "alpha");
    await mkdir(existingDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(existingDir, "manifest.json"),
      JSON.stringify({
        id: "alpha",
        name: "alpha",
        version: "0.9.0",
        sourceType: "academic",
        permissions: { urls: ["https://example.com/*"] },
      }),
    );
    await writeFile(path.join(existingDir, "provider.js"), "globalThis.__zrs_exports={};");
    await writeFile(path.join(existingDir, "marker.txt"), "existing", "utf8");
    await createProviderZip(path.join(registryDir, "alpha.zip"), "alpha", "9.0.0");
    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        providers: [{ id: "alpha", version: "1.0.0", downloadUrl: "./alpha.zip" }],
      }),
      "utf8",
    );

    await expect(
      applyRegistrySync({
        registry: await loadRegistryManifest(registryPath),
        installDir,
        currentVersion: "1.0.0",
      }),
    ).rejects.toThrow("does not match registry version");
    await expect(readFile(path.join(existingDir, "marker.txt"), "utf8")).resolves.toBe("existing");
  });
});
