import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/index.js";
import { readArtifactRecord } from "../../src/material/artifactStore.js";
import { readExtractionRecord } from "../../src/material/extractionStore.js";
import type { MaterialIngestExecutionData, MaterialIngestPlanData } from "../../src/material/ingest.js";
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
      "--attach-to",
      "item-123",
      "--policy",
      "workspace-safe",
      "--dry-run",
      "--json",
    ]);
    const result = await runMaterialCommand(root, [
      "material",
      "ingest",
      "https://example.test/files/article.pdf",
      "--attach-to",
      "item-123",
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
    expect(data.policy).toEqual({ name: "workspace-safe", attachTo: "item-123" });
    expect(data.artifact).toMatchObject({
      mode: "download",
      artifactId: expect.any(String),
      provider: {
        id: "fixture-artifact-downloader",
        kind: "material",
      },
      record: {
        status: "downloaded",
        itemId: "item-123",
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
        itemId: "item-123",
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

  it("records a local file artifact and extracts Markdown without using a downloader", async () => {
    const { root, workspaceRoot } = await createProject("paper-search-material-ingest-run-path-");
    const inputDir = path.join(root, "inputs");
    await mkdir(inputDir, { recursive: true });
    const inputPath = path.join(inputDir, "paper.txt");
    await writeFile(inputPath, "fixture source body\n", "utf8");
    const fetchMock = vi.fn(async () => {
      throw new Error("local material ingest must not use live fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runMaterialCommand(root, [
      "material",
      "ingest",
      inputPath,
      "--attach-to",
      "item-123",
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
        itemId: "item-123",
        filename: "paper.txt",
        contentType: "text/plain",
        provenance: {
          origin: "user_supplied",
          providerId: "builtin-local-artifact",
          policy: "local-safe",
        },
      },
    });
    expect(data.outputs.artifactFilePath).toBeUndefined();
    expect(data.extraction).toMatchObject({
      materialInputKind: "local_file",
      source: {
        kind: "path",
        path: inputPath,
      },
      record: {
        itemId: "item-123",
        source: {
          kind: "path",
          path: inputPath,
        },
      },
    });
    await expect(readArtifactRecord(workspaceRoot, data.artifact.artifactId)).resolves.toMatchObject({
      id: data.artifact.artifactId,
      status: "recorded",
    });
    await expect(readExtractionRecord(workspaceRoot, data.extraction.extractionId)).resolves.toMatchObject({
      id: data.extraction.extractionId,
      source: {
        kind: "path",
        path: inputPath,
      },
      backend: "fixture-markdown-extractor",
    });
    await expect(readFile(data.outputs.markdownPath, "utf8")).resolves.toContain("Source kind: path");
    await expect(readFile(data.outputs.markdownPath, "utf8")).resolves.toContain(`Source: ${inputPath}`);
    await expect(readFile(data.outputs.artifactRecordPath, "utf8")).resolves.toContain(data.artifact.artifactId);
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
