import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/index.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";
import type { MaterialIngestPlanData } from "../../src/material/ingest.js";
import { addResourceToWorkspace } from "../../src/workspace/store.js";

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

async function runMaterialCommand(root: string, args: string[]): Promise<{
  stdout: string;
  stderr: string;
  envelope: ResultEnvelope;
}> {
  let stdout = "";
  let stderr = "";
  const originalCwd = process.cwd();
  const originalAppData = process.env.APPDATA;

  process.env.APPDATA = path.join(root, "appdata");
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
  }

  const envelope = JSON.parse(stdout) as ResultEnvelope;
  expect(isResultEnvelope(envelope)).toBe(true);
  return { stdout, stderr, envelope };
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

async function expectNoMaterialWorkspaceWrites(workspaceRoot: string): Promise<void> {
  await expect(stat(path.join(workspaceRoot, "material"))).rejects.toMatchObject({ code: "ENOENT" });
}

describe("material ingest plan command", () => {
  it("plans URL ingest through artifact and extraction providers without workspace writes", async () => {
    const { root, workspaceRoot } = await createProject("paper-search-material-ingest-url-");
    const fetchMock = vi.fn(async () => {
      throw new Error("dry-run must not use live fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runMaterialCommand(root, [
      "material",
      "ingest",
      "https://example.test/files/article.pdf",
      "--dry-run",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    const data = expectPlanData(result.envelope);
    expect(data.resource).toMatchObject({
      kind: "url",
      input: "https://example.test/files/article.pdf",
      url: "https://example.test/files/article.pdf",
    });
    expect(data.policy).toEqual({ name: "default", attachTo: null });
    expect(data.artifact).toMatchObject({
      mode: "download",
      plannedArtifactId: "<new-artifact-id>",
      provider: {
        id: "fixture-artifact-downloader",
        kind: "material",
      },
    });
    expect(data.extraction).toMatchObject({
      plannedExtractionId: "<new-extraction-id>",
      materialInputKind: "artifact",
      provider: {
        id: "fixture-markdown-extractor",
        kind: "material",
      },
      source: {
        kind: "artifact",
        artifactId: "<new-artifact-id>",
        url: "https://example.test/files/article.pdf",
      },
    });
    expect(data.providers.selected.map((provider) => provider.id)).toEqual([
      "fixture-artifact-downloader",
      "fixture-markdown-extractor",
    ]);
    expect(data.artifact.recordTargetPath).toBe(
      path.join(workspaceRoot, "material", "artifacts", "<new-artifact-id>.json"),
    );
    expect(data.extraction.recordTargetPath).toBe(
      path.join(workspaceRoot, "material", "extractions", "<new-extraction-id>.json"),
    );
    expect(data.outputs.artifactRecordPath).toBe(
      path.join(workspaceRoot, "material", "artifacts", "<new-artifact-id>.json"),
    );
    expect(data.outputs.extractionRecordPath).toBe(
      path.join(workspaceRoot, "material", "extractions", "<new-extraction-id>.json"),
    );
    expect(data.outputs.artifactFilePath).toBeUndefined();
    expect(data.intendedSteps.find((step) => step.id === "artifact.record-artifact")?.targetPaths).toEqual([
      path.join(workspaceRoot, "material", "artifacts", "<new-artifact-id>.json"),
    ]);
    expect(data.intendedSteps.find((step) => step.id === "extraction.write-markdown")?.targetPaths).toEqual([
      path.join(root, "extraction-storage", "<new-extraction-id>"),
      path.join(root, "extraction-storage", "<new-extraction-id>", "content.md"),
      path.join(root, "extraction-storage", "<new-extraction-id>", "result.json"),
    ]);
    expect(data.intendedSteps.find((step) => step.id === "extraction.record-extraction")?.targetPaths).toEqual([
      path.join(workspaceRoot, "material", "extractions", "<new-extraction-id>.json"),
    ]);
    expect(data.intendedSteps.map((step) => step.id)).toEqual([
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
    expect(JSON.stringify(data.outputs)).toContain("<new-artifact-id>");
    expect(JSON.stringify(data.outputs)).toContain("<new-extraction-id>");
    await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("plans local file ingest by recording a local artifact and extracting it without workspace writes", async () => {
    const { root, workspaceRoot } = await createProject("paper-search-material-ingest-path-");
    const inputDir = path.join(root, "inputs");
    await mkdir(inputDir, { recursive: true });
    const inputPath = path.join(inputDir, "paper.txt");
    await writeFile(inputPath, "fixture source body\n", "utf8");

    const result = await runMaterialCommand(root, [
      "material",
      "ingest",
      inputPath,
      "--attach-to",
      "item-123",
      "--policy",
      "workspace-safe",
      "--dry-run",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    const data = expectPlanData(result.envelope);
    expect(data.resource).toMatchObject({
      kind: "path",
      input: inputPath,
      path: inputPath,
    });
    expect(data.policy).toEqual({ name: "workspace-safe", attachTo: "item-123" });
    expect(data.artifact).toMatchObject({
      mode: "record_local",
      plannedArtifactId: "<new-artifact-id>",
      provider: {
        id: "builtin-local-artifact",
        kind: "builtin",
      },
      source: {
        kind: "path",
        path: inputPath,
      },
    });
    expect(data.artifact.recordTargetPath).toBe(
      path.join(workspaceRoot, "material", "artifacts", "<new-artifact-id>.json"),
    );
    expect(data.outputs.artifactRecordPath).toBe(
      path.join(workspaceRoot, "material", "artifacts", "<new-artifact-id>.json"),
    );
    expect(data.extraction).toMatchObject({
      materialInputKind: "local_file",
      provider: {
        id: "fixture-markdown-extractor",
        kind: "material",
      },
      source: {
        kind: "path",
        path: inputPath,
      },
    });
    expect(data.intendedSteps.map((step) => step.id)).toContain("artifact.record-local-artifact");
    expect(data.intendedSteps.find((step) => step.id === "artifact.record-local-artifact")?.targetPaths).toEqual([
      path.join(workspaceRoot, "material", "artifacts", "<new-artifact-id>.json"),
    ]);
    expect(data.outputs.markdownPath).toContain("<new-extraction-id>");
    await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("plans workspace item ingest by reading the existing item only and leaving material dirs untouched", async () => {
    const { root, workspaceRoot } = await createProject("paper-search-material-ingest-item-");
    const addResult = await addResourceToWorkspace(workspaceRoot, {
      item: {
        itemType: "journalArticle",
        title: "Workspace Item",
        url: "https://example.test/files/workspace-item.pdf",
      },
      defaultCollectionPath: "Inbox",
    });

    const result = await runMaterialCommand(root, [
      "material",
      "ingest",
      addResult.record.id,
      "--policy",
      "library-safe",
      "--dry-run",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    const data = expectPlanData(result.envelope);
    expect(data.resource).toMatchObject({
      kind: "workspace_item",
      input: addResult.record.id,
      itemId: addResult.record.id,
      title: "Workspace Item",
      url: "https://example.test/files/workspace-item.pdf",
    });
    expect(data.policy).toEqual({ name: "library-safe", attachTo: addResult.record.id });
    expect(data.artifact.source).toEqual({
      kind: "workspace_item",
      itemId: addResult.record.id,
      url: "https://example.test/files/workspace-item.pdf",
    });
    expect(data.intendedSteps[0]).toMatchObject({
      id: "resource.resolve-workspace-item",
      action: "read",
      targetPaths: [path.join(workspaceRoot, "items", `${addResult.record.id}.json`)],
    });
    await expectNoMaterialWorkspaceWrites(workspaceRoot);
  });

  it("returns a fail envelope for an unknown input without creating workspace state", async () => {
    const { root, workspaceRoot } = await createProject("paper-search-material-ingest-invalid-");

    const result = await runMaterialCommand(root, [
      "material",
      "ingest",
      "unknown-item",
      "--dry-run",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.envelope).toMatchObject({
      ok: false,
      capability: "orchestrate",
      tool: "material_ingest",
      data: null,
      errors: [
        "Input is not an http(s) URL, DOI, existing local file, or known workspace item id: unknown-item",
      ],
    });
    await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
