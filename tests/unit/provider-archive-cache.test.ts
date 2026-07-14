import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureProviderArchiveCached } from "../../src/providers/archiveCache.js";

const roots: string[] = [];

function testEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPDATA: path.join(root, "appdata"),
    PAPER_SEARCH_INSTALL_TEST_MODE: "1",
    PAPER_SEARCH_TEST_DATA_ROOT: path.join(root, "data"),
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("provider archive cache", () => {
  it("caches verified HTTPS bytes by SHA-256 and reuses them without a second fetch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-archive-cache-"));
    roots.push(root);
    const env = testEnv(root);
    const bytes = new TextEncoder().encode("verified archive bytes");
    const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
    const fetchMock = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/zip" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const source = {
      sourceType: "https" as const,
      ref: "https://registry.example.test/releases/alpha.zip",
      displayRef: "https://registry.example.test/releases/alpha.zip",
    };
    const first = await ensureProviderArchiveCached({ source, archiveSha256, env });
    const second = await ensureProviderArchiveCached({ source, archiveSha256, env });
    expect(first).toMatchObject({ cacheHit: false, archiveSha256 });
    expect(second).toMatchObject({ cacheHit: true, cachePath: first.cachePath });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects checksum mismatch without selecting a cache entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-archive-mismatch-"));
    roots.push(root);
    const env = testEnv(root);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("wrong bytes", { status: 200 })));
    const archiveSha256 = "a".repeat(64);
    await expect(ensureProviderArchiveCached({
      source: {
        sourceType: "https",
        ref: "https://registry.example.test/releases/alpha.zip",
        displayRef: "https://registry.example.test/releases/alpha.zip",
      },
      archiveSha256,
      env,
    })).rejects.toThrow(/SHA-256 mismatch/);
    await expect(access(path.join(root, "data", "cache", "archives", `${archiveSha256}.zip`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an archive redirect that leaves HTTPS before downloading bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-archive-redirect-"));
    roots.push(root);
    const env = testEnv(root);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "http://downloads.example.test/alpha.zip" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(ensureProviderArchiveCached({
      source: {
        sourceType: "https",
        ref: "https://registry.example.test/releases/alpha.zip",
        displayRef: "https://registry.example.test/releases/alpha.zip",
      },
      archiveSha256: "a".repeat(64),
      env,
    })).rejects.toThrow(/must use HTTPS/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
