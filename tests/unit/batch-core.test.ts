import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBatchTasks,
  extractCandidates,
  missingAddCandidateError,
  parseCompletedBatchResultIds,
  parseCsvText,
  readBatchRows,
  serializeBatchResultJsonl,
  serializeBatchResults,
  summarizeCandidate,
} from "../../src/batch/core.js";

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

describe("batch helpers", () => {
  it("parses quoted CSV rows", () => {
    expect(parseCsvText("task_id,query,tags\nT1,\"a, b\",\"x;y\"\n")).toEqual([
      { task_id: "T1", query: "a, b", tags: "x;y" },
    ]);
  });

  it("builds academic search tasks with mapped collection keys", () => {
    const [task] = buildBatchTasks(
      [
        {
          task_id: "B1",
          tool: "academic_search",
          query: "DeepCAD",
          provider_or_platform: "wos",
          target_collection: "Text-to-CAD",
          save_policy: "import-first",
          tags: "cad;paperflow",
        },
      ],
      {
        addMode: "row",
        collectionMap: { "Text-to-CAD": "22V6PKXN" },
        defaultPlatform: "all",
        extraTags: ["project"],
        fetchPdf: true,
        includeRaw: false,
        maxResults: 3,
        skipStatuses: new Set(),
      },
    );

    expect(task).toBeDefined();
    expect(task).toMatchObject({
      id: "B1",
      tool: "academic_search",
      args: { query: "DeepCAD", platform: "wos", maxResults: 3 },
      addMode: "first",
      addArgs: {
        collectionKey: "22V6PKXN",
        fetchPdf: true,
        tags: ["project", "cad", "paperflow"],
      },
    });
  });

  it("preserves nested JSON objects when reading JSON task files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-batch-unit-"));
    tempDirs.push(root);
    const filePath = path.join(root, "tasks.json");
    await writeFile(
      filePath,
      JSON.stringify([
        {
          task_id: "B2",
          tool: "resource_add",
          item: {
            itemType: "journalArticle",
            title: "Structured item",
            url: "https://example.test/structured",
          },
        },
      ]),
      "utf8",
    );

    const [row] = await readBatchRows(filePath);
    expect(row).toBeDefined();
    expect(row!.item).toContain("\"Structured item\"");

    const [task] = buildBatchTasks([row!], {
      addMode: "row",
      collectionMap: {},
      extraTags: [],
      fetchPdf: false,
      includeRaw: false,
      skipStatuses: new Set(),
    });
    expect(task).toBeDefined();
    expect(task!.args).toMatchObject({
      item: {
        itemType: "journalArticle",
        title: "Structured item",
      },
    });
  });

  it("skips already completed rows by status", () => {
    const [task] = buildBatchTasks(
      [{ task_id: "B3", status: "imported", query: "already done" }],
      {
        addMode: "row",
        collectionMap: {},
        extraTags: [],
        fetchPdf: false,
        includeRaw: false,
        skipStatuses: new Set(["imported"]),
      },
    );
    expect(task).toBeDefined();
    expect(task!.skipReason).toBe("status:imported");
  });

  it("builds generic external web search rows", () => {
    const [task] = buildBatchTasks(
      [
        {
          task_id: "B3b",
          tool: "web_search",
          query: "OpenAI API docs",
          mode: "deep",
          intent: "resource",
          freshness: "pw",
          max_results: "2",
        },
      ],
      {
        addMode: "none",
        collectionMap: {},
        extraTags: [],
        fetchPdf: false,
        includeRaw: false,
        skipStatuses: new Set(),
      },
    );
    expect(task).toBeDefined();
    expect(task!).toMatchObject({
      id: "B3b",
      tool: "web_search",
      args: {
        query: "OpenAI API docs",
        mode: "deep",
        intent: "resource",
        freshness: "pw",
        maxResults: 2,
      },
    });
  });

  it("builds resource_pdf rows and prefers item keys over URL lookup inference", () => {
    const [task] = buildBatchTasks(
      [
        {
          task_id: "PDF1",
          item_key: "workspace-item-1",
          url: "https://example.test/paper.pdf",
          filename: "paper",
          download: "false",
        },
      ],
      {
        addMode: "row",
        collectionMap: {},
        extraTags: [],
        fetchPdf: false,
        includeRaw: false,
        skipStatuses: new Set(),
      },
    );

    expect(task).toBeDefined();
    expect(task!).toMatchObject({
      id: "PDF1",
      tool: "resource_pdf",
      args: {
        itemKey: "workspace-item-1",
        url: "https://example.test/paper.pdf",
        filename: "paper",
        download: false,
      },
      addMode: "none",
    });
  });

  it("builds material tool rows with provider, policy, attachment, and dry-run fields", () => {
    const tasks = buildBatchTasks(
      [
        {
          task_id: "M1",
          tool: "artifact_download",
          url: "https://example.test/paper.pdf",
          attach_to: "item-123",
          provider: "fixture-artifact-downloader",
          policy: "workspace-safe",
          no_download: "true",
          dry_run: "true",
        },
        {
          task_id: "M2",
          tool: "extract",
          path: "inputs/paper.txt",
          attachTo: "item-456",
          extract_provider: "fixture-markdown-extractor",
          policy: "extract-safe",
          dry_run: "true",
        },
        {
          task_id: "M3",
          tool: "material_ingest",
          input: "https://example.test/ingest.pdf",
          attach_to: "item-789",
          artifact_provider: "fixture-artifact-downloader",
          provider: "fixture-markdown-extractor",
          policy: "ingest-safe",
          plan: "true",
        },
      ],
      {
        addMode: "row",
        collectionMap: {},
        extraTags: [],
        fetchPdf: false,
        includeRaw: false,
        skipStatuses: new Set(),
      },
    );

    expect(tasks).toMatchObject([
      {
        id: "M1",
        tool: "artifact_download",
        addMode: "none",
        args: {
          input: "https://example.test/paper.pdf",
          attachTo: "item-123",
          providerId: "fixture-artifact-downloader",
          policy: "workspace-safe",
          download: false,
          dryRun: true,
        },
      },
      {
        id: "M2",
        tool: "extract",
        addMode: "none",
        args: {
          input: "inputs/paper.txt",
          attachTo: "item-456",
          providerId: "fixture-markdown-extractor",
          policy: "extract-safe",
          dryRun: true,
        },
      },
      {
        id: "M3",
        tool: "material_ingest",
        addMode: "none",
        args: {
          input: "https://example.test/ingest.pdf",
          attachTo: "item-789",
          artifactProviderId: "fixture-artifact-downloader",
          extractProviderId: "fixture-markdown-extractor",
          policy: "ingest-safe",
          dryRun: true,
        },
      },
    ]);
  });

  it("extracts nested provider result arrays", () => {
    expect(
      extractCandidates({
        results: {
          arxiv: [{ title: "A" }],
          semantic: [{ title: "B" }],
        },
      }),
    ).toEqual([{ title: "A" }, { title: "B" }]);
  });

  it("summarizes candidates and serializes CSV output", () => {
    const selected = summarizeCandidate({
      title: "Paper",
      doi: "10/example",
      url: "https://example.test",
    });
    const csv = serializeBatchResults(
      [{ index: 0, id: "B4", status: "ok", tool: "academic_search", selected }],
      "csv",
    );
    expect(csv).toContain("selectedTitle");
    expect(csv).toContain("Paper");
  });

  it("serializes one batch result as durable JSONL", () => {
    const line = serializeBatchResultJsonl({
      index: 0,
      id: "B5",
      status: "ok",
      tool: "resource_lookup",
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line).id).toBe("B5");
  });

  it("reads completed ids from partial JSONL for resume", () => {
    const ids = parseCompletedBatchResultIds(
      [
        JSON.stringify({ id: "done-1", status: "ok" }),
        JSON.stringify({ id: "retry-me", status: "error" }),
        JSON.stringify({ id: "plan-only", status: "ok", planned: true }),
        JSON.stringify({ id: "done-2", status: "skipped" }),
        "",
      ].join("\n"),
    );
    expect([...ids].sort()).toEqual(["done-1", "done-2"]);
  });

  it("reports a failed add when lookup has no addable candidate", () => {
    expect(
      missingAddCandidateError(
        "resource_lookup",
        { found: false, message: "No resource found for this identifier" },
        0,
      ),
    ).toContain("No resource found for this identifier");
  });
});
