import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMaterialProviderPackage } from "../../src/material/package/load.js";
import {
  createMaterialRuntimeContext,
  MaterialRuntimePathError,
  MaterialRuntimePermissionError,
  type MaterialHttpTransport,
} from "../../src/material/runtime/createContext.js";
import { invokeMaterialProviderFactoryInNode } from "../../src/material/runtime/invokeNodeFactory.js";
import type { MaterialProviderManifest } from "../../src/material/types.js";
import { setSafeExternalHttpsTestHooksForTests } from "../../src/runtime/safeExternalHttps.js";

const packagesRoot = path.resolve("tests", "fixtures", "material-runtime-packages");

beforeEach(() => {
  setSafeExternalHttpsTestHooksForTests({
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    requestPinned: async (url, init) => fetch(url, init),
  });
});

afterEach(() => {
  setSafeExternalHttpsTestHooksForTests(undefined);
  vi.unstubAllGlobals();
});

function createStubTransport(): MaterialHttpTransport & {
  requests: Array<{ method: "GET" | "POST"; url: string; body?: unknown }>;
} {
  const requests: Array<{ method: "GET" | "POST"; url: string; body?: unknown }> = [];
  return {
    requests,
    async get<T = unknown>(url: string) {
      requests.push({ method: "GET", url });
      return {
        data: { method: "GET", url } as T,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      };
    },
    async post<T = unknown>(url: string, body?: string | Record<string, unknown>) {
      requests.push({ method: "POST", url, body });
      return {
        data: { method: "POST", url, body } as T,
        status: 201,
        statusText: "Created",
        headers: { "content-type": "application/json" },
      };
    },
  };
}

function manifestFor(options: {
  id?: string;
  network?: boolean;
  localWrite?: "none" | "cache" | "workspace";
  permissionsNetwork?: string[];
}): MaterialProviderManifest {
  return {
    id: options.id ?? "runtime-scope",
    name: "Runtime Scope",
    version: "1.0.0",
    kind: "extractor",
    entry: "provider.js",
    capabilities: {
      inputs: ["url"],
      outputs: ["json"],
      network: options.network ?? true,
    },
    configSchema: {
      apiKey: { type: "secret" },
      mode: { type: "string", default: "fixture" },
    },
    permissions: {
      network: options.permissionsNetwork ?? ["https://allowed.example/*"],
      localWrite: options.localWrite ?? "workspace",
    },
  };
}

