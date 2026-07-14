import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMaterialProviderPackage } from "../../src/material/package/load.js";
import {
  createMaterialRuntimeContext,
  MaterialRuntimePathError,
  MaterialRuntimePermissionError,
  type MaterialHttpTransport,
} from "../../src/material/runtime/createContext.js";
import { invokeMaterialProviderFactoryInNode } from "../../src/material/runtime/invokeNodeFactory.js";
import type { MaterialProviderManifest } from "../../src/material/types.js";

const packagesRoot = path.resolve("tests", "fixtures", "material-runtime-packages");

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
