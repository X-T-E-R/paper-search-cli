import { cp, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/program.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";
import { addResourceToWorkspace } from "../../src/workspace/store.js";

const tempDirs: string[] = [];
const materialDownloaderFixture = path.resolve(
  "tests",
  "fixtures",
  "material-downloaders",
  "fixture-artifact-downloader",
);
const materialExtractorFixture = path.resolve(
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
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
      } catch {
        // ignore cleanup failures
      }
    }),
  );
  tempDirs.length = 0;
});

async function installFixtureProvider(root: string): Promise<string> {
  const installDir = path.join(root, "providers");
  await mkdir(path.join(installDir, "fixture-academic-searchable"), { recursive: true });
  const fixtureDir = path.resolve(
    "tests",
    "fixtures",
    "provider-packages",
    "fixture-academic-searchable",
  );
  await writeFile(
    path.join(installDir, "fixture-academic-searchable", "manifest.json"),
    await readFile(path.join(fixtureDir, "manifest.json"), "utf8"),
    "utf8",
  );
  await writeFile(
    path.join(installDir, "fixture-academic-searchable", "provider.js"),
    await readFile(path.join(fixtureDir, "provider.js"), "utf8"),
    "utf8",
  );
  return installDir;
}

async function installMaterialFixtureProviders(root: string): Promise<string> {
  const installDir = path.join(root, "material-providers");
  await mkdir(installDir, { recursive: true });
  await cp(materialDownloaderFixture, path.join(installDir, "fixture-artifact-downloader"), {
    recursive: true,
  });
  await cp(materialExtractorFixture, path.join(installDir, "fixture-markdown-extractor"), {
    recursive: true,
  });
  return installDir;
}

