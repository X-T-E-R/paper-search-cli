import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";
import { loadMaterialProviderRegistryManifest } from "../../src/material/registry/load.js";
import { applyMaterialProviderRegistry } from "../../src/material/registry/apply.js";
import { planMaterialProviderRegistry } from "../../src/material/registry/plan.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";
import { resolveDistributableMaterialPackageDir } from "../helpers/distributableMaterialProviders.js";

const tempDirs: string[] = [];
let mineruPackageDir = "";

beforeAll(async () => {
  mineruPackageDir = await resolveDistributableMaterialPackageDir("mineru-extractor");
});

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

async function runCli(cwd: string, args: string[]): Promise<{
  stdout: string;
  stderr: string;
  envelope: ResultEnvelope;
}> {
  let stdout = "";
  let stderr = "";
  const originalCwd = process.cwd();
  const originalTestMode = process.env.PAPER_SEARCH_INSTALL_TEST_MODE;
  const originalDataRoot = process.env.PAPER_SEARCH_TEST_DATA_ROOT;
  process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
  process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(cwd, ".test-paper-search-data");
  process.chdir(cwd);
  try {
    await buildProgram({
      stdout: { write(chunk: string) { stdout += chunk; } },
      stderr: { write(chunk: string) { stderr += chunk; } },
    })
      .exitOverride()
      .parseAsync(["node", "paper-search", ...args]);
  } finally {
    process.chdir(originalCwd);
    if (originalTestMode === undefined) delete process.env.PAPER_SEARCH_INSTALL_TEST_MODE;
    else process.env.PAPER_SEARCH_INSTALL_TEST_MODE = originalTestMode;
    if (originalDataRoot === undefined) delete process.env.PAPER_SEARCH_TEST_DATA_ROOT;
    else process.env.PAPER_SEARCH_TEST_DATA_ROOT = originalDataRoot;
  }
  const envelope = JSON.parse(stdout) as ResultEnvelope;
  expect(isResultEnvelope(envelope)).toBe(true);
  return { stdout, stderr, envelope };
}

describe("mineru-extractor distributable install integration", () => {
  it("installs the distributable mineru package via providers install-zip and lists it as installed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-mineru-install-zip-"));
    tempDirs.push(root);
    const installDir = path.join(root, "material-providers");
    await mkdir(installDir, { recursive: true });
    await writeFile(
      path.join(root, "paper-search.toml"),
      [`[providers]`, `installDir = "${installDir.replace(/\\/g, "\\\\")}"`, ""].join("\n"),
      "utf8",
    );

    const zipPath = path.join(root, "mineru-extractor.zip");
    await zipPackageDir(mineruPackageDir, zipPath, "mineru-extractor");

    const install = await runCli(root, [
      "providers",
      "install-zip",
      zipPath,
      "--kind",
      "material",
      "--apply",
      "--json",
    ]);
    expect(install.stderr).toBe("");
    expect(install.envelope).toMatchObject({
      ok: true,
      tool: "material_provider_install_zip",
      data: {
        installDir: path.join(installDir, "material"),
        result: expect.objectContaining({
          id: "mineru-extractor",
          installPath: path.join(installDir, "material", "mineru-extractor"),
        }),
      },
    });

    const list = await runCli(root, ["providers", "list-installed", "--kind", "material", "--json"]);
    const listData = list.envelope.data as { installed?: Array<{ id: string; version: string; valid: boolean }> };
    expect(listData.installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mineru-extractor", version: "1.0.0", valid: true }),
      ]),
    );
    await access(path.join(installDir, "material", "mineru-extractor", "provider.js"));
    await expect(access(path.join(installDir, "mineru-extractor"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies a local registry archiveRef install with sha256 and minCliVersion gates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-mineru-registry-apply-"));
    tempDirs.push(root);
    const registryDir = path.join(root, "registry");
    const installDir = path.join(root, "material-providers");
    await mkdir(registryDir, { recursive: true });

    const zipPath = path.join(registryDir, "mineru-extractor.zip");
    const archiveBytes = await zipPackageDir(mineruPackageDir, zipPath, "mineru-extractor");
    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          providers: [
            {
              id: "mineru-extractor",
              version: "1.0.0",
              archiveRef: "./mineru-extractor.zip",
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
    const plan = await planMaterialProviderRegistry({
      registry,
      installDir,
      currentVersion: "0.1.0",
    });
    expect(plan.data?.actions).toEqual([
      expect.objectContaining({
        id: "mineru-extractor",
        action: "install",
        minRequiredVersion: "0.1.0",
        installPath: path.join(installDir, "material", "mineru-extractor"),
      }),
    ]);
    expect(plan.data?.report.installDir).toBe(path.join(installDir, "material"));

    const envelope = await applyMaterialProviderRegistry({
      registry,
      installDir,
      currentVersion: "0.1.0",
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.applied).toEqual([
      expect.objectContaining({
        id: "mineru-extractor",
        action: "install",
        version: "1.0.0",
        checksumTarget: "archive",
        installPath: path.join(installDir, "material", "mineru-extractor"),
      }),
    ]);

    await writeFile(
      path.join(root, "paper-search.toml"),
      [`[providers]`, `installDir = "${installDir.replace(/\\/g, "\\\\")}"`, ""].join("\n"),
      "utf8",
    );
    const listAfterConfig = await runCli(root, [
      "providers",
      "list-installed",
      "--kind",
      "material",
      "--json",
    ]);
    const listAfterData = listAfterConfig.envelope.data as {
      installed?: Array<{ id: string; version: string; valid: boolean }>;
    };
    expect(listAfterData.installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mineru-extractor", version: "1.0.0", valid: true }),
      ]),
    );
  });

  it("blocks registry apply when minCliVersion exceeds the current CLI version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-mineru-mincli-block-"));
    tempDirs.push(root);
    const registryDir = path.join(root, "registry");
    const installDir = path.join(root, "material-providers");
    await mkdir(registryDir, { recursive: true });

    const zipPath = path.join(registryDir, "mineru-extractor.zip");
    await zipPackageDir(mineruPackageDir, zipPath, "mineru-extractor");
    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          providers: [
            {
              id: "mineru-extractor",
              version: "1.0.0",
              archiveRef: "./mineru-extractor.zip",
              minCliVersion: "9.9.9",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = await loadMaterialProviderRegistryManifest(registryPath);
    const plan = await planMaterialProviderRegistry({
      registry,
      installDir,
      currentVersion: "0.1.0",
    });
    expect(plan.data?.actions).toEqual([
      expect.objectContaining({
        id: "mineru-extractor",
        action: "blocked",
        minRequiredVersion: "9.9.9",
        reason: "requires paper-search-cli >= 9.9.9",
      }),
    ]);

    const envelope = await applyMaterialProviderRegistry({
      registry,
      installDir,
      currentVersion: "0.1.0",
    });
    expect(envelope.data?.applied).toEqual([]);
    expect(envelope.data?.skipped).toEqual([
      expect.objectContaining({ id: "mineru-extractor", action: "blocked" }),
    ]);
    await expect(access(path.join(installDir, "material", "mineru-extractor"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(installDir, "mineru-extractor"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/**
 * Manual install against a built material-providers release (outside vitest):
 *   cd systems/material-providers && npm run build
 *   cd ../paper-search-cli
 *   paper-search providers install-zip ../material-providers/dist/mineru-extractor.zip --kind material --apply
 *   paper-search providers list-installed --kind material
 */
