import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  applyProviderZipInstallPlan,
  installProviderFromZipFile,
  planProviderZipInstall,
} from "../../src/providers/install/zip.js";
import { PROVIDER_RECEIPT_FILENAME } from "../../src/providers/install/manualZip.js";
import type { InstallPathReplacementOperations } from "../../src/providers/install/replace.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) =>
      import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })),
    ),
  );
  tempDirs.length = 0;
});

function manifest(id = "alpha", version = "1.0.0", minPluginVersion?: string): string {
  return JSON.stringify({
    id,
    name: id,
    version,
    sourceType: "academic",
    ...(minPluginVersion ? { minPluginVersion } : {}),
    permissions: { urls: ["https://example.test/*"] },
  });
}

async function writeProviderZip(
  zipPath: string,
  options: {
    id?: string;
    version?: string;
    minPluginVersion?: string;
    entries?: Array<[string, string]>;
  } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("manifest.json", manifest(options.id, options.version, options.minPluginVersion));
  zip.file("provider.js", "globalThis.__zrs_exports={createProvider(){return {}}};");
  for (const [entryPath, content] of options.entries ?? []) {
    zip.file(entryPath, content);
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(zipPath, bytes);
  return bytes;
}

describe("provider ZIP installation", () => {
  it("plans without writes, then applies an unbound manual receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-zip-plan-"));
    tempDirs.push(root);
    const zipPath = path.join(root, "provider.zip");
    const bytes = await writeProviderZip(zipPath);
    const installDir = path.join(root, "providers");

    const plan = await planProviderZipInstall(zipPath, installDir, { currentVersion: "1.0.0" });
    expect(plan).toMatchObject({
      runtimeKind: "search",
      providerKind: "academic",
      id: "alpha",
      version: "1.0.0",
      installType: "manual-zip",
      bound: false,
      archiveSha256: createHash("sha256").update(bytes).digest("hex"),
      entryPath: "provider.js",
      targetPath: path.join(installDir, "alpha"),
      replacementPrecondition: { state: "absent" },
    });
    await expect(access(installDir)).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await applyProviderZipInstallPlan(plan);
    expect(applied).toMatchObject({ id: "alpha", replacedExisting: false });
    const receipt = JSON.parse(
      await readFile(path.join(installDir, "alpha", PROVIDER_RECEIPT_FILENAME), "utf8"),
    );
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      runtimeKind: "search",
      providerKind: "academic",
      id: "alpha",
      version: "1.0.0",
      installType: "manual-zip",
      bound: false,
      archiveSha256: plan.archiveSha256,
      manifestSha256: plan.manifestSha256,
      entryPath: "provider.js",
      entrySha256: plan.entrySha256,
      installedAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("rejects an invalid plan without writes and restores the old provider plus receipt on rename failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-zip-transaction-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const futureZipPath = path.join(root, "future.zip");
    await writeProviderZip(futureZipPath, { minPluginVersion: "9.0.0" });
    await expect(
      planProviderZipInstall(futureZipPath, installDir, { currentVersion: "1.0.0" }),
    ).rejects.toThrow("requires paper-search-cli >= 9.0.0");
    await expect(access(installDir)).rejects.toMatchObject({ code: "ENOENT" });

    const firstZipPath = path.join(root, "first.zip");
    await writeProviderZip(firstZipPath);
    await applyProviderZipInstallPlan(
      await planProviderZipInstall(firstZipPath, installDir, { currentVersion: "1.0.0" }),
    );
    const targetPath = path.join(installDir, "alpha");
    const priorReceipt = await readFile(path.join(targetPath, PROVIDER_RECEIPT_FILENAME), "utf8");
    const priorProvider = await readFile(path.join(targetPath, "provider.js"), "utf8");

    const updateZipPath = path.join(root, "update.zip");
    await writeProviderZip(updateZipPath, { version: "2.0.0" });
    const updatePlan = await planProviderZipInstall(updateZipPath, installDir, {
      currentVersion: "1.0.0",
    });
    const operations: InstallPathReplacementOperations = {
      stat,
      remove: (target) => rm(target, { recursive: true, force: true }),
      async rename(source, destination) {
        if (path.resolve(destination) === targetPath && source.includes("._install_")) {
          throw new Error("simulated staged rename failure");
        }
        await rename(source, destination);
      },
    };

    await expect(
      applyProviderZipInstallPlan(updatePlan, { replacementOperations: operations }),
    ).rejects.toThrow("simulated staged rename failure");
    await expect(readFile(path.join(targetPath, PROVIDER_RECEIPT_FILENAME), "utf8")).resolves.toBe(
      priorReceipt,
    );
    await expect(readFile(path.join(targetPath, "provider.js"), "utf8")).resolves.toBe(
      priorProvider,
    );
  });

  it.each([
    ["forward traversal", "../escape.txt"],
    ["Windows traversal", "..\\escape.txt"],
    ["absolute path", "/escape.txt"],
    ["drive-qualified path", "C:\\escape.txt"],
    ["drive-relative path", "C:escape.txt"],
    ["Windows reserved name", "NUL.txt"],
    ["Windows-trimmed path", "docs/escape.txt."],
  ])("rejects %s entries without writing outside the provider directory", async (_label, entryPath) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-zip-path-"));
    tempDirs.push(root);
    const zipPath = path.join(root, "provider.zip");
    await writeProviderZip(zipPath, { entries: [[entryPath, "escape"]] });

    await expect(installProviderFromZipFile(zipPath, path.join(root, "providers"))).rejects.toThrow(
      /Unsafe provider ZIP entry path/u,
    );
    await expect(access(path.join(root, "escape.txt"))).rejects.toBeDefined();
  });

  it("rejects case-insensitive entry collisions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-zip-collision-"));
    tempDirs.push(root);
    const zipPath = path.join(root, "provider.zip");
    await writeProviderZip(zipPath, {
      entries: [
        ["docs/readme.txt", "one"],
        ["DOCS/README.TXT", "two"],
      ],
    });

    await expect(installProviderFromZipFile(zipPath, path.join(root, "providers"))).rejects.toThrow(
      "Duplicate provider ZIP entry path",
    );
  });

  it("validates registry identity, checksum, and minimum CLI version before replacing an install", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-zip-identity-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const existingDir = path.join(installDir, "alpha");
    await mkdir(existingDir, { recursive: true });
    await writeFile(path.join(existingDir, "marker.txt"), "existing", "utf8");

    const zipPath = path.join(root, "provider.zip");
    const bytes = await writeProviderZip(zipPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    await expect(
      installProviderFromZipFile(zipPath, installDir, { id: "other", currentVersion: "1.0.0" }),
    ).rejects.toThrow("does not match registry id");
    await expect(
      installProviderFromZipFile(zipPath, installDir, { version: "2.0.0", currentVersion: "1.0.0" }),
    ).rejects.toThrow("does not match registry version");
    await expect(
      installProviderFromZipFile(zipPath, installDir, { sha256: "0".repeat(64), currentVersion: "1.0.0" }),
    ).rejects.toThrow("checksum mismatch");
    await expect(readFile(path.join(existingDir, "marker.txt"), "utf8")).resolves.toBe("existing");

    const futureZipPath = path.join(root, "future.zip");
    await writeProviderZip(futureZipPath, { minPluginVersion: "9.0.0" });
    await expect(
      installProviderFromZipFile(futureZipPath, installDir, {
        id: "alpha",
        version: "1.0.0",
        currentVersion: "1.0.0",
      }),
    ).rejects.toThrow("requires paper-search-cli >= 9.0.0");
    await expect(readFile(path.join(existingDir, "marker.txt"), "utf8")).resolves.toBe("existing");

    const result = await installProviderFromZipFile(zipPath, installDir, {
      id: "alpha",
      version: "1.0.0",
      sha256,
      currentVersion: "1.0.0",
    });
    expect(result).toMatchObject({ id: "alpha", replacedExisting: true });
    await expect(access(path.join(existingDir, "marker.txt"))).rejects.toBeDefined();
    expect((await readdir(installDir)).filter((entry) => entry.includes(".backup."))).toEqual([]);
  });
});
