import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTRACTION_RECORDS_DIR,
  createExtractionRecord,
  listExtractionRecords,
  readExtractionRecord,
} from "../../src/material/extractionStore.js";

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

describe("extraction record store", () => {
  it("round-trips standalone and item-linked extraction records through disk", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-extractions-"));
    tempDirs.push(root);

    const standalone = await createExtractionRecord(root, {
      id: "standalone-md",
      createdAt: "2026-06-29T00:00:00.000Z",
      source: {
        kind: "path",
        path: "inputs/paper.pdf",
      },
      backend: "fixture-extractor",
      options: {
        ocr: true,
        pages: "1-2",
      },
      outputs: {
        markdownPath: "material/outputs/standalone/paper.md",
        jsonPath: "material/outputs/standalone/paper.json",
        assetsDir: "material/outputs/standalone/assets",
      },
      cacheHit: false,
    });

    const linked = await createExtractionRecord(root, {
      id: "item-md",
      createdAt: "2026-06-29T00:00:01.000Z",
      source: {
        kind: "artifact",
        artifactId: "artifact-1",
      },
      backend: "fixture-extractor",
      status: "requested",
      options: {
        language: "en",
      },
      outputs: {
        markdownPath: "material/outputs/item-1/paper.md",
        markdown: "# Extracted paper",
      },
      cacheHit: true,
      itemId: "item-1",
      message: "served from provider cache",
    });

    await expect(readExtractionRecord(root, standalone.id)).resolves.toEqual(standalone);
    await expect(readExtractionRecord(root, linked.id)).resolves.toEqual(linked);

    const savedStandalone = JSON.parse(
      await readFile(path.join(root, EXTRACTION_RECORDS_DIR, `${standalone.id}.json`), "utf8"),
    ) as typeof standalone;
    expect(savedStandalone.outputs).toEqual({
      markdownPath: "material/outputs/standalone/paper.md",
      jsonPath: "material/outputs/standalone/paper.json",
      assetsDir: "material/outputs/standalone/assets",
    });
    expect(savedStandalone.cacheHit).toBe(false);
    expect(savedStandalone.source).toEqual({ kind: "path", path: "inputs/paper.pdf" });
    expect(savedStandalone.itemId).toBeUndefined();

    const all = await listExtractionRecords(root);
    expect(all.map((record) => record.id)).toEqual(["standalone-md", "item-md"]);

    const standaloneOnly = await listExtractionRecords(root, { standalone: true });
    expect(standaloneOnly).toEqual([
      expect.objectContaining({
        id: "standalone-md",
        source: { kind: "path", path: "inputs/paper.pdf" },
        cacheHit: false,
      }),
    ]);

    const linkedOnly = await listExtractionRecords(root, { itemId: "item-1" });
    expect(linkedOnly).toEqual([
      expect.objectContaining({
        id: "item-md",
        itemId: "item-1",
        cacheHit: true,
        outputs: expect.objectContaining({
          markdownPath: "material/outputs/item-1/paper.md",
          markdown: "# Extracted paper",
        }),
        source: { kind: "artifact", artifactId: "artifact-1" },
      }),
    ]);
  });
});
