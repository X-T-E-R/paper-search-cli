import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_RECORDS_DIR,
  createArtifactRecord,
  listArtifactRecords,
  readArtifactRecord,
} from "../../src/material/artifactStore.js";

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

describe("artifact record store", () => {
  it("round-trips linked and standalone artifact records through disk", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-artifacts-"));
    tempDirs.push(root);

    const linked = await createArtifactRecord(root, {
      id: "linked-artifact",
      createdAt: "2026-06-29T10:00:00.000Z",
      kind: "pdf",
      status: "downloaded",
      itemId: "workspace-item-1",
      filename: "paper.pdf",
      contentType: "application/pdf",
      path: "material/files/workspace-item-1/paper.pdf",
      remoteUrl: "https://example.test/paper.pdf",
      sizeBytes: 1024,
      provenance: {
        origin: "download",
        sourceUrl: "https://example.test/paper.pdf",
        providerId: "fixture-downloader",
        policy: "workspace-safe",
        resolvedFrom: "doi:10.1234/example",
      },
      attempts: [
        {
          tier: "primary",
          source: "repository",
          providerId: "fixture-resolver",
          ok: false,
          status: 404,
          message: "not found",
          at: "2026-06-29T09:59:00.000Z",
        },
        {
          tier: "fallback",
          source: "publisher",
          providerId: "fixture-downloader",
          ok: true,
          status: 200,
          at: "2026-06-29T10:00:00.000Z",
        },
      ],
    });

    const standalone = await createArtifactRecord(root, {
      id: "standalone-artifact",
      createdAt: "2026-06-29T10:01:00.000Z",
      kind: "html",
      status: "recorded",
      remoteUrl: "https://example.test/standalone.html",
      provenance: {
        origin: "resolved",
        sourceUrl: "https://example.test/standalone.html",
        providerId: "fixture-resolver",
      },
      attempts: [
        {
          tier: "metadata",
          source: "user-url",
          providerId: "fixture-resolver",
          ok: true,
          at: "2026-06-29T10:01:00.000Z",
        },
      ],
    });

    await expect(readArtifactRecord(root, linked.id)).resolves.toEqual(linked);
    await expect(readArtifactRecord(root, standalone.id)).resolves.toEqual(standalone);

    const rawLinked = JSON.parse(
      await readFile(path.join(root, ARTIFACT_RECORDS_DIR, `${linked.id}.json`), "utf8"),
    );
    expect(rawLinked).toMatchObject({
      id: "linked-artifact",
      itemId: "workspace-item-1",
      path: "material/files/workspace-item-1/paper.pdf",
      remoteUrl: "https://example.test/paper.pdf",
      provenance: {
        origin: "download",
        providerId: "fixture-downloader",
        policy: "workspace-safe",
      },
      attempts: [
        expect.objectContaining({ ok: false, tier: "primary" }),
        expect.objectContaining({ ok: true, tier: "fallback" }),
      ],
    });

    await expect(listArtifactRecords(root)).resolves.toEqual([linked, standalone]);
    await expect(listArtifactRecords(root, { itemId: "workspace-item-1" })).resolves.toEqual([linked]);
    await expect(listArtifactRecords(root, { standalone: true })).resolves.toEqual([standalone]);
  });
});
