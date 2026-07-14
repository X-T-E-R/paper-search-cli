import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function zipPackageDir(packagePath: string, outputPath: string, nestedRoot?: string): Promise<void> {
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
  await writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer" }));
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

function expectOkEnvelope(envelope: ResultEnvelope, tool: string): ResultEnvelope<Record<string, unknown>> {
  expect(envelope).toMatchObject({
    ok: true,
    capability: "operate",
    tool,
  });
  expect(envelope.data).not.toBeNull();
  return envelope as ResultEnvelope<Record<string, unknown>>;
}

describe("providers --kind command routing", () => {
  it("routes unified commands to search and material runtimes and keeps material-providers as an alias", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-kind-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(installDir, { recursive: true });
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${installDir.replace(/\\/g, "\\\\")}"`,
        "",
        "[workspace]",
        `root = "${workspaceRoot.replace(/\\/g, "\\\\")}"`,
        "",
      ].join("\n"),
      "utf8",
    );

    const searchPackage = path.resolve("tests", "fixtures", "provider-packages", "fixture-academic");
    const materialPackage = path.resolve("tests", "fixtures", "material-provider-packages", "fixture-extractor");
    const materialRegistry = path.resolve(
      "tests",
      "fixtures",
      "material-provider-registries",
      "local",
      "registry.json",
    );

    const searchManifest = await runCli(root, [
      "providers",
      "validate-manifest",
      path.join(searchPackage, "manifest.json"),
      "--kind",
      "search",
      "--json",
    ]);
    expect(searchManifest.stderr).toBe("");
    const searchManifestEnvelope = expectOkEnvelope(searchManifest.envelope, "provider_validate_manifest");
    expect(searchManifestEnvelope.data?.manifest).toMatchObject({ id: "fixture-academic", sourceType: "academic" });

    const materialManifest = await runCli(root, [
      "providers",
      "validate-manifest",
      path.join(materialPackage, "manifest.json"),
      "--kind",
      "material",
      "--json",
    ]);
    expect(materialManifest.stderr).toBe("");
    const materialManifestEnvelope = expectOkEnvelope(
      materialManifest.envelope,
      "material_provider_validate_manifest",
    );
    expect(materialManifestEnvelope.data?.manifest).toMatchObject({ id: "fixture-extractor", kind: "extractor" });

    const defaultSearchInspect = await runCli(root, [
      "providers",
      "inspect-package",
      searchPackage,
      "--json",
    ]);
    expect(defaultSearchInspect.stderr).toBe("");
    const defaultSearchInspectEnvelope = expectOkEnvelope(
      defaultSearchInspect.envelope,
      "provider_inspect_package",
    );
    expect(defaultSearchInspectEnvelope.data?.inspection).toMatchObject({ hasSearch: true });

    const materialInspect = await runCli(root, [
      "providers",
      "--kind",
      "material",
      "inspect-package",
      materialPackage,
      "--json",
    ]);
    expect(materialInspect.stderr).toBe("");
    const materialInspectEnvelope = expectOkEnvelope(
      materialInspect.envelope,
      "material_provider_inspect_package",
    );
    expect(materialInspectEnvelope.data?.inspection).toMatchObject({
      methods: expect.arrayContaining(["inspect", "extract"]),
    });

    const materialPlan = await runCli(root, [
      "providers",
      "plan-registry",
      materialRegistry,
      "--kind",
      "material",
      "--provider",
      "fresh-install",
      "--json",
    ]);
    expect(materialPlan.stderr).toBe("");
    const materialPlanEnvelope = expectOkEnvelope(materialPlan.envelope, "material_provider_registry_plan");
    expect(materialPlanEnvelope.planned).toBe(true);
    expect(materialPlanEnvelope.data?.actions).toEqual([
      expect.objectContaining({ id: "fresh-install", action: "install" }),
    ]);

    const materialSyncPlan = await runCli(root, [
      "providers",
      "sync-registry",
      materialRegistry,
      "--kind",
      "material",
      "--provider",
      "fresh-install",
      "--json",
    ]);
    expect(materialSyncPlan.stderr).toBe("");
    const materialSyncPlanEnvelope = expectOkEnvelope(
      materialSyncPlan.envelope,
      "material_provider_registry_plan",
    );
    expect(materialSyncPlanEnvelope.planned).toBe(true);

    const materialZipPath = path.join(root, "fixture-extractor.zip");
    await zipPackageDir(materialPackage, materialZipPath, "fixture-extractor");
    const materialInstallPlan = await runCli(root, [
      "material-providers",
      "install-zip",
      materialZipPath,
      "--json",
    ]);
    expect(materialInstallPlan.stderr).toBe("");
    const materialInstallPlanEnvelope = expectOkEnvelope(
      materialInstallPlan.envelope,
      "material_provider_install_zip",
    );
    expect(materialInstallPlanEnvelope).toMatchObject({
      planned: true,
      data: {
        apply: false,
        installDir: path.join(installDir, "material"),
        plan: {
          runtimeKind: "material",
          providerKind: "extractor",
          id: "fixture-extractor",
          installType: "manual-zip",
          bound: false,
          targetPath: path.join(installDir, "material", "fixture-extractor"),
        },
      },
    });
    await expect(
      import("node:fs/promises").then((fs) =>
        fs.access(path.join(installDir, "fixture-extractor")),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      import("node:fs/promises").then((fs) =>
        fs.access(path.join(installDir, "material", "fixture-extractor")),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const materialInstall = await runCli(root, [
      "providers",
      "install-zip",
      materialZipPath,
      "--kind",
      "material",
      "--apply",
      "--json",
    ]);
    expect(materialInstall.stderr).toBe("");
    const materialInstallEnvelope = expectOkEnvelope(materialInstall.envelope, "material_provider_install_zip");
    expect(materialInstallEnvelope.data?.result).toMatchObject({
      id: "fixture-extractor",
      installPath: path.join(installDir, "material", "fixture-extractor"),
    });
    await expect(
      import("node:fs/promises").then((fs) =>
        fs.access(path.join(installDir, "material", "fixture-extractor")),
      ),
    ).resolves.toBeUndefined();

    const materialList = await runCli(root, [
      "providers",
      "list-installed",
      "--kind",
      "material",
      "--json",
    ]);
    expect(materialList.stderr).toBe("");
    const materialListEnvelope = expectOkEnvelope(materialList.envelope, "material_provider_list_installed");
    expect(materialListEnvelope.data?.installDir).toBe(path.join(installDir, "material"));
    expect(materialListEnvelope.data?.installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fixture-extractor", version: "1.0.0", valid: true }),
      ]),
    );

    const aliasInspect = await runCli(root, [
      "material-providers",
      "inspect-package",
      materialPackage,
      "--json",
    ]);
    expect(aliasInspect.stderr).toBe("");
    const aliasInspectEnvelope = expectOkEnvelope(aliasInspect.envelope, "material_provider_inspect_package");
    expect(aliasInspectEnvelope.data?.manifest).toMatchObject({ id: "fixture-extractor" });

    const searchZipPath = path.join(root, "fixture-academic.zip");
    await zipPackageDir(searchPackage, searchZipPath, "fixture-academic");
    const searchInstallPlan = await runCli(root, [
      "providers",
      "install-zip",
      searchZipPath,
      "--kind",
      "search",
      "--json",
    ]);
    expect(searchInstallPlan.stderr).toBe("");
    const searchInstallPlanEnvelope = expectOkEnvelope(
      searchInstallPlan.envelope,
      "provider_install_zip",
    );
    expect(searchInstallPlanEnvelope).toMatchObject({
      planned: true,
      data: {
        apply: false,
        installDir: path.join(installDir, "search"),
        plan: {
          runtimeKind: "search",
          providerKind: "academic",
          id: "fixture-academic",
          installType: "manual-zip",
          bound: false,
          targetPath: path.join(installDir, "search", "fixture-academic"),
        },
      },
    });
    await expect(
      import("node:fs/promises").then((fs) => fs.access(path.join(installDir, "fixture-academic"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      import("node:fs/promises").then((fs) =>
        fs.access(path.join(installDir, "search", "fixture-academic")),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const searchInstall = await runCli(root, [
      "providers",
      "install-zip",
      searchZipPath,
      "--kind",
      "search",
      "--apply",
      "--json",
    ]);
    expect(searchInstall.stderr).toBe("");
    const searchInstallEnvelope = expectOkEnvelope(searchInstall.envelope, "provider_install_zip");
    expect(searchInstallEnvelope.data?.result).toMatchObject({
      id: "fixture-academic",
      installPath: path.join(installDir, "search", "fixture-academic"),
    });

    const searchList = await runCli(root, [
      "providers",
      "list-installed",
      "--kind",
      "search",
      "--json",
    ]);
    expect(searchList.stderr).toBe("");
    const searchListEnvelope = expectOkEnvelope(searchList.envelope, "provider_list_installed");
    expect(searchListEnvelope.data?.installDir).toBe(path.join(installDir, "search"));
    expect(searchListEnvelope.data?.installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fixture-academic", version: "1.0.0", valid: true }),
      ]),
    );
  });

  it("refuses a low-level ZIP install that would duplicate a subscription-managed provider id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-kind-owner-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(installDir, { recursive: true });
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${installDir.replace(/\\/g, "\\\\")}"`,
        "",
        "[workspace]",
        `root = "${workspaceRoot.replace(/\\/g, "\\\\")}"`,
        "",
      ].join("\n"),
      "utf8",
    );

    const managedTarget = path.join(
      root,
      ".test-paper-search-data",
      "providers",
      "material",
      "fixture-academic",
    );
    await mkdir(managedTarget, { recursive: true });
    await writeFile(path.join(managedTarget, "marker.txt"), "managed", "utf8");

    const searchPackage = path.resolve("tests", "fixtures", "provider-packages", "fixture-academic");
    const searchZipPath = path.join(root, "fixture-academic.zip");
    await zipPackageDir(searchPackage, searchZipPath, "fixture-academic");

    const result = await runCli(root, [
      "providers",
      "install-zip",
      searchZipPath,
      "--kind",
      "search",
      "--apply",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.envelope).toMatchObject({
      ok: false,
      capability: "operate",
      tool: "provider_install_zip",
      errors: [expect.stringContaining("subscription-managed material namespace")],
    });
    await expect(readFile(path.join(managedTarget, "marker.txt"), "utf8")).resolves.toBe("managed");
    await expect(
      import("node:fs/promises").then((fs) => fs.access(path.join(installDir, "fixture-academic"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      import("node:fs/promises").then((fs) =>
        fs.access(path.join(installDir, "search", "fixture-academic")),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
