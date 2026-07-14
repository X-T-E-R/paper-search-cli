import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMaterialProviderZipInstallPlan,
  planMaterialProviderZipInstall,
} from "../../src/material/install/package.js";
import { PROVIDER_RECEIPT_FILENAME } from "../../src/providers/install/manualZip.js";

const tempDirs: string[] = [];
const fixturePath = path.resolve(
  "tests",
  "fixtures",
  "material-provider-packages",
  "fixture-extractor",
);

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function writeMaterialZip(
  zipPath: string,
  manifestOverrides: Record<string, unknown> = {},
): Promise<Buffer> {
  const zip = new JSZip();
  const manifest = JSON.parse(await readFile(path.join(fixturePath, "manifest.json"), "utf8"));
  zip.file(
    "fixture-extractor/manifest.json",
    JSON.stringify({ ...manifest, ...manifestOverrides }),
  );
  const entries = await readdir(fixturePath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === "manifest.json") continue;
    zip.file(`fixture-extractor/${entry.name}`, await readFile(path.join(fixturePath, entry.name)));
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(zipPath, bytes);
  return bytes;
}

describe("material provider manual ZIP installation", () => {
  it("plans without writes, then applies a subtype-preserving unbound receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-zip-plan-"));
    tempDirs.push(root);
    const zipPath = path.join(root, "fixture-extractor.zip");
    const bytes = await writeMaterialZip(zipPath);
    const installDir = path.join(root, "providers");

    const plan = await planMaterialProviderZipInstall(zipPath, installDir, {
      currentVersion: "1.0.0",
    });
    expect(plan).toMatchObject({
      runtimeKind: "material",
      providerKind: "extractor",
      id: "fixture-extractor",
      version: "1.0.0",
      installType: "manual-zip",
      bound: false,
      archiveSha256: createHash("sha256").update(bytes).digest("hex"),
      entryPath: "provider.js",
      targetPath: path.join(installDir, "fixture-extractor"),
      replacementPrecondition: { state: "absent" },
    });
    await expect(access(installDir)).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await applyMaterialProviderZipInstallPlan(plan);
    expect(applied).toMatchObject({ id: "fixture-extractor", replacedExisting: false });
    const receipt = JSON.parse(
      await readFile(
        path.join(installDir, "fixture-extractor", PROVIDER_RECEIPT_FILENAME),
        "utf8",
      ),
    );
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      runtimeKind: "material",
      providerKind: "extractor",
      id: "fixture-extractor",
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

  it("rejects future-version plans and stale apply preconditions without replacing files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-zip-negative-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const futureZip = path.join(root, "future.zip");
    await writeMaterialZip(futureZip, { minCliVersion: "9.0.0" });
    await expect(
      planMaterialProviderZipInstall(futureZip, installDir, { currentVersion: "1.0.0" }),
    ).rejects.toThrow("requires paper-search-cli >= 9.0.0");
    await expect(access(installDir)).rejects.toMatchObject({ code: "ENOENT" });

    const validZip = path.join(root, "valid.zip");
    await writeMaterialZip(validZip);
    const plan = await planMaterialProviderZipInstall(validZip, installDir, {
      currentVersion: "1.0.0",
    });
    const targetPath = path.join(installDir, "fixture-extractor");
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(targetPath, "marker.txt"), "concurrent", "utf8");

    await expect(applyMaterialProviderZipInstallPlan(plan)).rejects.toThrow(
      "Provider install target changed after planning",
    );
    await expect(readFile(path.join(targetPath, "marker.txt"), "utf8")).resolves.toBe(
      "concurrent",
    );
  });
});
