import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/program.js";
import { readArtifactRecord } from "../../src/material/artifactStore.js";
import type { ArtifactDownloadData } from "../../src/material/artifactDownload.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";
import { addResourceToWorkspace, readWorkspaceItemRecord } from "../../src/workspace/store.js";

const tempDirs: string[] = [];
const downloaderFixturesRoot = path.resolve("tests", "fixtures", "material-downloaders");

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function tomlPath(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

async function writeProjectConfig(root: string, workspaceRoot: string): Promise<void> {
  await writeFile(
    path.join(root, "paper-search.toml"),
    [
      "[providers]",
      `installDir = "${tomlPath(downloaderFixturesRoot)}"`,
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
    ].join("\n"),
    "utf8",
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function runArtifactCommand(root: string, args: string[]): Promise<{
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
    restoreEnv("APPDATA", originalAppData);
  }
  const envelope = JSON.parse(stdout) as ResultEnvelope;
  expect(isResultEnvelope(envelope)).toBe(true);
  return { stdout, stderr, envelope };
}

async function createWorkspace(prefix: string): Promise<{ root: string; workspaceRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await writeProjectConfig(root, workspaceRoot);
  return { root, workspaceRoot };
}

function expectDownloadData(envelope: ResultEnvelope): ArtifactDownloadData {
  expect(envelope).toMatchObject({
    ok: true,
    capability: "acquire",
    tool: "artifact_download",
  });
  expect(envelope.data).not.toBeNull();
  return envelope.data as ArtifactDownloadData;
}

describe("artifact download command", () => {
  it("selects a successful standalone download by default and reuses its identity", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-artifact-select-");

    const first = await runArtifactCommand(root, [
      "artifact",
      "download",
      "https://example.test/files/selected-paper.pdf",
      "--json",
    ]);
    const firstData = expectDownloadData(first.envelope);
    expect(firstData.record.itemId).toEqual(expect.any(String));
    expect(firstData.input.attachedItemId).toBe(firstData.record.itemId);
    await expect(readWorkspaceItemRecord(workspaceRoot, firstData.record.itemId!)).resolves.toMatchObject({
      id: firstData.record.itemId,
      item: {
        itemType: "document",
        title: "selected-paper",
        url: "https://example.test/files/selected-paper.pdf",
        source: "artifact-download",
      },
      collectionPath: "Inbox",
    });

    const second = await runArtifactCommand(root, [
      "artifact",
      "download",
      "https://example.test/files/selected-paper.pdf",
      "--json",
    ]);
    const secondData = expectDownloadData(second.envelope);
    expect(secondData.record.itemId).toBe(firstData.record.itemId);
  });

  it("keeps downloads standalone when material.downloadDisposition is materialized", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-artifact-materialized-");
    await appendFile(
      path.join(root, "paper-search.toml"),
      '[material]\ndownloadDisposition = "materialized"\n',
      "utf8",
    );

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      "https://example.test/files/materialized-paper.pdf",
      "--json",
    ]);
    const data = expectDownloadData(result.envelope);
    expect(data.record.itemId).toBeUndefined();
    expect(data.input.attachedItemId).toBeUndefined();
    await expect(stat(path.join(workspaceRoot, "items"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a bound Zotero projection pending without failing the local download", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-artifact-zotero-pending-");
    await appendFile(
      path.join(root, "paper-search.toml"),
      '[zoteroBinding]\nmode = "bound"\ncollectionKeys = ["PROJECT1"]\n',
      "utf8",
    );

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      "https://example.test/files/pending-zotero.pdf",
      "--json",
    ]);
    const data = expectDownloadData(result.envelope);
    expect(data.record.itemId).toEqual(expect.any(String));
    expect(result.envelope.diagnostics).toMatchObject({ zoteroSync: "pending" });
    const receipts = await readdir(path.join(workspaceRoot, "zotero", "receipts"));
    expect(receipts).toHaveLength(1);
    await expect(readFile(path.join(workspaceRoot, "zotero", "receipts", receipts[0]!), "utf8"))
      .resolves.toContain('"pendingReason": "zotero_not_configured"');
  });

  it("downloads a URL through the fixture material downloader and creates an artifact record", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-artifact-download-");
    const fetchMock = vi.fn(async () => {
      throw new Error("fixture artifact download must not use live fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      "https://example.test/files/article.pdf",
      "--attach-to",
      "item-123",
      "--policy",
      "workspace-safe",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    const data = expectDownloadData(result.envelope);
    expect(data.provider.id).toBe("fixture-artifact-downloader");
    expect(data.download).toBe(true);
    expect(data.input).toEqual({
      kind: "url",
      value: "https://example.test/files/article.pdf",
      url: "https://example.test/files/article.pdf",
      attachedItemId: "item-123",
    });
    expect(data.record).toMatchObject({
      id: expect.any(String),
      kind: "pdf",
      status: "downloaded",
      itemId: "item-123",
      filename: "fixture-download.pdf",
      contentType: "application/pdf",
      storage: {
        schemaVersion: 1,
        sink: "local",
        area: "artifact",
        root: path.join(root, "artifact-storage"),
        key: `${data.record.id}/fixture-download.pdf`,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      remoteUrl: "https://example.test/files/article.pdf",
      sizeBytes: "fixture downloader bytes\n".length,
      provenance: {
        origin: "download",
        sourceUrl: "https://example.test/files/article.pdf",
        providerId: "fixture-artifact-downloader",
        policy: "workspace-safe",
      },
    });
    expect(data.record.message).toContain("integration, workspace-safe, item-123");

    expect(data.record.path).toBeUndefined();
    await expect(readFile(data.artifactPath!, "utf8")).resolves.toBe(
      "fixture downloader bytes\n",
    );
    await expect(readArtifactRecord(workspaceRoot, data.record.id)).resolves.toMatchObject({
      id: data.record.id,
      status: "downloaded",
      storage: data.record.storage,
      attempts: [
        expect.objectContaining({
          tier: "artifact-download-candidate",
          providerId: "fixture-artifact-downloader",
          ok: true,
          status: 200,
        }),
      ],
    });
  });

  it("records a workspace item request without fetching bytes when --no-download is used", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-artifact-no-download-");
    const addResult = await addResourceToWorkspace(workspaceRoot, {
      item: {
        itemType: "journalArticle",
        title: "No Download Item",
        url: "https://example.test/files/no-download.pdf",
      },
      defaultCollectionPath: "Inbox",
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("no-download must not use live fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      addResult.record.id,
      "--no-download",
      "--policy",
      "request-only",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    const data = expectDownloadData(result.envelope);
    expect(data.download).toBe(false);
    expect(data.artifactPath).toBeUndefined();
    expect(data.input).toMatchObject({
      kind: "workspace_item",
      value: addResult.record.id,
      itemId: addResult.record.id,
      attachedItemId: addResult.record.id,
      url: "https://example.test/files/no-download.pdf",
    });
    expect(data.record).toMatchObject({
      status: "requested",
      itemId: addResult.record.id,
      remoteUrl: "https://example.test/files/no-download.pdf",
      provenance: {
        origin: "resolved",
        providerId: "fixture-artifact-downloader",
        policy: "request-only",
        resolvedFrom: addResult.record.id,
      },
      attempts: [
        expect.objectContaining({
          tier: "artifact-record",
          ok: true,
          providerId: "fixture-artifact-downloader",
        }),
      ],
    });
    await expect(stat(path.join(root, "artifact-storage"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readArtifactRecord(workspaceRoot, data.record.id)).resolves.toMatchObject({
      id: data.record.id,
      status: "requested",
      itemId: addResult.record.id,
    });
  });

  it("rejects path-like --attach-to values before writing any artifact records", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-artifact-invalid-attach-");
    const fetchMock = vi.fn(async () => {
      throw new Error("invalid attach-to must not use live fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      "https://example.test/files/invalid-attach.pdf",
      "--attach-to",
      "../bad-item",
      "--no-download",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.envelope).toMatchObject({
      ok: false,
      capability: "acquire",
      tool: "artifact_download",
      data: null,
      errors: ["Invalid workspace item id: ../bad-item"],
    });
    await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports committed artifact bytes as an orphan when record metadata cannot be written", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-artifact-orphan-");
    await mkdir(path.join(workspaceRoot, "material"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "material", "artifacts"), "block record directory", "utf8");

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      "https://example.test/files/orphan.pdf",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.envelope).toMatchObject({
      ok: false,
      capability: "acquire",
      tool: "artifact_download",
      data: null,
      orphan: {
        outcome: "orphaned",
        commitStage: "metadata",
        artifactId: expect.any(String),
        artifactPath: expect.any(String),
        storage: {
          schemaVersion: 1,
          sink: "local",
          area: "artifact",
          root: path.join(root, "artifact-storage"),
          key: expect.stringMatching(/\/fixture-download\.pdf$/u),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sizeBytes: "fixture downloader bytes\n".length,
        },
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        sizeBytes: "fixture downloader bytes\n".length,
        metadataPath: expect.stringMatching(/[\\/]material[\\/]artifacts[\\/][^\\/]+\.json$/u),
      },
      diagnostics: { partial: true, orphanedBytes: true },
      errors: [expect.stringContaining("metadata commit failed after bytes were committed")],
    });
    const orphan = (result.envelope as typeof result.envelope & { orphan: { artifactPath: string } }).orphan;
    await expect(readFile(orphan.artifactPath, "utf8")).resolves.toBe("fixture downloader bytes\n");
  });

  it("returns a shared dry-run plan without writing artifact files or records", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-artifact-dry-run-");
    const fetchMock = vi.fn(async () => {
      throw new Error("dry-run must not use live fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      "https://example.test/files/dry-run.pdf",
      "--attach-to",
      "item-123",
      "--policy",
      "dry-policy",
      "--dry-run",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.envelope).toMatchObject({
      ok: true,
      capability: "acquire",
      tool: "artifact_download",
      planned: true,
      data: {
        selectedPolicy: "dry-policy",
        selectedProvider: {
          id: "fixture-artifact-downloader",
          kind: "material",
          capabilities: ["acquire"],
        },
      },
      diagnostics: {
        workspaceRoot,
        attachTo: "item-123",
        download: true,
      },
    });
    expect(JSON.stringify(result.envelope.data)).toContain("<new-artifact-id>");
    await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