describe("material provider runtime context", () => {
  it("lets a fixture provider use permitted HTTP, config redaction, provider cache, policy, and workspace writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-"));
    const loaded = await loadMaterialProviderPackage(path.join(packagesRoot, "fixture-runtime"));
    const transport = createStubTransport();
    const runtimeContext = createMaterialRuntimeContext({
      manifest: loaded.manifest,
      providerConfig: {
        apiKey: "secret-token",
        mode: "contract",
        extraToken: "shadow-secret",
      },
      policy: { name: "workspace-safe", mode: "strict" },
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      transport,
    });
    expect(runtimeContext.config.get("extraToken")).toBe("shadow-secret");
    expect(runtimeContext.config.getRedacted("extraToken")).toBe("<redacted>");
    const loadedRuntime = await invokeMaterialProviderFactoryInNode(
      loaded.bundleCode,
      loaded.manifest,
      runtimeContext,
    );

    expect(loadedRuntime.inspection.methods).toEqual(["exercise", "probeDenied"]);

    const result = (await loadedRuntime.provider.exercise!()) as {
      getData: { method: string; url: string };
      postData: { method: string; body: Record<string, unknown> };
      secret: string;
      redactedApiKey: string;
      redactedConfig: Record<string, unknown>;
      cacheWrite: { path: string };
      cacheValue: { ok: boolean; status: number };
      policy: { name: string; mode: string };
      policyMode: string;
      workspaceWrite: { path: string };
    };

    expect(result.getData).toEqual({
      method: "GET",
      url: "https://allowed.example/resource?q=runtime",
    });
    expect(result.postData).toEqual({
      method: "POST",
      url: "https://allowed.example/submit",
      body: { id: "fixture-runtime" },
    });
    expect(result.secret).toBe("secret-token");
    expect(result.redactedApiKey).toBe("<redacted>");
    expect(result.redactedConfig).toMatchObject({
      apiKey: "<redacted>",
      mode: "contract",
      extraToken: "<redacted>",
    });
    expect(result.cacheWrite.path).toBe("state/result.json");
    expect(result.cacheValue).toEqual({ ok: true, status: 200 });
    expect(result.policy).toEqual({ name: "workspace-safe", mode: "strict" });
    expect(result.policyMode).toBe("strict");
    expect(result.workspaceWrite.path).toBe("material/fixture-runtime/result.md");
    await expect(
      readFile(path.join(root, "cache", "fixture-runtime", "state", "result.json"), "utf8"),
    ).resolves.toContain("\"ok\": true");
    await expect(
      readFile(path.join(root, "workspace", "material", "fixture-runtime", "result.md"), "utf8"),
    ).resolves.toBe("# Fixture Runtime\n");
    expect(transport.requests).toEqual([
      { method: "GET", url: "https://allowed.example/resource?q=runtime" },
      {
        method: "POST",
        url: "https://allowed.example/submit",
        body: { id: "fixture-runtime" },
      },
    ]);

    const denied = (await loadedRuntime.provider.probeDenied!()) as Array<{
      label: string;
      denied: boolean;
      message: string;
    }>;
    expect(denied).toEqual([
      expect.objectContaining({ label: "network", denied: true }),
      expect.objectContaining({ label: "cacheEscape", denied: true }),
      expect.objectContaining({ label: "workspaceEscape", denied: true }),
    ]);
    expect(denied.map((entry) => entry.message).join("\n")).toContain("not allowed");
    expect(denied.map((entry) => entry.message).join("\n")).toContain("escapes root");
  });

  it("denies HTTP when network capability is false even if URL permissions match", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-no-net-"));
    const runtimeContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "no-network", network: false }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      transport: createStubTransport(),
    });

    await expect(runtimeContext.http.get("https://allowed.example/resource")).rejects.toThrow(
      MaterialRuntimePermissionError,
    );
  });

  it("denies HTTP when the URL is outside manifest network permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-net-scope-"));
    const runtimeContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "network-scope" }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      transport: createStubTransport(),
    });

    await expect(runtimeContext.http.post("https://blocked.example/submit", {})).rejects.toThrow(
      MaterialRuntimePermissionError,
    );
  });

  it("returns binary HTTP bodies as bounded Base64 without UTF-8 conversion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-binary-"));
    const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80, 0x0a]);
    const fetchMock = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const runtimeContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "binary-response" }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
    });

    const response = await runtimeContext.http.get<string>(
      "https://allowed.example/paper.pdf",
      { responseType: "base64", maxResponseBytes: bytes.byteLength },
    );

    expect(Buffer.from(response.data, "base64")).toEqual(Buffer.from(bytes));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a binary HTTP response that exceeds maxResponseBytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-limit-"));
    const fetchMock = vi.fn(async () => new Response(Uint8Array.from([1, 2, 3, 4, 5]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const runtimeContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "bounded-response" }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
    });

    await expect(runtimeContext.http.get(
      "https://allowed.example/too-large.bin",
      { responseType: "base64", maxResponseBytes: 4 },
    )).rejects.toThrow("Material HTTP response exceeds maxResponseBytes (5 bytes > 4 bytes)");
  });

  it("requires an explicit byte limit for binary HTTP responses", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-no-limit-"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Uint8Array.from([1]), {
      status: 200,
    })));
    const runtimeContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "unbounded-response" }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
    });

    await expect(runtimeContext.http.get(
      "https://allowed.example/unbounded.bin",
      { responseType: "base64" },
    )).rejects.toThrow("Base64 material HTTP responses require maxResponseBytes");
  });

  it("enforces public HTTPS and manifest permissions on every pinned redirect hop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-ssrf-"));
    const requests: string[] = [];
    const context = createMaterialRuntimeContext({
      manifest: manifestFor({
        id: "redirect-policy",
        permissionsNetwork: ["https://*.example/*"],
      }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
    });

    await expect(context.http.get("https://user:secret@public.example/start"))
      .rejects.toThrow("must not contain userinfo");
    const broadContext = createMaterialRuntimeContext({
      manifest: manifestFor({
        id: "broad-network-scope",
        permissionsNetwork: ["https://*"],
      }),
      cacheRoot: path.join(root, "broad-cache"),
      workspaceRoot: path.join(root, "broad-workspace"),
    });
    await expect(broadContext.http.get("https://127.0.0.1/start"))
      .rejects.toThrow("non-public address");

    setSafeExternalHttpsTestHooksForTests({
      resolve: async (hostname) => [{
        address: hostname === "private.example" ? "10.0.0.7" : "8.8.8.8",
        family: 4,
      }],
      requestPinned: async (url) => {
        requests.push(url.toString());
        return new Response(null, {
          status: 302,
          headers: { location: "https://private.example/metadata" },
        });
      },
    });
    await expect(context.http.get("https://public.example/start"))
      .rejects.toThrow("non-public address");
    expect(requests).toEqual(["https://public.example/start"]);

    setSafeExternalHttpsTestHooksForTests({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      requestPinned: async () => new Response(null, {
        status: 302,
        headers: { location: "https://forbidden.test/result" },
      }),
    });
    await expect(context.http.get("https://public.example/start"))
      .rejects.toThrow("URL not allowed by material provider permissions");

    let hop = 0;
    setSafeExternalHttpsTestHooksForTests({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      requestPinned: async () => new Response(null, {
        status: 302,
        headers: { location: `https://public.example/hop-${++hop}` },
      }),
    });
    await expect(context.http.get("https://public.example/start"))
      .rejects.toThrow("exceeded 5 redirects");

    setSafeExternalHttpsTestHooksForTests({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      requestPinned: async (url) => url.pathname === "/start"
        ? new Response(null, { status: 302, headers: { location: "/final" } })
        : new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    });
    await expect(context.http.get<{ ok: boolean }>("https://public.example/start"))
      .resolves.toMatchObject({ data: { ok: true }, status: 200 });
  });

  it("reads a preferred Markdown entry from a bounded safe ZIP archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-zip-"));
    const zip = new JSZip();
    zip.file("README.md", "# Package notes\n");
    zip.file("result/full.md", "# Extracted paper\n\nBody\n");
    zip.file("result/layout.json", "{}\n");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const runtimeContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "zip-markdown" }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      transport: createStubTransport(),
    });

    await expect(runtimeContext.archive.readMarkdownFromZipBase64(
      bytes.toString("base64"),
      {
        maxArchiveBytes: bytes.byteLength,
        maxMarkdownBytes: 1024,
        preferredEntryNames: ["full.md"],
      },
    )).resolves.toEqual({
      markdown: "# Extracted paper\n\nBody\n",
      entryPath: "result/full.md",
      entryCount: 3,
      markdownBytes: 24,
    });
  });

  it("validates and reads a multi-megabyte Base64 ZIP without exhausting the call stack", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-large-zip-"));
    const zip = new JSZip();
    zip.file("full.md", "# Large archive result\n");
    zip.file("assets/padding.bin", Buffer.alloc(6 * 1024 * 1024, 0xa5), {
      compression: "STORE",
    });
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    const archiveBase64 = bytes.toString("base64");
    expect(archiveBase64.length).toBeGreaterThan(8_000_000);
    const runtimeContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "large-zip-markdown" }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      transport: createStubTransport(),
    });

    await expect(runtimeContext.archive.readMarkdownFromZipBase64(
      archiveBase64,
      {
        maxArchiveBytes: bytes.byteLength,
        maxMarkdownBytes: 1024,
        preferredEntryNames: ["full.md"],
      },
    )).resolves.toEqual({
      markdown: "# Large archive result\n",
      entryPath: "full.md",
      entryCount: 2,
      markdownBytes: 23,
    });
    await expect(runtimeContext.archive.readMarkdownFromZipBase64(
      "AA==AAAA",
      { maxArchiveBytes: 1024, maxMarkdownBytes: 1024 },
    )).rejects.toThrow("archiveBase64 must be valid padded Base64");
  }, 10_000);

  it("rejects unsafe ZIP paths and oversized Markdown before returning text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-zip-limit-"));
    const runtimeContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "zip-markdown-limit" }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      transport: createStubTransport(),
    });
    const unsafeZip = new JSZip();
    unsafeZip.file("../escape.md", "unsafe");
    const unsafeBytes = await unsafeZip.generateAsync({ type: "nodebuffer" });
    await expect(runtimeContext.archive.readMarkdownFromZipBase64(
      unsafeBytes.toString("base64"),
      { maxArchiveBytes: unsafeBytes.byteLength, maxMarkdownBytes: 1024 },
    )).rejects.toThrow("Unsafe material archive entry path: ../escape.md");

    const oversizedZip = new JSZip();
    oversizedZip.file("full.md", "12345");
    const oversizedBytes = await oversizedZip.generateAsync({ type: "nodebuffer" });
    await expect(runtimeContext.archive.readMarkdownFromZipBase64(
      oversizedBytes.toString("base64"),
      { maxArchiveBytes: oversizedBytes.byteLength, maxMarkdownBytes: 4 },
    )).rejects.toThrow("Material archive Markdown exceeds maxMarkdownBytes (5 bytes > 4 bytes)");

    const expandingZip = new JSZip();
    expandingZip.file("full.md", "x".repeat(2 * 1024 * 1024));
    const forged = await expandingZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    for (let index = 0; index <= forged.length - 4; index += 1) {
      if (forged.readUInt32LE(index) === 0x02014b50) forged.writeUInt32LE(1, index + 24);
    }
    await expect(runtimeContext.archive.readMarkdownFromZipBase64(
      forged.toString("base64"),
      { maxArchiveBytes: forged.byteLength, maxMarkdownBytes: 32 * 1024 },
    )).rejects.toThrow("maxMarkdownBytes");
  });

  it("enforces localWrite none, cache, and workspace scopes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-write-"));
    const noneContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "none-scope", localWrite: "none" }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      transport: createStubTransport(),
    });
    await expect(noneContext.cache.writeText("state.txt", "no")).rejects.toThrow(
      MaterialRuntimePermissionError,
    );
    await expect(noneContext.workspace.writeText("out.txt", "no")).rejects.toThrow(
      MaterialRuntimePermissionError,
    );

    const cacheContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "cache-scope", localWrite: "cache" }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      transport: createStubTransport(),
    });
    await expect(cacheContext.cache.writeText("state.txt", "ok")).resolves.toEqual({
      path: "state.txt",
    });
    await expect(cacheContext.workspace.writeText("out.txt", "no")).rejects.toThrow(
      MaterialRuntimePermissionError,
    );

    const workspaceContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "workspace-scope", localWrite: "workspace" }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      transport: createStubTransport(),
    });
    await expect(workspaceContext.cache.writeText("state.txt", "ok")).resolves.toEqual({
      path: "state.txt",
    });
    await expect(workspaceContext.workspace.writeText("out.txt", "ok")).resolves.toEqual({
      path: "out.txt",
    });
  });

  it("keeps cache and workspace writes inside their roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-material-runtime-path-"));
    const runtimeContext = createMaterialRuntimeContext({
      manifest: manifestFor({ id: "path-scope", localWrite: "workspace" }),
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      transport: createStubTransport(),
    });

    await expect(runtimeContext.cache.writeText("../escape.txt", "bad")).rejects.toThrow(
      MaterialRuntimePathError,
    );
    await expect(runtimeContext.workspace.writeText("../escape.txt", "bad")).rejects.toThrow(
      MaterialRuntimePathError,
    );
  });
});
