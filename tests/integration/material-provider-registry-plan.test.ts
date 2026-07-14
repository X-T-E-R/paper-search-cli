import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMaterialProviderRegistryManifest } from "../../src/material/registry/load.js";
import {
  listInstalledMaterialProviders,
  planMaterialProviderRegistry,
} from "../../src/material/registry/plan.js";

const tempDirs: string[] = [];
const registryFixture = path.resolve(
  "tests",
  "fixtures",
  "material-provider-registries",
  "local",
  "registry.json",
);

afterEach(async () => {
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

type DirectorySnapshot = null | Array<{ relativePath: string; kind: "dir" | "file"; content?: string }>;

async function snapshotDirectory(root: string): Promise<DirectorySnapshot> {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat) return null;
  const entries: NonNullable<DirectorySnapshot> = [];

  async function visit(currentPath: string): Promise<void> {
    const dirEntries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of dirEntries) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(root, entryPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        entries.push({ relativePath, kind: "dir" });
        await visit(entryPath);
      } else if (entry.isFile()) {
        entries.push({
          relativePath,
          kind: "file",
          content: await readFile(entryPath, "utf8"),
        });
      }
    }
  }

  await visit(root);
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function writeInstalledMaterialProvider(
  installDir: string,
  id: string,
  version: string,
): Promise<void> {
  const providerDir = path.join(installDir, id);
  await mkdir(providerDir, { recursive: true });
  await writeFile(
    path.join(providerDir, "manifest.json"),
    JSON.stringify(
      {
        id,
        name: id,
        version,
        kind: "extractor",
        entry: "provider.js",
        capabilities: {
          inputs: ["url", "local_file", "artifact"],
          outputs: ["markdown", "json"],
          network: false,
        },
        permissions: {
          localRead: true,
          localWrite: "cache",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(providerDir, "provider.js"),
    "globalThis.__material_provider_exports = { createProvider() { return {}; } };",
    "utf8",
  );
}

describe("material provider registry planning", () => {
  it("treats only a missing install directory as empty", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "paper-search-material-registry-io-")),
    );
    tempDirs.push(root);
    await expect(listInstalledMaterialProviders(path.join(root, "missing"))).resolves.toEqual([]);

    const notDirectory = path.join(root, "not-a-directory");
    await writeFile(notDirectory, "file", "utf8");
    await expect(listInstalledMaterialProviders(notDirectory)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("uses legacy flat material providers only as read and migration fallbacks", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "paper-search-material-registry-legacy-")),
    );
    tempDirs.push(root);
    const installDir = path.join(root, "material-providers");
    await writeInstalledMaterialProvider(installDir, "up-to-date", "1.0.0");
    await writeInstalledMaterialProvider(installDir, "needs-update", "0.9.0");

    const installed = await listInstalledMaterialProviders(installDir);
    expect(installed).toEqual([
      expect.objectContaining({ id: "needs-update", layout: "legacy", valid: true }),
      expect.objectContaining({ id: "up-to-date", layout: "legacy", valid: true }),
    ]);
    const envelope = await planMaterialProviderRegistry({
      registry: await loadMaterialProviderRegistryManifest(registryFixture),
      installDir,
      currentVersion: "0.1.0",
      selectedProviderIds: ["up-to-date", "needs-update"],
    });
    expect(envelope.data?.report.installDir).toBe(path.join(installDir, "material"));
    expect(envelope.data?.actions).toEqual([
      expect.objectContaining({
        id: "up-to-date",
        action: "skip",
        reason: "already up to date (legacy flat read fallback)",
        installPath: path.join(installDir, "material", "up-to-date"),
      }),
      expect.objectContaining({
        id: "needs-update",
        action: "blocked",
        reason: "legacy flat provider must be migrated before update",
        installPath: path.join(installDir, "material", "needs-update"),
      }),
    ]);
    expect(await snapshotDirectory(path.join(installDir, "material"))).toBeNull();
  });

  it("returns a planned envelope for install, update, skip, and blocked actions without touching install dirs", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "paper-search-material-registry-plan-")),
    );
    tempDirs.push(root);
    const installDir = path.join(root, "material-providers");
    const materialInstallDir = path.join(installDir, "material");
    await mkdir(materialInstallDir, { recursive: true });
    await writeInstalledMaterialProvider(materialInstallDir, "up-to-date", "1.0.0");
    await writeInstalledMaterialProvider(materialInstallDir, "needs-update", "0.9.0");

    const beforeSnapshot = await snapshotDirectory(installDir);
    const freshInstallTarget = path.join(materialInstallDir, "fresh-install");
    expect(await snapshotDirectory(freshInstallTarget)).toBeNull();

    const registry = await loadMaterialProviderRegistryManifest(registryFixture);
    const envelope = await planMaterialProviderRegistry({
      registry,
      installDir,
      currentVersion: "0.1.0",
    });

    const afterSnapshot = await snapshotDirectory(installDir);
    expect(afterSnapshot).toEqual(beforeSnapshot);
    expect(await snapshotDirectory(freshInstallTarget)).toBeNull();

    expect(envelope.ok).toBe(true);
    expect(envelope.capability).toBe("operate");
    expect(envelope.tool).toBe("material_provider_registry_plan");
    expect(envelope.planned).toBe(true);
    expect(envelope.data).not.toBeNull();
    const data = envelope.data!;
    expect(data.selectedPolicy).toBe("material-provider-registry-plan");
    expect(data.selectedProvider).toEqual({
      id: "material-provider-registry",
      kind: "material",
      capabilities: ["operate"],
    });
    expect(data.report.installDir).toBe(materialInstallDir);
    expect(data.report.counts).toEqual({
      install: 1,
      update: 1,
      skip: 1,
      blocked: 1,
    });
    expect(data.actions).toEqual([
      expect.objectContaining({
        id: "fresh-install",
        action: "install",
        installPath: path.join(materialInstallDir, "fresh-install"),
        reason: "not installed",
      }),
      expect.objectContaining({
        id: "up-to-date",
        action: "skip",
        installedVersion: "1.0.0",
        reason: "already up to date",
      }),
      expect.objectContaining({
        id: "needs-update",
        action: "update",
        installedVersion: "0.9.0",
        reason: "registry version is newer",
      }),
      expect.objectContaining({
        id: "future-only",
        action: "blocked",
        minRequiredVersion: "9.9.9",
        reason: "requires paper-search-cli >= 9.9.9",
      }),
    ]);
    expect(data.targetPaths).toEqual(
      expect.arrayContaining([
        materialInstallDir,
        path.join(materialInstallDir, "fresh-install"),
        path.join(materialInstallDir, "up-to-date"),
        path.join(materialInstallDir, "needs-update"),
        path.join(materialInstallDir, "future-only"),
      ]),
    );
  });
});
