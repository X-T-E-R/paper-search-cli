import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeLocalStorageKey,
  resolveLocalStorageRef,
  writeLocalStorageBytes,
} from "../../src/storage/local.js";
import { createArtifactRecord, readArtifactRecord, resolveArtifactRecordPath } from "../../src/material/artifactStore.js";
import { createExtractionRecord, readExtractionRecord, resolveExtractionOutputPath } from "../../src/material/extractionStore.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("versioned local storage references", () => {
  it("stages, hashes, atomically places, and resolves bytes below a captured root", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "paper-search-storage-"));
    roots.push(parent);
    const root = path.join(parent, "configured-artifacts");
    const stored = await writeLocalStorageBytes({
      root,
      key: "artifact-1/paper.pdf",
      area: "artifact",
      bytes: Buffer.from("pdf-bytes"),
    });

    expect(stored.ref).toEqual({
      schemaVersion: 1,
      sink: "local",
      area: "artifact",
      root: path.resolve(root),
      key: "artifact-1/paper.pdf",
      sha256: "29d1283686193dc1461a7deac4f53d9bc5402a28b95d854f69e94986756fd0a9",
      sizeBytes: 9,
    });
    await expect(readFile(await resolveLocalStorageRef(stored.ref), "utf8")).resolves.toBe("pdf-bytes");
    const laterConfiguredRoot = path.join(parent, "different-artifact-root");
    expect(stored.ref.root).not.toBe(path.resolve(laterConfiguredRoot));
    await expect(resolveLocalStorageRef(stored.ref)).resolves.toBe(stored.path);
  });

  it("rejects absolute, traversal, and duplicate target keys", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "paper-search-storage-reject-"));
    roots.push(parent);
    expect(() => normalizeLocalStorageKey("../escape.pdf")).toThrow("Unsafe local storage key");
    expect(() => normalizeLocalStorageKey("C:\\escape.pdf")).toThrow("Unsafe local storage key");

    const options = {
      root: path.join(parent, "root"),
      key: "same/file.bin",
      area: "artifact" as const,
      bytes: Buffer.from("first"),
    };
    await writeLocalStorageBytes(options);
    await expect(writeLocalStorageBytes(options)).rejects.toThrow("target already exists");
  });

  it("allows exactly one concurrent writer to atomically claim a target key", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "paper-search-storage-race-"));
    roots.push(parent);
    const options = {
      root: path.join(parent, "root"),
      key: "same/file.bin",
      area: "artifact" as const,
    };

    const results = await Promise.allSettled([
      writeLocalStorageBytes({ ...options, bytes: Buffer.from("first") }),
      writeLocalStorageBytes({ ...options, bytes: Buffer.from("second") }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stored = await readFile(path.join(options.root, options.key), "utf8");
    expect(["first", "second"]).toContain(stored);
  });

  it("keeps legacy workspace-relative record paths distinct from new captured roots", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-storage-legacy-"));
    roots.push(workspaceRoot);
    const artifact = await createArtifactRecord(workspaceRoot, {
      id: "legacy-artifact",
      kind: "pdf",
      status: "downloaded",
      path: "material/files/legacy-artifact/paper.pdf",
      provenance: { origin: "user_supplied" },
      attempts: [],
    });
    const extraction = await createExtractionRecord(workspaceRoot, {
      id: "legacy-extraction",
      source: { kind: "artifact", artifactId: artifact.id },
      backend: "legacy",
      outputs: { markdownPath: "material/extractions/legacy-extraction/content.md" },
      cacheHit: false,
    });

    const rereadArtifact = await readArtifactRecord(workspaceRoot, artifact.id);
    expect(rereadArtifact).toMatchObject({ path: "material/files/legacy-artifact/paper.pdf" });
    expect(rereadArtifact?.storage).toBeUndefined();
    await expect(resolveArtifactRecordPath(workspaceRoot, rereadArtifact!)).resolves.toBe(
      path.join(workspaceRoot, "material", "files", "legacy-artifact", "paper.pdf"),
    );
    await expect(readExtractionRecord(workspaceRoot, extraction.id)).resolves.toMatchObject({
      outputs: { markdownPath: "material/extractions/legacy-extraction/content.md" },
    });
    await expect(resolveExtractionOutputPath(workspaceRoot, extraction, "markdown")).resolves.toBe(
      path.join(workspaceRoot, "material", "extractions", "legacy-extraction", "content.md"),
    );
  });
});