function tomlPath(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

async function runBatchCommand(root: string, args: string[]): Promise<{ stderr: string }> {
  let stderr = "";
  const originalCwd = process.cwd();
  const originalAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(root, "appdata");
  process.chdir(root);
  try {
    await buildProgram({
      stdout: { write() {} },
      stderr: { write(chunk: string) { stderr += chunk; } },
    }).parseAsync(["node", "paper-search", ...args]);
  } finally {
    process.chdir(originalCwd);
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
  }
  return { stderr };
}

async function readJsonlObjects(filePath: string): Promise<Record<string, unknown>[]> {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function requireResultEnvelopeRow(row: Record<string, unknown> | undefined): ResultEnvelope {
  if (!row || !isResultEnvelope(row)) {
    throw new Error("Expected material batch row to be a ResultEnvelope");
  }
  return row;
}

describe("batch command", () => {
  it("runs academic and direct-add rows, writes JSONL, and stores mapped collections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-batch-cli-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const installDir = await installFixtureProvider(root);
    const batchPath = path.join(root, "tasks.json");
    const outPath = path.join(root, "results.jsonl");

    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = \"${installDir.replace(/\\/g, "\\\\")}\"`,
        "",
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
        "",
        "[zoteroBinding]",
        'mode = "bound"',
        'collectionKeys = ["BATCH1"]',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      batchPath,
      JSON.stringify(
        [
          {
            task_id: "A1",
            tool: "academic_search",
            query: "rag evaluation",
            save_policy: "import-first",
            target_collection: "Search Target",
            tags: "alpha;beta",
          },
          {
            task_id: "A2",
            tool: "resource_add",
            target_collection: "Manual Target",
            tags: "gamma",
            item: {
              itemType: "journalArticle",
              title: "Manual batch resource",
              url: "https://manual.example/item",
            },
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    let stderr = "";
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write() {} },
        stderr: { write(chunk: string) { stderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "batch",
        batchPath,
        "--default-platform",
        "fixture-academic-searchable",
        "--collection-map",
        JSON.stringify({
          "Search Target": "Research/Inbox",
          "Manual Target": "Manual/Inbox",
        }),
        "--tags",
        "project",
        "--fetch-pdf",
        "--out",
        outPath,
      ]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(stderr).toContain("[1/2] A1 ok");
    expect(stderr).toContain("[2/2] A2 ok");

    const lines = (await readFile(outPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    const byId = new Map(lines.map((line) => [String(line.id), line]));
    expect(byId.get("A1")).toMatchObject({
      id: "A1",
      status: "ok",
      tool: "academic_search",
      addMode: "first",
      resultCount: 2,
      add: { zoteroSync: "pending" },
    });
    expect(byId.get("A2")).toMatchObject({
      id: "A2",
      status: "ok",
      tool: "resource_add",
      addMode: "direct",
      add: { zoteroSync: "pending" },
    });

    const itemFiles = await readdir(path.join(workspaceRoot, "items"));
    expect(itemFiles).toHaveLength(2);
    const savedRecords = await Promise.all(
      itemFiles.map(async (fileName) =>
        JSON.parse(
          await readFile(path.join(workspaceRoot, "items", fileName), "utf8"),
        ) as {
          item: { title: string };
          collectionPath: string;
          tags: string[];
          fetchPdfRequested: boolean;
        },
      ),
    );

    expect(savedRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({ title: "Search Result A" }),
          collectionPath: "Research/Inbox",
          tags: ["project", "alpha", "beta"],
          fetchPdfRequested: true,
        }),
        expect.objectContaining({
          item: expect.objectContaining({ title: "Manual batch resource" }),
          collectionPath: "Manual/Inbox",
          tags: ["project", "gamma"],
          fetchPdfRequested: true,
        }),
      ]),
    );
  });

  it("appends JSONL results when resuming into the same out file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-batch-resume-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const batchPath = path.join(root, "tasks.json");
    const outPath = path.join(root, "results.jsonl");

    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      batchPath,
      JSON.stringify(
        [
          {
            task_id: "R1",
            tool: "resource_add",
            item: {
              itemType: "journalArticle",
              title: "Already completed",
            },
          },
          {
            task_id: "R2",
            tool: "resource_add",
            item: {
              itemType: "journalArticle",
              title: "Resume row",
            },
          },
        ],
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(outPath, `${JSON.stringify({ id: "R1", status: "ok" })}\n`, "utf8");

    let stderr = "";
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write() {} },
        stderr: { write(chunk: string) { stderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "batch",
        batchPath,
        "--resume-from",
        outPath,
        "--out",
        outPath,
      ]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(stderr).toContain("Resuming batch: skipped 1 completed row from");

    const lines = (await readFile(outPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: "R1", status: "ok" });
    expect(lines[1]).toMatchObject({ id: "R2", status: "ok", tool: "resource_add" });
  });

  it("runs resource_pdf rows against existing workspace items", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-batch-pdf-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const batchPath = path.join(root, "pdf-tasks.json");
    const outPath = path.join(root, "pdf-results.jsonl");
    const installDir = await installMaterialFixtureProviders(root);

    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${tomlPath(installDir)}"`,
        "",
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
        "",
        "[storage]",
        `artifactRoot = "${tomlPath(path.join(root, "artifact-storage"))}"`,
        `extractionRoot = "${tomlPath(path.join(root, "extraction-storage"))}"`,
        `exportRoot = "${tomlPath(path.join(root, "exports"))}"`,
        "",
      ].join("\n"),
      "utf8",
    );

    const addResult = await addResourceToWorkspace(workspaceRoot, {
      item: {
        itemType: "journalArticle",
        title: "Batch PDF article",
      },
      defaultCollectionPath: "Inbox",
    });

    await writeFile(
      batchPath,
      JSON.stringify(
        [
          {
            task_id: "P1",
            tool: "resource_pdf",
            itemKey: addResult.record.id,
            url: "https://example.test/batch.pdf",
            filename: "batch-paper.pdf",
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const fetchMock = vi.fn(async () => { throw new Error("core fetch must not run"); });
    vi.stubGlobal("fetch", fetchMock);

    let stderr = "";
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write() {} },
        stderr: { write(chunk: string) { stderr += chunk; } },
      }).parseAsync(["node", "paper-search", "batch", batchPath, "--out", outPath]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(stderr).toContain("[1/1] P1 ok");
    const [line] = (await readFile(outPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
    expect(line).toMatchObject({
      id: "P1",
      status: "ok",
      tool: "resource_pdf",
      data: {
        ok: true,
        filename: "batch-paper.pdf",
        storage: {
          root: path.join(root, "artifact-storage"),
          key: expect.stringMatching(/\/batch-paper\.pdf$/u),
        },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const data = line!.data as { storage: { root: string; key: string } };
    await expect(readFile(path.join(data.storage.root, data.storage.key), "utf8")).resolves.toBe("fixture downloader bytes\n");
  });

  it("runs mixed material rows with one result envelope per JSONL row and resumes completed output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-batch-material-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const installDir = await installMaterialFixtureProviders(root);
    const inputDir = path.join(root, "inputs");
    await mkdir(inputDir, { recursive: true });
    const extractInputPath = path.join(inputDir, "extract-me.txt");
    await writeFile(extractInputPath, "extract this fixture body\n", "utf8");
    const batchPath = path.join(root, "material-tasks.json");
    const outPath = path.join(root, "material-results.jsonl");

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
        "[platform.fixture-artifact-downloader]",
        'mode = "integration"',
        "",
        "[platform.fixture-markdown-extractor]",
        'mode = "integration"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      batchPath,
      JSON.stringify(
        [
          {
            task_id: "M1",
            tool: "artifact_download",
            url: "https://example.test/files/batch-artifact.pdf",
            attach_to: "item-123",
            provider: "fixture-artifact-downloader",
            policy: "artifact-safe",
          },
          {
            task_id: "M2",
            tool: "extract",
            path: extractInputPath,
            attach_to: "item-456",
            provider: "fixture-markdown-extractor",
            policy: "extract-safe",
          },
          {
            task_id: "M3",
            tool: "material_ingest",
            input: "https://example.test/files/batch-ingest.pdf",
            attach_to: "item-789",
            artifact_provider: "fixture-artifact-downloader",
            extract_provider: "fixture-markdown-extractor",
            policy: "ingest-safe",
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const fetchMock = vi.fn(async () => {
      throw new Error("batch material fixture providers must not use live fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstRun = await runBatchCommand(root, ["batch", batchPath, "--out", outPath]);
    expect(firstRun.stderr).toContain("[1/3] M1 ok");
    expect(firstRun.stderr).toContain("[2/3] M2 ok");
    expect(firstRun.stderr).toContain("[3/3] M3 ok");
    expect(fetchMock).not.toHaveBeenCalled();

    const lines = await readJsonlObjects(outPath);
    expect(lines).toHaveLength(3);
    for (const row of lines) {
      expect(row.status).toBe("ok");
      expect(isResultEnvelope(row)).toBe(true);
      expect(row.envelope).toBeUndefined();
    }

    const byId = new Map(lines.map((line) => [String(line.id), line]));
    const artifactEnvelope = requireResultEnvelopeRow(byId.get("M1"));
    const extractEnvelope = requireResultEnvelopeRow(byId.get("M2"));
    const ingestEnvelope = requireResultEnvelopeRow(byId.get("M3"));
    expect(artifactEnvelope).toMatchObject({
      ok: true,
      capability: "acquire",
      tool: "artifact_download",
      data: {
        record: {
          status: "downloaded",
          itemId: "item-123",
        },
        provider: {
          id: "fixture-artifact-downloader",
        },
      },
    });
    expect(extractEnvelope).toMatchObject({
      ok: true,
      capability: "extract",
      tool: "extract",
      data: {
        record: {
          itemId: "item-456",
          source: {
            kind: "path",
            path: extractInputPath,
          },
        },
        provider: {
          id: "fixture-markdown-extractor",
        },
      },
    });
    expect(ingestEnvelope).toMatchObject({
      ok: true,
      capability: "orchestrate",
      tool: "material_ingest",
      data: {
        policy: {
          name: "ingest-safe",
          attachTo: "item-789",
        },
        providers: {
          selected: [
            { id: "fixture-artifact-downloader" },
            { id: "fixture-markdown-extractor" },
          ],
        },
      },
    });

    const resumeRun = await runBatchCommand(root, [
      "batch",
      batchPath,
      "--resume-from",
      outPath,
      "--out",
      outPath,
    ]);
    expect(resumeRun.stderr).toContain("Resuming batch: skipped 3 completed rows from");
    expect(await readJsonlObjects(outPath)).toHaveLength(3);
  });

  it("does not treat planned material rows as completed when resuming execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-batch-material-plan-resume-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const installDir = await installMaterialFixtureProviders(root);
    const batchPath = path.join(root, "material-plan-tasks.json");
    const outPath = path.join(root, "material-plan-results.jsonl");

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
        "[platform.fixture-artifact-downloader]",
        'mode = "integration"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      batchPath,
      JSON.stringify(
        [
          {
            task_id: "PLAN1",
            tool: "artifact_download",
            url: "https://example.test/files/plan-first.pdf",
            provider: "fixture-artifact-downloader",
            policy: "plan-first",
            dry_run: true,
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const fetchMock = vi.fn(async () => {
      throw new Error("batch material fixture providers must not use live fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const plannedRun = await runBatchCommand(root, ["batch", batchPath, "--out", outPath]);
    expect(plannedRun.stderr).toContain("[1/1] PLAN1 ok");
    let lines = await readJsonlObjects(outPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      id: "PLAN1",
      status: "ok",
      planned: true,
      tool: "artifact_download",
      capability: "acquire",
    });

    await writeFile(
      batchPath,
      JSON.stringify(
        [
          {
            task_id: "PLAN1",
            tool: "artifact_download",
            url: "https://example.test/files/plan-first.pdf",
            provider: "fixture-artifact-downloader",
            policy: "plan-first",
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const executeRun = await runBatchCommand(root, [
      "batch",
      batchPath,
      "--resume-from",
      outPath,
      "--out",
      outPath,
    ]);
    expect(executeRun.stderr).toContain("Resuming batch: skipped 0 completed rows from");
    expect(executeRun.stderr).toContain("[1/1] PLAN1 ok");

    lines = await readJsonlObjects(outPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      id: "PLAN1",
      planned: true,
    });
    expect(lines[1]).toMatchObject({
      id: "PLAN1",
      status: "ok",
      tool: "artifact_download",
      capability: "acquire",
      data: {
        record: {
          status: "downloaded",
        },
      },
    });
    expect(lines[1]).not.toHaveProperty("planned");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
