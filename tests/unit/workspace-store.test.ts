import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listArtifactRecords, readArtifactRecord } from "../../src/material/artifactStore.js";
import {
  addResourceToWorkspace,
  exportWorkspaceItems,
  fetchPdfForWorkspaceItem,
  listWorkspaceCollections,
} from "../../src/workspace/store.js";

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

describe("workspace store", () => {
  it("fails closed without replacing a malformed collection index", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-corrupt-"));
    tempDirs.push(root);
    const collectionsPath = path.join(root, "collections.json");
    const malformed = '{"collections":[';
    await writeFile(collectionsPath, malformed, "utf8");

    await expect(
      addResourceToWorkspace(root, {
        item: { itemType: "journalArticle", title: "Must not be written" },
        defaultCollectionPath: "Inbox",
      }),
    ).rejects.toThrow(`Invalid workspace collection index at ${collectionsPath}`);

    await expect(readFile(collectionsPath, "utf8")).resolves.toBe(malformed);
    await expect(readdir(path.join(root, "items"))).resolves.toEqual([]);
  });

  it("does not treat non-missing collection index read errors as an empty workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-read-error-"));
    tempDirs.push(root);
    await mkdir(path.join(root, "collections.json"));

    await expect(
      listWorkspaceCollections(root, { defaultCollectionPath: "Inbox", flat: true }),
    ).rejects.toBeDefined();
    await expect(readdir(path.join(root, "collections.json"))).resolves.toEqual([]);
  });

  it("rejects duplicate collection keys before building the collection tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-duplicate-"));
    tempDirs.push(root);
    const collectionsPath = path.join(root, "collections.json");
    const duplicateIndex = JSON.stringify({
      collections: [
        {
          key: "duplicate",
          name: "Inbox",
          parentKey: null,
          path: "Inbox",
          itemIds: [],
          createdAt: "2026-07-10T00:00:00.000Z",
        },
        {
          key: "duplicate",
          name: "Child",
          parentKey: "duplicate",
          path: "Inbox/Child",
          itemIds: [],
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      ],
    });
    await writeFile(collectionsPath, duplicateIndex, "utf8");

    await expect(
      listWorkspaceCollections(root, { defaultCollectionPath: "Inbox", flat: false }),
    ).rejects.toThrow("collection keys and paths must be non-empty and unique");
    await expect(readFile(collectionsPath, "utf8")).resolves.toBe(duplicateIndex);
  });

  it("creates default collections and stores resource items", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-"));
    tempDirs.push(root);

    const addResult = await addResourceToWorkspace(root, {
      item: {
        itemType: "journalArticle",
        title: "Stored article",
        url: "https://example.com/paper",
      },
      tags: ["rag", "paper"],
      defaultCollectionPath: "Inbox",
    });

    expect(addResult.collection.path).toBe("Inbox");
    const collections = await listWorkspaceCollections(root, {
      defaultCollectionPath: "Inbox",
      flat: true,
    });
    expect(collections).toEqual([
      expect.objectContaining({
        path: "Inbox",
        itemCount: 1,
      }),
    ]);

    const savedRecord = JSON.parse(
      await readFile(path.join(root, "items", `${addResult.record.id}.json`), "utf8"),
    ) as { tags: string[]; fetchPdfRequested: boolean };
    expect(savedRecord.tags).toEqual(["rag", "paper"]);
    expect(savedRecord.fetchPdfRequested).toBe(false);
  });

  it("never downloads a PDF directly from the workspace compatibility reader", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-pdf-"));
    tempDirs.push(root);

    const addResult = await addResourceToWorkspace(root, {
      item: {
        itemType: "journalArticle",
        title: "PDF article",
        url: "https://example.test/article",
      },
      detail: {
        pdf: {
          available: true,
          urls: ["https://example.test/files/article.pdf"],
        },
      },
      defaultCollectionPath: "Inbox",
    });

    let requestedUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return new Response("pdf-bytes", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment; filename=\"downloaded.pdf\"",
        },
      });
    };

    const result = await fetchPdfForWorkspaceItem(root, {
      itemKey: addResult.record.id,
      fetchImpl,
    });

    expect(requestedUrl).toBe("");
    expect(result).toMatchObject({
      ok: false,
      itemKey: addResult.record.id,
      itemId: addResult.record.id,
      sourceUrl: "https://example.test/files/article.pdf",
      message: expect.stringContaining("installed material downloader provider"),
    });
    const savedRecord = JSON.parse(
      await readFile(path.join(root, "items", `${addResult.record.id}.json`), "utf8"),
    ) as { attachments?: unknown[] };
    expect(savedRecord.attachments).toBeUndefined();
    await expect(listArtifactRecords(root, { itemId: addResult.record.id })).resolves.toHaveLength(0);
  });

  it("backfills artifact ids for legacy PDF attachments without refetching", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-pdf-legacy-"));
    tempDirs.push(root);

    const addResult = await addResourceToWorkspace(root, {
      item: {
        itemType: "journalArticle",
        title: "Legacy PDF article",
      },
      defaultCollectionPath: "Inbox",
    });
    const createdAt = "2026-06-29T12:00:00.000Z";
    const itemPath = path.join(root, "items", `${addResult.record.id}.json`);
    const legacyRecord = {
      ...addResult.record,
      attachments: [
        {
          id: "legacy-attachment",
          itemId: addResult.record.id,
          filename: "legacy.pdf",
          contentType: "application/pdf",
          path: `attachments/${addResult.record.id}/legacy.pdf`,
          status: "attached",
          message: "Legacy PDF attachment",
          createdAt,
        },
      ],
    };
    await writeFile(itemPath, JSON.stringify(legacyRecord, null, 2), "utf8");

    let fetchCalled = false;
    const result = await fetchPdfForWorkspaceItem(root, {
      itemKey: addResult.record.id,
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response("unexpected");
      }) as typeof fetch,
    });

    expect(fetchCalled).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      itemKey: addResult.record.id,
      itemId: addResult.record.id,
      attachmentId: "legacy-attachment",
      filename: "legacy.pdf",
      path: `attachments/${addResult.record.id}/legacy.pdf`,
      message: "PDF already attached",
    });
    expect(result.artifactId).toEqual(expect.any(String));

    await expect(readArtifactRecord(root, result.artifactId!)).resolves.toMatchObject({
      id: result.artifactId,
      kind: "pdf",
      status: "downloaded",
      itemId: addResult.record.id,
      filename: "legacy.pdf",
      path: `attachments/${addResult.record.id}/legacy.pdf`,
      provenance: {
        origin: "user_supplied",
      },
      attempts: [
        expect.objectContaining({
          tier: "resource-pdf-download",
          ok: true,
        }),
      ],
    });
    const savedRecord = JSON.parse(await readFile(itemPath, "utf8")) as {
      attachments: Array<{ id: string; artifactId?: string }>;
    };
    expect(savedRecord.attachments[0]).toMatchObject({
      id: "legacy-attachment",
      artifactId: result.artifactId,
    });
  });

  it("does not bypass the provider boundary for request-only PDF records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-pdf-request-"));
    tempDirs.push(root);

    const addResult = await addResourceToWorkspace(root, {
      item: {
        itemType: "journalArticle",
        title: "Request-only PDF article",
      },
      defaultCollectionPath: "Inbox",
    });

    let fetchCalled = false;
    const result = await fetchPdfForWorkspaceItem(root, {
      itemKey: addResult.record.id,
      url: "https://example.test/requested.pdf",
      filename: "requested",
      download: false,
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response("unexpected");
      }) as typeof fetch,
    });

    expect(fetchCalled).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      itemKey: addResult.record.id,
      itemId: addResult.record.id,
      message: expect.stringContaining("installed material downloader provider"),
    });
    const savedRecord = JSON.parse(
      await readFile(path.join(root, "items", `${addResult.record.id}.json`), "utf8"),
    ) as { attachments?: unknown[] };
    expect(savedRecord.attachments).toBeUndefined();
  });

  it("reports missing PDF URLs without creating attachments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-pdf-missing-"));
    tempDirs.push(root);

    const addResult = await addResourceToWorkspace(root, {
      item: {
        itemType: "journalArticle",
        title: "No PDF article",
        url: "https://example.test/article",
      },
      defaultCollectionPath: "Inbox",
    });

    const result = await fetchPdfForWorkspaceItem(root, {
      itemKey: addResult.record.id,
      fetchImpl: (async () => new Response("unexpected")) as typeof fetch,
    });

    expect(result).toMatchObject({
      ok: false,
      itemKey: addResult.record.id,
      itemId: addResult.record.id,
      message: expect.stringContaining("installed material downloader provider"),
    });
    const savedRecord = JSON.parse(
      await readFile(path.join(root, "items", `${addResult.record.id}.json`), "utf8"),
    ) as { attachments?: unknown[] };
    expect(savedRecord.attachments).toBeUndefined();
  });

  it("exports workspace items as structured portable formats", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-export-"));
    tempDirs.push(root);

    await addResourceToWorkspace(root, {
      item: {
        itemType: "journalArticle",
        title: "Exported Article, With Comma",
        creators: [{ firstName: "Ada", lastName: "Lovelace", creatorType: "author" }],
        date: "2026-06-24",
        DOI: "10.1234/export",
        url: "https://example.test/exported",
        publicationTitle: "Journal of Export Tests",
      },
      tags: ["export", "phase1"],
      collectionPath: "Research/Inbox",
      defaultCollectionPath: "Inbox",
    });
    await addResourceToWorkspace(root, {
      item: {
        itemType: "webpage",
        title: "Other Item",
        url: "https://example.test/other",
      },
      collectionPath: "Other",
      defaultCollectionPath: "Inbox",
    });

    const json = await exportWorkspaceItems(root, { format: "json" });
    expect(json.count).toBe(2);
    expect(JSON.parse(json.content)).toMatchObject({
      format: "json",
      count: 2,
      items: expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({ title: "Exported Article, With Comma" }),
        }),
      ]),
    });

    const jsonl = await exportWorkspaceItems(root, {
      format: "jsonl",
      collectionPath: "Research",
      includeChildren: true,
    });
    const jsonlLines = jsonl.content.trim().split("\n");
    expect(jsonl.count).toBe(1);
    expect(JSON.parse(jsonlLines[0]!)).toMatchObject({
      collectionPath: "Research/Inbox",
    });

    const csv = await exportWorkspaceItems(root, {
      format: "csv",
      collectionPath: "Research/Inbox",
    });
    expect(csv.content).toContain("id,itemType,title,creators,date,DOI,url");
    expect(csv.content).toContain('"Exported Article, With Comma"');

    const bibtex = await exportWorkspaceItems(root, {
      format: "bibtex",
      collectionPath: "Research/Inbox",
    });
    expect(bibtex.content).toContain("@article{lovelace-2026-exported-article-with-comma");
    expect(bibtex.content).toContain("author = {Ada Lovelace}");
    expect(bibtex.content).toContain("doi = {10.1234/export}");
  });

  it("exports a missing workspace without creating any workspace state", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-export-missing-"));
    tempDirs.push(parent);
    const root = path.join(parent, "workspace");

    const result = await exportWorkspaceItems(root, { format: "json" });

    expect(result).toMatchObject({
      format: "json",
      workspaceRoot: path.resolve(root),
      count: 0,
      items: [],
    });
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails export when a workspace item contains malformed JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-export-corrupt-"));
    tempDirs.push(root);
    const itemsDir = path.join(root, "items");
    await mkdir(itemsDir);
    const itemPath = path.join(itemsDir, "broken.json");
    const malformed = '{"id":"broken"';
    await writeFile(itemPath, malformed, "utf8");

    await expect(exportWorkspaceItems(root, { format: "json" })).rejects.toBeInstanceOf(SyntaxError);
    await expect(readFile(itemPath, "utf8")).resolves.toBe(malformed);
  });

  it("tolerates an item deleted after its collection index was written", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-export-deleted-"));
    tempDirs.push(root);
    await writeFile(
      path.join(root, "collections.json"),
      JSON.stringify({
        collections: [
          {
            key: "inbox",
            name: "Inbox",
            parentKey: null,
            path: "Inbox",
            itemIds: ["deleted-item"],
            createdAt: "2026-07-15T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    await expect(
      exportWorkspaceItems(root, { format: "json", collectionPath: "Inbox" }),
    ).resolves.toMatchObject({ count: 0, items: [] });
  });

  it("fails export when the workspace items path is not a directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-export-not-dir-"));
    tempDirs.push(root);
    const itemsPath = path.join(root, "items");
    await writeFile(itemsPath, "not a directory", "utf8");

    await expect(exportWorkspaceItems(root, { format: "json" })).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    await expect(readFile(itemsPath, "utf8")).resolves.toBe("not a directory");
  });
});
