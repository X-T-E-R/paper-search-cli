import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/index.js";
import { readArtifactRecord, resolveArtifactRecordPath } from "../../src/material/artifactStore.js";
import { readExtractionRecord } from "../../src/material/extractionStore.js";
import type {
  MaterialIngestExecutionData,
  MaterialIngestPlanData,
  MaterialIngestResultEnvelope,
} from "../../src/material/ingest.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];
const downloaderFixture = path.resolve(
  "tests",
  "fixtures",
  "material-downloaders",
  "fixture-artifact-downloader",
);
const extractorFixture = path.resolve(
  "tests",
  "fixtures",
  "material-extractors",
  "fixture-markdown-extractor",
);
const mineruFixture = path.resolve(
  "tests",
  "fixtures",
  "material-provider-packages",
  "mineru-extractor",
);

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirs.map(async (dir) => {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }),
  );
  tempDirs.length = 0;
});

function tomlPath(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

async function prepareProviderInstallDir(root: string): Promise<string> {
  const installDir = path.join(root, "providers");
  await mkdir(installDir, { recursive: true });
  await cp(downloaderFixture, path.join(installDir, "fixture-artifact-downloader"), {
    recursive: true,
  });
  await cp(extractorFixture, path.join(installDir, "fixture-markdown-extractor"), {
    recursive: true,
  });
  return installDir;
}

async function writeProjectConfig(root: string, workspaceRoot: string): Promise<void> {
  const installDir = await prepareProviderInstallDir(root);
  await writeFile(
    path.join(root, "paper-search.toml"),
    [
      "[providers]",
      `installDir = "${tomlPath(installDir)}"`,
      "",
      "[workspace]",
      `root = "${tomlPath(workspaceRoot)}"`,
      'defaultCollection = "Inbox"',
      "",
      "[storage]",
      `artifactRoot = "${tomlPath(path.join(root, "artifact-storage"))}"`,
      `extractionRoot = "${tomlPath(path.join(root, "extraction-storage"))}"`,
      `exportRoot = "${tomlPath(path.join(root, "exports"))}"`,
      "",
      "[platform.fixture-artifact-downloader]",
      'mode = "integration"',
      "",
      "[platform.fixture-markdown-extractor]",
      'mode = "integration"',
      "",
    ].join("\n"),
    "utf8",
  );
}

async function createProject(prefix: string): Promise<{
  root: string;
  workspaceRoot: string;
}> {
  const root = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await writeProjectConfig(root, workspaceRoot);
  return { root, workspaceRoot };
}

async function enableMineruProvider(root: string): Promise<void> {
  await cp(mineruFixture, path.join(root, "providers", "mineru-extractor"), { recursive: true });
  await mkdir(path.join(root, "appdata", "paper-search"), { recursive: true });
  await appendFile(
    path.join(root, "paper-search.toml"),
    [
      "[platform.mineru-extractor]",
      'pollIntervalMs = 0',
      'timeoutMs = 5000',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "appdata", "paper-search", "credentials.toml"),
    ["schemaVersion = 1", "", "[platform.mineru-extractor]", 'apiToken = "fixture-token"', ""].join("\n"),
    "utf8",
  );
}

async function runMaterialCommand(root: string, args: string[]): Promise<{
  stdout: string;
  stderr: string;
  envelope: ResultEnvelope;
}> {
  let stdout = "";
  let stderr = "";
  const originalCwd = process.cwd();
  const originalAppData = process.env.APPDATA;
  const originalPaperSearchHome = process.env.PAPER_SEARCH_HOME;

  process.env.APPDATA = path.join(root, "appdata");
  process.env.PAPER_SEARCH_HOME = path.join(root, "appdata", "paper-search");
  process.chdir(root);
  try {
    await buildProgram({
      stdout: { write(chunk: string) { stdout += chunk; } },
      stderr: { write(chunk: string) { stderr += chunk; } },
    })
      .exitOverride()
      .parseAsync(["node", "paper-search", ...args]);
  } finally {
    process.chdir(originalCwd);
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    if (originalPaperSearchHome === undefined) {
      delete process.env.PAPER_SEARCH_HOME;
    } else {
      process.env.PAPER_SEARCH_HOME = originalPaperSearchHome;
    }
  }

  const envelope = JSON.parse(stdout) as ResultEnvelope;
  expect(isResultEnvelope(envelope)).toBe(true);
  return { stdout, stderr, envelope };
}

function expectExecutionData(envelope: ResultEnvelope): MaterialIngestExecutionData {
  expect(envelope).toMatchObject({
    ok: true,
    capability: "orchestrate",
    tool: "material_ingest",
  });
  expect(envelope.planned).toBeUndefined();
  expect(envelope.data).not.toBeNull();
  return envelope.data as MaterialIngestExecutionData;
}

function expectPlanData(envelope: ResultEnvelope): MaterialIngestPlanData {
  expect(envelope).toMatchObject({
    ok: true,
    capability: "orchestrate",
    tool: "material_ingest",
    planned: true,
  });
  expect(envelope.data).not.toBeNull();
  return envelope.data as MaterialIngestPlanData;
}

function replacePlanPlaceholders(value: string, data: MaterialIngestExecutionData): string {
  return value
    .replaceAll("<new-artifact-id>", data.artifact.artifactId)
    .replaceAll("<new-extraction-id>", data.extraction.extractionId);
}

describe("material ingest execution command", () => {
  it("executes URL ingest through fixture artifact and extraction providers and records outputs", async () => {
    const { root, workspaceRoot } = await createProject("paper-search-material-ingest-run-url-");
    const fetchMock = vi.fn(async () => {
      throw new Error("fixture material ingest must not use live fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const planResult = await runMaterialCommand(root, [
      "material",
      "ingest",
      "https://example.test/files/article.pdf",
      "--policy",
      "workspace-safe",
      "--dry-run",
      "--json",
    ]);
    const result = await runMaterialCommand(root, [
      "material",
      "ingest",
      "https://example.test/files/article.pdf",
      "--policy",
      "workspace-safe",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    const plan = expectPlanData(planResult.envelope);
    const data = expectExecutionData(result.envelope);
    expect(data.resource).toMatchObject({
      kind: "url",
      input: "https://example.test/files/article.pdf",
      url: "https://example.test/files/article.pdf",
    });
    expect(data.policy).toEqual({ name: "workspace-safe", attachTo: data.artifact.record.itemId });
    expect(data.artifact).toMatchObject({
      mode: "download",
      artifactId: expect.any(String),
      provider: {
        id: "fixture-artifact-downloader",
        kind: "material",
      },
      record: {
        status: "downloaded",
        itemId: expect.any(String),
        storage: {
          schemaVersion: 1,
          sink: "local",
          area: "artifact",
          root: path.join(root, "artifact-storage"),
          key: `${data.artifact.artifactId}/fixture-download.pdf`,
        },
      },
    });
    expect(data.extraction).toMatchObject({
      extractionId: expect.any(String),
      materialInputKind: "artifact",
      provider: {
        id: "fixture-markdown-extractor",
        kind: "material",
      },
      source: {
        kind: "artifact",
        artifactId: data.artifact.artifactId,
      },
      record: {
        itemId: data.artifact.record.itemId,
        source: {
          kind: "artifact",
          artifactId: data.artifact.artifactId,
        },
      },
    });
    expect(data.providers.selected.map((provider) => provider.id)).toEqual([
      "fixture-artifact-downloader",
      "fixture-markdown-extractor",
    ]);
    expect(plan.providers.selected.map((provider) => provider.id)).toEqual(
      data.providers.selected.map((provider) => provider.id),
    );
    expect(plan.intendedSteps.map((step) => step.id)).toEqual(data.executedSteps.map((step) => step.id));
    expect(data.artifact.recordTargetPath).toBe(replacePlanPlaceholders(plan.artifact.recordTargetPath, data));
    expect(data.extraction.recordTargetPath).toBe(replacePlanPlaceholders(plan.extraction.recordTargetPath, data));
    expect(data.extraction.outputTargetPath).toBe(replacePlanPlaceholders(plan.extraction.outputTargetPath, data));
    expect(data.outputs.artifactRecordPath).toBe(replacePlanPlaceholders(plan.outputs.artifactRecordPath, data));
    expect(data.outputs.extractionRecordPath).toBe(replacePlanPlaceholders(plan.outputs.extractionRecordPath, data));
    expect(data.outputs.extractionOutputPath).toBe(replacePlanPlaceholders(plan.outputs.extractionOutputPath, data));
    expect(data.outputs.markdownPath).toBe(replacePlanPlaceholders(plan.outputs.markdownPath, data));
    expect(data.outputs.jsonPath).toBe(replacePlanPlaceholders(plan.outputs.jsonPath, data));
    expect(data.executedSteps.map((step) => step.id)).toEqual([
      "resource.resolve-url",
      "artifact.load-downloader",
      "artifact.run-downloader",
      "artifact.write-artifact",
      "artifact.select-downloaded-resource",
      "artifact.record-artifact",
      "extraction.load-extractor",
      "extraction.run-extractor",
      "extraction.write-markdown",
      "extraction.record-extraction",
    ]);
    expect(data.outputs.artifactFilePath).toBe(path.join(root, "artifact-storage", data.artifact.artifactId, "fixture-download.pdf"));
    await expect(readFile(data.outputs.artifactFilePath!, "utf8")).resolves.toBe("fixture downloader bytes\n");
    await expect(readArtifactRecord(workspaceRoot, data.artifact.artifactId)).resolves.toMatchObject({
      id: data.artifact.artifactId,
      status: "downloaded",
    });
    await expect(readExtractionRecord(workspaceRoot, data.extraction.extractionId)).resolves.toMatchObject({
      id: data.extraction.extractionId,
      source: {
        kind: "artifact",
        artifactId: data.artifact.artifactId,
      },
      backend: "fixture-markdown-extractor",
    });
    await expect(readFile(data.outputs.markdownPath, "utf8")).resolves.toContain("Source kind: artifact");
    await expect(readFile(data.outputs.markdownPath, "utf8")).resolves.toContain(
      `Source: ${data.artifact.artifactId}`,
    );
    await expect(readFile(data.outputs.extractionRecordPath, "utf8")).resolves.toContain(
      data.extraction.extractionId,
    );
  });

  it("copies a local file into managed artifact storage and extracts by durable artifact id", async () => {
    const { root, workspaceRoot } = await createProject("paper-search-material-ingest-run-path-");
    await writeFile(
      path.join(root, "providers", "fixture-markdown-extractor", "provider.js"),
      [
        "var __material_provider_exports = {",
        "  createProvider() {",
        "    return {",
        "      async extract(input) {",
        "        const artifactPath = input && input.artifact && input.artifact.path;",
        "        if (typeof artifactPath !== \"string\" || artifactPath.length === 0) {",
        "          throw new Error(\"managed artifact path is required\");",
        "        }",
        "        return { markdown: `Managed artifact path: ${artifactPath}\\n`, cacheHit: false };",
        "      }",
        "    };",
        "  }",
        "};",
        "globalThis.__material_provider_exports = __material_provider_exports;",
        "",
      ].join("\n"),
      "utf8",
    );
    const inputDir = path.join(root, "inputs");
    await mkdir(inputDir, { recursive: true });
    const inputPath = path.join(inputDir, "paper.txt");
    const sourceBytes = Buffer.from("fixture source body\n", "utf8");
    const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
    await writeFile(inputPath, sourceBytes);
    const fetchMock = vi.fn(async () => {
      throw new Error("local material ingest must not use live fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runMaterialCommand(root, [
      "material",
      "ingest",
      inputPath,
      "--policy",
      "local-safe",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    const data = expectExecutionData(result.envelope);
    expect(data.artifact).toMatchObject({
      mode: "record_local",
      artifactId: expect.any(String),
      provider: {
        id: "builtin-local-artifact",
        kind: "builtin",
      },
      source: {
        kind: "path",
        path: inputPath,
      },
      record: {
        status: "recorded",
        itemId: expect.any(String),
        filename: "paper.txt",
        contentType: "text/plain",
        sizeBytes: sourceBytes.byteLength,
        storage: {
          schemaVersion: 1,
          sink: "local",
          area: "artifact",
          root: path.join(root, "artifact-storage"),
          key: `${data.artifact.artifactId}/paper.txt`,
          sha256: sourceDigest,
          sizeBytes: sourceBytes.byteLength,
        },
        provenance: {
          origin: "user_supplied",
          providerId: "builtin-local-artifact",
          policy: "local-safe",
        },
      },
    });
    expect(data.outputs.artifactFilePath).toBe(
      path.join(root, "artifact-storage", data.artifact.artifactId, "paper.txt"),
    );
    expect(data.extraction).toMatchObject({
      materialInputKind: "artifact",
      source: {
        kind: "artifact",
        artifactId: data.artifact.artifactId,
      },
      record: {
        itemId: data.artifact.record.itemId,
        source: {
          kind: "artifact",
          artifactId: data.artifact.artifactId,
        },
      },
    });
    const storedRecord = await readArtifactRecord(workspaceRoot, data.artifact.artifactId);
    expect(storedRecord).toMatchObject({
      id: data.artifact.artifactId,
      status: "recorded",
      storage: data.artifact.record.storage,
    });
    expect(storedRecord).not.toBeNull();
    await expect(resolveArtifactRecordPath(workspaceRoot, storedRecord!)).resolves.toBe(
      data.outputs.artifactFilePath,
    );
    await expect(readFile(data.outputs.artifactFilePath!)).resolves.toEqual(sourceBytes);
    await expect(readFile(inputPath)).resolves.toEqual(sourceBytes);
    await expect(readExtractionRecord(workspaceRoot, data.extraction.extractionId)).resolves.toMatchObject({
      id: data.extraction.extractionId,
      source: {
        kind: "artifact",
        artifactId: data.artifact.artifactId,
      },
      backend: "fixture-markdown-extractor",
    });
    await expect(readFile(data.outputs.markdownPath, "utf8")).resolves.toBe(
      `Managed artifact path: ${data.outputs.artifactFilePath}\n`,
    );
    await expect(readFile(data.outputs.markdownPath, "utf8")).resolves.not.toContain(inputPath);
    await expect(readFile(data.outputs.artifactRecordPath, "utf8")).resolves.toContain(data.artifact.artifactId);

    await rm(inputPath);
    const laterExtraction = await runMaterialCommand(root, [
      "extract",
      data.artifact.artifactId,
      "--provider",
      "fixture-markdown-extractor",
      "--json",
    ]);
    expect(laterExtraction.stderr).toBe("");
    expect(laterExtraction.envelope).toMatchObject({
      ok: true,
      capability: "extract",
      tool: "extract",
      data: {
        record: {
          source: {
            kind: "artifact",
            artifactId: data.artifact.artifactId,
          },
        },
      },
    });
  });

  it("returns a compact recovery command when extraction fails after the selected artifact is committed", async () => {
    const { root, workspaceRoot } = await createProject("paper-search-material-ingest-run-extraction-failure-");
    await appendFile(
      path.join(root, "paper-search.toml"),
      ['[zoteroBinding]', 'mode = "bound"', 'collectionKeys = ["RECOVERY1"]', ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, "providers", "fixture-markdown-extractor", "provider.js"),
      [
        "var __material_provider_exports = {",
        "  createProvider() {",
        "    return { async extract() { throw new Error(\"fixture extraction unavailable\"); } };",
        "  }",
        "};",
        "globalThis.__material_provider_exports = __material_provider_exports;",
        "",
      ].join("\n"),
      "utf8",
    );
    const inputDir = path.join(root, "inputs");
    const inputPath = path.join(inputDir, "paper.pdf");
    await mkdir(inputDir, { recursive: true });
    await writeFile(inputPath, "%PDF-fixture\n", "utf8");

    const result = await runMaterialCommand(root, ["material", "ingest", inputPath, "--json"]);

    expect(result.stderr).toBe("");
    expect(result.envelope).toMatchObject({
      ok: false,
      capability: "orchestrate",
      tool: "material_ingest",
      data: null,
      diagnostics: {
        workspaceRoot,
        partial: true,
        commitStage: "extraction",
        artifactId: expect.any(String),
        artifactPath: expect.any(String),
        artifactRecordPath: expect.any(String),
        attachTo: expect.any(String),
        recoveryCommand: expect.stringMatching(
          /^paper-search extract [A-Za-z0-9._-]+ --provider fixture-markdown-extractor --attach-to [A-Za-z0-9._-]+ --json$/u,
        ),
        zoteroSync: "pending",
      },
      errors: [expect.stringContaining("fixture extraction unavailable")],
    });
    const diagnostics = result.envelope.diagnostics!;
    const artifactId = String(diagnostics.artifactId);
    const itemId = String(diagnostics.attachTo);
    await expect(readArtifactRecord(workspaceRoot, artifactId)).resolves.toMatchObject({
      id: artifactId,
      itemId,
      status: "recorded",
    });
    await expect(readFile(String(diagnostics.artifactPath), "utf8")).resolves.toBe("%PDF-fixture\n");
    await expect(readFile(path.join(workspaceRoot, "items", `${itemId}.json`), "utf8"))
      .resolves.toContain(itemId);
    await expect(readdir(path.join(workspaceRoot, "zotero", "receipts"))).resolves.toHaveLength(1);
    await expect(stat(path.join(root, "extraction-storage"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before metadata or extraction writes when configured artifact storage is not a directory", async () => {
    const { root, workspaceRoot } = await createProject("paper-search-material-ingest-run-path-collision-");
    const inputDir = path.join(root, "inputs");
    const inputPath = path.join(inputDir, "paper.txt");
    await mkdir(inputDir, { recursive: true });
    await writeFile(inputPath, "source remains unchanged\n", "utf8");
    await writeFile(path.join(root, "artifact-storage"), "not a directory\n", "utf8");

    const result = await runMaterialCommand(root, [
      "material",
      "ingest",
      inputPath,
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.envelope).toMatchObject({
      ok: false,
      capability: "orchestrate",
      tool: "material_ingest",
      data: null,
    });
    expect(result.envelope.errors).toEqual(["Local storage root must be a real directory"]);
    await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(root, "extraction-storage"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(inputPath, "utf8")).resolves.toBe("source remains unchanged\n");
    await expect(readFile(path.join(root, "artifact-storage"), "utf8")).resolves.toBe("not a directory\n");
  });

  it("returns a typed orphan without deleting managed bytes when default selection cannot be committed", async () => {
    const { root, workspaceRoot } = await createProject("paper-search-material-ingest-run-path-orphan-");
    const inputDir = path.join(root, "inputs");
    const inputPath = path.join(inputDir, "paper.txt");
    const sourceBytes = Buffer.from("orphaned managed bytes remain\n", "utf8");
    const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(inputDir, { recursive: true });
    await writeFile(inputPath, sourceBytes);
    await writeFile(workspaceRoot, "workspace path collision\n", "utf8");

    const result = await runMaterialCommand(root, [
      "material",
      "ingest",
      inputPath,
      "--json",
    ]);

    expect(result.stderr).toBe("");
    const envelope = result.envelope as MaterialIngestResultEnvelope;
    expect(envelope).toMatchObject({
      ok: false,
      capability: "orchestrate",
      tool: "material_ingest",
      data: null,
      diagnostics: {
        inputKind: "path",
        extractionInputKind: "artifact",
        workspaceRoot,
        partial: true,
        orphanedBytes: true,
        commitStage: "selection",
      },
      provenance: {
        providerIds: ["builtin-local-artifact"],
      },
      orphan: {
        outcome: "orphaned",
        commitStage: "selection",
        artifactId: expect.any(String),
        artifactPath: expect.any(String),
        storage: {
          schemaVersion: 1,
          sink: "local",
          area: "artifact",
          root: path.join(root, "artifact-storage"),
          key: expect.stringMatching(/^[^/]+\/paper\.txt$/u),
          sha256: sourceDigest,
          sizeBytes: sourceBytes.byteLength,
        },
        sha256: sourceDigest,
        sizeBytes: sourceBytes.byteLength,
        metadataPath: expect.any(String),
        error: expect.any(String),
      },
    });
    expect(envelope.orphan).toBeDefined();
    expect(envelope.orphan!.metadataPath).toBe(
      path.join(workspaceRoot, "material", "artifacts", `${envelope.orphan!.artifactId}.json`),
    );
    expect(envelope.orphan!.artifactPath).toBe(
      path.join(root, "artifact-storage", envelope.orphan!.artifactId, "paper.txt"),
    );
    await expect(readFile(envelope.orphan!.artifactPath)).resolves.toEqual(sourceBytes);
    await expect(readFile(inputPath)).resolves.toEqual(sourceBytes);
    await expect(readFile(workspaceRoot, "utf8")).resolves.toBe("workspace path collision\n");
    await expect(stat(path.join(root, "extraction-storage"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes URL ingest with the MinerU extractor provider through offline fetch stubs", async () => {
    const { root, workspaceRoot } = await createProject("paper-search-material-ingest-run-mineru-");
    await enableMineruProvider(root);

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (method === "POST" && url === "https://mineru.net/api/v4/extract/task") {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { task_id: "task_material_ingest_mineru", state: "submitted" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (method === "GET" && url === "https://mineru.net/api/v4/extract/task/task_material_ingest_mineru") {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              task_id: "task_material_ingest_mineru",
              state: "done",
              markdown: "# MinerU material ingest\n",
              full_zip_url: "https://oss.aliyuncs.com/mineru/task_material_ingest_mineru.zip",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected offline fetch during MinerU material ingest test: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const planResult = await runMaterialCommand(root, [
      "material",
      "ingest",
      "https://example.test/files/mineru.pdf",
      "--attach-to",
      "item-123",
      "--artifact-provider",
      "fixture-artifact-downloader",
      "--extract-provider",
      "mineru-extractor",
      "--dry-run",
      "--json",
    ]);
    const result = await runMaterialCommand(root, [
      "material",
      "ingest",
      "https://example.test/files/mineru.pdf",
      "--attach-to",
      "item-123",
      "--artifact-provider",
      "fixture-artifact-downloader",
      "--extract-provider",
      "mineru-extractor",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    const plan = expectPlanData(planResult.envelope);
    const data = expectExecutionData(result.envelope);
    expect(plan.providers.selected.map((provider) => provider.id)).toEqual([
      "fixture-artifact-downloader",
      "mineru-extractor",
    ]);
    expect(plan.extraction.provider).toMatchObject({
      id: "mineru-extractor",
      kind: "material",
    });
    expect(data.providers.selected.map((provider) => provider.id)).toEqual([
      "fixture-artifact-downloader",
      "mineru-extractor",
    ]);
    expect(data.extraction).toMatchObject({
      materialInputKind: "artifact",
      provider: {
        id: "mineru-extractor",
        kind: "material",
      },
      source: {
        kind: "artifact",
        artifactId: data.artifact.artifactId,
      },
      record: {
        itemId: "item-123",
        backend: "mineru-extractor",
        source: {
          kind: "artifact",
          artifactId: data.artifact.artifactId,
        },
      },
      markdown: "# MinerU material ingest\n",
    });
    expect(data.outputs.markdownPath).toBe(replacePlanPlaceholders(plan.outputs.markdownPath, data));
    expect(plan.intendedSteps.map((step) => step.id)).toEqual(data.executedSteps.map((step) => step.id));
    await expect(readExtractionRecord(workspaceRoot, data.extraction.extractionId)).resolves.toMatchObject({
      id: data.extraction.extractionId,
      backend: "mineru-extractor",
      source: {
        kind: "artifact",
        artifactId: data.artifact.artifactId,
      },
      message: "MinerU result zip: https://oss.aliyuncs.com/mineru/task_material_ingest_mineru.zip",
    });
    await expect(readFile(data.outputs.markdownPath, "utf8")).resolves.toBe("# MinerU material ingest\n");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(([input, init]) => ({
        method: init?.method ?? "GET",
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      })),
    ).toEqual([
      { method: "POST", url: "https://mineru.net/api/v4/extract/task" },
      { method: "GET", url: "https://mineru.net/api/v4/extract/task/task_material_ingest_mineru" },
    ]);
  });
});
