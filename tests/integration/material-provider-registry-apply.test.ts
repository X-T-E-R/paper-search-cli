import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMaterialProviderRegistryManifest } from "../../src/material/registry/load.js";
import { applyMaterialProviderRegistry } from "../../src/material/registry/apply.js";
import { listInstalledMaterialProviders } from "../../src/material/registry/plan.js";

const tempDirs: string[] = [];
const fixturesRoot = path.resolve("tests", "fixtures", "material-provider-registries", "local");

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function zipPackageDir(packagePath: string, outputPath: string, nestedRoot?: string): Promise<Uint8Array> {
  const zip = new JSZip();
  const prefix = nestedRoot ? `${nestedRoot}/` : "";

  async function addDirectory(currentPath: string, relativePrefix = ""): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(currentPath, entry.name);
      const relativePath = path.posix.join(relativePrefix, entry.name);
      if (entry.isDirectory()) {
        await addDirectory(sourcePath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        zip.file(`${prefix}${relativePath}`, await readFile(sourcePath));
      }
    }
  }

  await addDirectory(packagePath);
  const bytes = new Uint8Array(await zip.generateAsync({ type: "nodebuffer" }));
  await writeFile(outputPath, bytes);
  return bytes;
}

async function snapshotDirectory(root: string): Promise<string[] | null> {
  const info = await stat(root).catch(() => null);
  if (!info) return null;
  const entries: string[] = [];

  async function visit(currentPath: string): Promise<void> {
    const dirEntries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of dirEntries) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(root, entryPath).replace(/\\/g, "/");
      entries.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
      if (entry.isDirectory()) await visit(entryPath);
    }
  }

  await visit(root);
  return entries.sort((left, right) => left.localeCompare(right));
}

