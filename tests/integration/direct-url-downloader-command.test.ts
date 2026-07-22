import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/program.js";
import type { ArtifactDownloadData } from "../../src/material/artifactDownload.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";
import { resolveDistributableMaterialPackageDir } from "../helpers/distributableMaterialProviders.js";
import { setSafeExternalHttpsTestHooksForTests } from "../../src/runtime/safeExternalHttps.js";

const tempDirs: string[] = [];
let providerPackageDir = "";

beforeAll(async () => {
  providerPackageDir = await resolveDistributableMaterialPackageDir("direct-url-downloader");
});

beforeEach(() => {
  setSafeExternalHttpsTestHooksForTests({
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    requestPinned: async (url, init) => fetch(url, init),
  });
});

afterEach(async () => {
  setSafeExternalHttpsTestHooksForTests(undefined);
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function tomlPath(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

async function createWorkspace(prefix: string): Promise<{
  root: string;
  workspaceRoot: string;
  artifactRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const providersRoot = path.join(root, "providers");
  const workspaceRoot = path.join(root, "workspace");
  const artifactRoot = path.join(root, "artifacts");
  await cp(
    providerPackageDir,
    path.join(providersRoot, "material", "direct-url-downloader"),
    { recursive: true },
  );
  await writeFile(
    path.join(root, "paper-search.toml"),
    [
      "[providers]",
      `installDir = "${tomlPath(providersRoot)}"`,
      "",
      "[workspace]",
      `root = "${tomlPath(workspaceRoot)}"`,
      'defaultCollection = "Inbox"',
      "",
      "[storage]",
      `artifactRoot = "${tomlPath(artifactRoot)}"`,
      `extractionRoot = "${tomlPath(path.join(root, "extractions"))}"`,
      `exportRoot = "${tomlPath(path.join(root, "exports"))}"`,
      "",
      "[material]",
      'downloadDisposition = "materialized"',
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, workspaceRoot, artifactRoot };
}

async function runArtifactCommand(root: string, args: string[]): Promise<ResultEnvelope> {
  let stdout = "";
  let stderr = "";
  const originalCwd = process.cwd();
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
  }
  expect(stderr).toBe("");
  const envelope = JSON.parse(stdout) as ResultEnvelope;
  expect(isResultEnvelope(envelope)).toBe(true);
  return envelope;
}

describe("direct-url-downloader command integration", () => {
  it("acquires non-UTF8 PDF bytes into managed artifact storage with provider provenance", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-direct-download-");
    const sourceBytes = Uint8Array.from([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff, 0x80,
    ]);
    const fetchMock = vi.fn(async () => new Response(sourceBytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(sourceBytes.byteLength),
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const envelope = await runArtifactCommand(root, [
      "artifact",
      "download",
      "https://arxiv.org/pdf/2404.06314",
      "--provider",
      "direct-url-downloader",
      "--policy",
      "qce-qsys-exemplar",
      "--json",
    ]);

    expect(envelope).toMatchObject({
      ok: true,
      capability: "acquire",
      tool: "artifact_download",
      provenance: {
        providerIds: ["direct-url-downloader"],
        policy: "qce-qsys-exemplar",
      },
    });
    const data = envelope.data as ArtifactDownloadData;
    expect(data.provider).toMatchObject({ id: "direct-url-downloader", version: "1.0.0" });
    expect(data.record).toMatchObject({
      kind: "pdf",
      status: "downloaded",
      filename: "2404.06314.pdf",
      contentType: "application/pdf",
      remoteUrl: "https://arxiv.org/pdf/2404.06314",
      sizeBytes: sourceBytes.byteLength,
      provenance: {
        origin: "download",
        sourceUrl: "https://arxiv.org/pdf/2404.06314",
        providerId: "direct-url-downloader",
        policy: "qce-qsys-exemplar",
      },
      attempts: [
        expect.objectContaining({
          tier: "artifact-download-candidate",
          providerId: "direct-url-downloader",
          ok: true,
          status: 200,
        }),
      ],
    });
    await expect(readFile(data.artifactPath!)).resolves.toEqual(Buffer.from(sourceBytes));
    await expect(readFile(
      path.join(workspaceRoot, "material", "artifacts", `${data.record.id}.json`),
      "utf8",
    )).resolves.toContain('"providerId": "direct-url-downloader"');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps dry-run network- and write-free while selecting the declared downloader", async () => {
    const { root, workspaceRoot, artifactRoot } = await createWorkspace(
      "paper-search-direct-download-plan-",
    );
    const fetchMock = vi.fn(async () => {
      throw new Error("dry-run must not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope = await runArtifactCommand(root, [
      "artifact",
      "download",
      "https://arxiv.org/pdf/2404.06314",
      "--provider",
      "direct-url-downloader",
      "--dry-run",
      "--json",
    ]);

    expect(envelope).toMatchObject({
      ok: true,
      planned: true,
      data: {
        selectedProvider: {
          id: "direct-url-downloader",
          kind: "material",
          capabilities: ["acquire"],
        },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses signed query URLs transiently without persisting or printing their values or fragment", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-direct-download-secret-url-");
    const sentinel = "URL_SECRET_SENTINEL_73c5f6";
    const signedUrl = `https://arxiv.org/pdf/signed.pdf?X-Amz-Signature=${sentinel}&download=${sentinel}#${sentinel}`;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain(sentinel);
      return new Response(Uint8Array.from([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope = await runArtifactCommand(root, [
      "artifact", "download", signedUrl,
      "--provider", "direct-url-downloader", "--json",
    ]);

    expect(envelope.ok).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(sentinel);
    const data = envelope.data as ArtifactDownloadData;
    expect(data.record.remoteUrl).toContain("X-Amz-Signature=");
    expect(data.record.remoteUrl).toContain("download=");
    expect(data.record.remoteUrl).not.toContain("#");
    const persisted = await readFile(
      path.join(workspaceRoot, "material", "artifacts", `${data.record.id}.json`),
      "utf8",
    );
    expect(persisted).not.toContain(sentinel);
    expect(persisted).toContain("X-Amz-Signature");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("surfaces an upstream HTTP failure without committing bytes or metadata", async () => {
    const { root, workspaceRoot, artifactRoot } = await createWorkspace(
      "paper-search-direct-download-upstream-",
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporarily unavailable", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "text/plain" },
    })));

    const envelope = await runArtifactCommand(root, [
      "artifact",
      "download",
      "https://arxiv.org/pdf/2404.06314",
      "--provider",
      "direct-url-downloader",
      "--json",
    ]);

    expect(envelope).toMatchObject({
      ok: false,
      capability: "acquire",
      tool: "artifact_download",
      data: null,
      errors: [
        expect.stringContaining(
          "direct-url-downloader upstream request failed: HTTP 503 Service Unavailable from arxiv.org",
        ),
      ],
    });
    await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
