import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildProgram } from "../../src/program.js";
import { isResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];

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

async function createProviderZip(outputPath: string, id: string, version: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({
      id,
      name: id,
      version,
      sourceType: "academic",
      permissions: { urls: ["https://example.com/*"] },
    }),
  );
  zip.file(
    "provider.js",
    "var __zrs_exports={createProvider(){return {async search(query){return {platform:'test',query,totalResults:0,items:[],page:1};}}}};globalThis.__zrs_exports=__zrs_exports;",
  );
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(outputPath, bytes);
}

describe("provider registry commands", () => {
  it("reports source, view, alias, service-family, and retained counts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registry-inventory-"));
    tempDirs.push(root);
    const registryPath = path.join(root, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        providers: [
          { id: "crossref", version: "1.0.0", downloadUrl: "./crossref.zip" },
          { id: "acm", version: "1.0.0", downloadUrl: "./acm.zip" },
        ],
        inventory: [
          {
            id: "crossref",
            kind: "search",
            sourceType: "academic",
            entryKind: "source",
            sourceId: "org.crossref.works",
            aliases: ["cross_ref"],
            serviceFamily: "org.crossref.api",
            transport: "api",
            domains: ["multidisciplinary"],
            contentKinds: ["journal-article"],
            access: ["public"],
            selection: { defaultInAll: true },
            publication: { status: "published" },
          },
          {
            id: "acm",
            kind: "search",
            sourceType: "academic",
            entryKind: "view",
            backingSourceIds: ["org.crossref.works"],
            serviceFamily: "org.crossref.api",
            transport: "api",
            domains: ["computer-science"],
            contentKinds: ["conference-paper"],
            access: ["public"],
            selection: { defaultInAll: false },
            publication: { status: "published" },
          },
          {
            id: "googlescholar",
            kind: "search",
            sourceType: "academic",
            entryKind: "source",
            sourceId: "com.google.scholar",
            serviceFamily: "com.google.scholar-web",
            transport: "html",
            domains: ["multidisciplinary"],
            contentKinds: ["journal-article"],
            access: ["public"],
            selection: { defaultInAll: false },
            publication: {
              status: "retained-unpublished",
              blockers: ["fixture gate pending"],
            },
          },
        ],
      }),
      "utf8",
    );

    let stdout = "";
    let stderr = "";
    await buildProgram({
      stdout: { write(chunk: string) { stdout += chunk; } },
      stderr: { write(chunk: string) { stderr += chunk; } },
    }).parseAsync([
      "node",
      "paper-search",
      "providers",
      "inventory",
      registryPath,
      "--json",
    ]);

    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      tool: "provider_registry_inventory",
      data: {
        counts: {
          entries: 3,
          publishedEntries: 2,
          publishedSearchSources: 1,
          publishedViews: 1,
          publishedGeneralPresetMembers: 1,
          publishedDefaultInAll: 1,
          retainedUnpublishedEntries: 1,
          aliases: 1,
          publishedServiceFamilies: 1,
          unknownClassification: 0,
        },
        facets: {
          domains: { "computer-science": 1, multidisciplinary: 2 },
        },
      },
    });
  });

  it("plans and applies registry actions through the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registry-cli-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const registryDir = path.join(root, "registry");
    await mkdir(installDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });
    await createProviderZip(path.join(registryDir, "alpha.zip"), "alpha", "1.0.0");
    await writeFile(
      path.join(registryDir, "registry.json"),
      JSON.stringify({
        providers: [{ id: "alpha", version: "1.0.0", downloadUrl: "./alpha.zip" }],
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, "paper-search.toml"),
      ["[providers]", `installDir = \"${installDir.replace(/\\/g, "\\\\")}\"`, ""].join("\n"),
      "utf8",
    );

    let stdout = "";
    let stderr = "";
    const originalCwd = process.cwd();
    const originalTestMode = process.env.PAPER_SEARCH_INSTALL_TEST_MODE;
    const originalDataRoot = process.env.PAPER_SEARCH_TEST_DATA_ROOT;
    process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
    process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(root, "data");
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write(chunk: string) { stderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "providers",
        "sync-registry",
        path.join(registryDir, "registry.json"),
        "--apply",
        "--json",
      ]);
    } finally {
      process.chdir(originalCwd);
      if (originalTestMode === undefined) delete process.env.PAPER_SEARCH_INSTALL_TEST_MODE;
      else process.env.PAPER_SEARCH_INSTALL_TEST_MODE = originalTestMode;
      if (originalDataRoot === undefined) delete process.env.PAPER_SEARCH_TEST_DATA_ROOT;
      else process.env.PAPER_SEARCH_TEST_DATA_ROOT = originalDataRoot;
    }

    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(isResultEnvelope(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      capability: "operate",
      tool: "provider_registry_apply",
    });
    expect(parsed.data.summary.applied).toHaveLength(1);
    expect(parsed.data.summary.applied[0].id).toBe("alpha");
    expect(parsed.data.plan.entries[0].action).toBe("install");
    expect(parsed.data.installDir).toBe(path.join(installDir, "search"));
    expect(parsed.data.plan.entries[0].installPath).toBe(path.join(installDir, "search", "alpha"));
    expect(JSON.parse(await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(installDir, "search", "alpha", ".paper-search-receipt.json"), "utf8"))))
      .toMatchObject({ installType: "manual-zip", bound: false, id: "alpha" });
    await expect(access(path.join(installDir, "alpha"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records each completed provider before a later registry entry fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registry-cli-partial-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const registryDir = path.join(root, "registry");
    const dataRoot = path.join(root, "data");
    await mkdir(installDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });
    await createProviderZip(path.join(registryDir, "alpha.zip"), "alpha", "1.0.0");
    await writeFile(
      path.join(registryDir, "registry.json"),
      JSON.stringify({
        providers: [
          { id: "alpha", version: "1.0.0", downloadUrl: "./alpha.zip" },
          { id: "zeta", version: "1.0.0", downloadUrl: "./missing-zeta.zip" },
        ],
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, "paper-search.toml"),
      ["[providers]", `installDir = "${installDir.replace(/\\/g, "\\\\")}"`, ""].join("\n"),
      "utf8",
    );

    let stdout = "";
    let stderr = "";
    const originalCwd = process.cwd();
    const originalTestMode = process.env.PAPER_SEARCH_INSTALL_TEST_MODE;
    const originalDataRoot = process.env.PAPER_SEARCH_TEST_DATA_ROOT;
    process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
    process.env.PAPER_SEARCH_TEST_DATA_ROOT = dataRoot;
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write(chunk: string) { stderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "providers",
        "sync-registry",
        path.join(registryDir, "registry.json"),
        "--apply",
        "--json",
      ]);
    } finally {
      process.chdir(originalCwd);
      if (originalTestMode === undefined) delete process.env.PAPER_SEARCH_INSTALL_TEST_MODE;
      else process.env.PAPER_SEARCH_INSTALL_TEST_MODE = originalTestMode;
      if (originalDataRoot === undefined) delete process.env.PAPER_SEARCH_TEST_DATA_ROOT;
      else process.env.PAPER_SEARCH_TEST_DATA_ROOT = originalDataRoot;
    }

    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      tool: "provider_registry_apply",
      errors: [expect.stringContaining("missing-zeta.zip")],
    });
    await expect(access(path.join(installDir, "search", "alpha"))).resolves.toBeUndefined();
    await expect(access(path.join(installDir, "search", "zeta"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(installDir, "alpha"))).rejects.toMatchObject({ code: "ENOENT" });
    const eventDir = path.join(dataRoot, "state", "events");
    const eventFiles = await readdir(eventDir);
    const events = (await Promise.all(eventFiles.map((name) => readFile(path.join(eventDir, name), "utf8"))))
      .flatMap((raw) => raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    expect(events).toEqual([
      expect.objectContaining({
        command: "providers sync-registry",
        affectedIds: ["alpha"],
        archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        outcome: "applied",
      }),
    ]);
  });
});