describe("material provider registry apply", () => {
  it("installs the generated downloadUrl/kind shape from an HTTPS registry", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "paper-search-material-registry-remote-")),
    );
    tempDirs.push(root);
    const zipPath = path.join(root, "fresh-install.zip");
    const archiveBytes = await zipPackageDir(
      path.join(fixturesRoot, "fresh-install"),
      zipPath,
      "fresh-install",
    );
    const registryBody = JSON.stringify({
      providers: [
        {
          id: "fresh-install",
          version: "1.0.0",
          kind: "extractor",
          downloadUrl: "./fresh-install.zip",
          sha256: sha256Hex(archiveBytes),
          minCliVersion: "0.1.0",
        },
      ],
    });
    const registryUrl = "https://material.example.test/releases/registry.json";
    const archiveUrl = "https://material.example.test/releases/fresh-install.zip";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const requestUrl = String(input);
      if (requestUrl === registryUrl) {
        return new Response(registryBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (requestUrl === archiveUrl) {
        return new Response(Buffer.from(archiveBytes), {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const registry = await loadMaterialProviderRegistryManifest(registryUrl);
      const installDir = path.join(root, "material-providers");
      const materialInstallDir = path.join(installDir, "material");
      const envelope = await applyMaterialProviderRegistry({
        registry,
        installDir,
        currentVersion: "0.1.0",
      });

      expect(envelope.data?.applied).toEqual([
        expect.objectContaining({
          id: "fresh-install",
          version: "1.0.0",
          installPath: path.join(materialInstallDir, "fresh-install"),
        }),
      ]);
      expect(envelope.data?.report.installDir).toBe(materialInstallDir);
      expect(envelope.data?.actions[0]?.provider).toMatchObject({
        id: "fresh-install",
        kind: "extractor",
      });
      expect(envelope.data?.actions[0]?.archiveRef).toBe(archiveUrl);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("installs a fixture zip and materializes manifest, entry, and extra files", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "paper-search-material-registry-apply-")),
    );
    tempDirs.push(root);
    const registryDir = path.join(root, "registry");
    const installDir = path.join(root, "material-providers");
    const materialInstallDir = path.join(installDir, "material");
    await mkdir(registryDir, { recursive: true });

    const zipPath = path.join(registryDir, "fresh-install.zip");
    const archiveBytes = await zipPackageDir(
      path.join(fixturesRoot, "fresh-install"),
      zipPath,
      "fresh-install",
    );
    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          providers: [
            {
              id: "fresh-install",
              version: "1.0.0",
              kind: "extractor",
              downloadUrl: "./fresh-install.zip",
              sha256: sha256Hex(archiveBytes),
              minCliVersion: "0.1.0",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = await loadMaterialProviderRegistryManifest(registryPath);
    const envelope = await applyMaterialProviderRegistry({
      registry,
      installDir,
      currentVersion: "0.1.0",
      runProviderMutation: async (_id, mutation) => {
        // Removing the source at the lock boundary proves preparation did not
        // defer archive I/O into the mutation callback.
        await rm(zipPath);
        return mutation();
      },
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.capability).toBe("operate");
    expect(envelope.tool).toBe("material_provider_registry_apply");
    expect(envelope.data?.applied).toEqual([
      expect.objectContaining({
        id: "fresh-install",
        action: "install",
        version: "1.0.0",
        checksumTarget: "archive",
        replacedExisting: false,
        installPath: path.join(materialInstallDir, "fresh-install"),
      }),
    ]);
    expect(envelope.data?.skipped).toEqual([]);

    const installed = await listInstalledMaterialProviders(installDir);
    expect(installed.filter((entry) => entry.valid).map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      "fresh-install@1.0.0",
    ]);
    expect(await readFile(path.join(materialInstallDir, "fresh-install", "manifest.json"), "utf8")).toContain(
      '"id": "fresh-install"',
    );
    expect(await readFile(path.join(materialInstallDir, "fresh-install", "provider.js"), "utf8")).toContain(
      "__material_provider_exports",
    );
    expect(await readFile(path.join(materialInstallDir, "fresh-install", "assets", "template.txt"), "utf8")).toBe(
      "fixture asset for material provider registry apply",
    );
    expect(JSON.parse(await readFile(
      path.join(materialInstallDir, "fresh-install", ".paper-search-receipt.json"),
      "utf8",
    ))).toMatchObject({ installType: "manual-zip", bound: false, id: "fresh-install" });
    expect(await snapshotDirectory(path.join(installDir, "fresh-install"))).toBeNull();
  });

  it("uses provider entry bytes for packagePath checksum installs", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "paper-search-material-registry-package-checksum-")),
    );
    tempDirs.push(root);
    const registryDir = path.join(root, "registry");
    const installDir = path.join(root, "material-providers");
    const materialInstallDir = path.join(installDir, "material");
    await mkdir(registryDir, { recursive: true });

    const packagePath = path.join(fixturesRoot, "fresh-install");
    const providerEntryBytes = new Uint8Array(await readFile(path.join(packagePath, "provider.js")));
    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          providers: [
            {
              id: "fresh-install",
              version: "1.0.0",
              packagePath,
              checksum: { sha256: sha256Hex(providerEntryBytes) },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = await loadMaterialProviderRegistryManifest(registryPath);
    const envelope = await applyMaterialProviderRegistry({
      registry,
      installDir,
      currentVersion: "0.1.0",
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data?.applied).toEqual([
      expect.objectContaining({
        id: "fresh-install",
        action: "install",
        version: "1.0.0",
        checksumTarget: "entry",
        replacedExisting: false,
        installPath: path.join(materialInstallDir, "fresh-install"),
      }),
    ]);
    expect(JSON.parse(await readFile(
      path.join(materialInstallDir, "fresh-install", ".paper-search-receipt.json"),
      "utf8",
    ))).toMatchObject({ installType: "legacy-directory", bound: false, id: "fresh-install" });
    expect(await readFile(path.join(materialInstallDir, "fresh-install", "provider.js"), "utf8")).toContain(
      "__material_provider_exports",
    );
  });

  it("rejects archive checksum mismatch before creating a partial install directory", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "paper-search-material-registry-checksum-")),
    );
    tempDirs.push(root);
    const registryDir = path.join(root, "registry");
    const installDir = path.join(root, "material-providers");
    await mkdir(registryDir, { recursive: true });

    const zipPath = path.join(registryDir, "fresh-install.zip");
    await zipPackageDir(path.join(fixturesRoot, "fresh-install"), zipPath);
    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          providers: [
            {
              id: "fresh-install",
              version: "1.0.0",
              archivePath: "./fresh-install.zip",
              checksum: {
                sha256: "0000000000000000000000000000000000000000000000000000000000000000",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const beforeSnapshot = await snapshotDirectory(installDir);
    const registry = await loadMaterialProviderRegistryManifest(registryPath);
    await expect(
      applyMaterialProviderRegistry({
        registry,
        installDir,
        currentVersion: "0.1.0",
      }),
    ).rejects.toThrow(/checksum mismatch/i);
    expect(await snapshotDirectory(installDir)).toEqual(beforeSnapshot);
    expect(await snapshotDirectory(path.join(installDir, "material", "fresh-install"))).toBeNull();
    expect(await snapshotDirectory(path.join(installDir, "fresh-install"))).toBeNull();
  });

  it("rejects a registry subtype mismatch without replacing the prior provider", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "paper-search-material-registry-subtype-")),
    );
    tempDirs.push(root);
    const registryDir = path.join(root, "registry");
    const installDir = path.join(root, "material-providers");
    const existingDir = path.join(installDir, "material", "fresh-install");
    await mkdir(registryDir, { recursive: true });
    await mkdir(existingDir, { recursive: true });
    await writeFile(path.join(existingDir, "marker.txt"), "prior", "utf8");

    const zipPath = path.join(registryDir, "fresh-install.zip");
    const archiveBytes = await zipPackageDir(path.join(fixturesRoot, "fresh-install"), zipPath);
    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        providers: [
          {
            id: "fresh-install",
            version: "1.0.0",
            kind: "converter",
            downloadUrl: "./fresh-install.zip",
            sha256: sha256Hex(archiveBytes),
          },
        ],
      }),
      "utf8",
    );

    const registry = await loadMaterialProviderRegistryManifest(registryPath);
    await expect(
      applyMaterialProviderRegistry({ registry, installDir, currentVersion: "0.1.0" }),
    ).rejects.toThrow("manifest kind extractor does not match registry kind converter");
    await expect(readFile(path.join(existingDir, "marker.txt"), "utf8")).resolves.toBe("prior");
  });

  it("does not apply blocked entries and rejects manifest version mismatches", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "paper-search-material-registry-version-")),
    );
    tempDirs.push(root);
    const registryDir = path.join(root, "registry");
    const installDir = path.join(root, "material-providers");
    await mkdir(registryDir, { recursive: true });

    const blockedZipPath = path.join(registryDir, "future-only.zip");
    await zipPackageDir(path.join(fixturesRoot, "future-only"), blockedZipPath);
    const mismatchZipPath = path.join(registryDir, "fresh-install.zip");
    await zipPackageDir(path.join(fixturesRoot, "fresh-install"), mismatchZipPath);
    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          providers: [
            {
              id: "future-only",
              version: "1.0.0",
              archivePath: "./future-only.zip",
              minPluginVersion: "9.9.9",
            },
            {
              id: "fresh-install",
              version: "2.0.0",
              archivePath: "./fresh-install.zip",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = await loadMaterialProviderRegistryManifest(registryPath);
    await expect(
      applyMaterialProviderRegistry({
        registry,
        installDir,
        currentVersion: "0.1.0",
      }),
    ).rejects.toThrow(/manifest version 1\.0\.0 does not match registry version 2\.0\.0/);
    expect(await snapshotDirectory(path.join(installDir, "material", "future-only"))).toBeNull();
    expect(await snapshotDirectory(path.join(installDir, "material", "fresh-install"))).toBeNull();
    expect(await snapshotDirectory(path.join(installDir, "future-only"))).toBeNull();
    expect(await snapshotDirectory(path.join(installDir, "fresh-install"))).toBeNull();
  });
});
