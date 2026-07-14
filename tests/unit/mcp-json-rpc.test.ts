import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { PaperSearchMcpServer } from "../../src/mcp/jsonRpc.js";

const tempDirs: string[] = [];
const materialDownloaderFixturesRoot = path.resolve("tests", "fixtures", "material-downloaders");

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

function createConfig(root: string, installDir = path.join(root, "providers")): ResolvedConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    providers: {
      ...structuredClone(DEFAULT_CONFIG.providers),
      installDir,
    },
    workspace: {
      ...structuredClone(DEFAULT_CONFIG.workspace),
      root: path.join(root, "workspace"),
      defaultCollection: "Inbox",
    },
    meta: {
      cwd: root,
      userConfigPath: path.join(root, "config.toml"),
      projectConfigPath: null,
      explicitConfigPath: null,
      loadedFiles: [],
      appliedEnvOverrides: [],
    },
    platform: {},
    api: {},
  };
}

function parseBody(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

describe("PaperSearchMcpServer", () => {
  it("handles initialize, notifications, tools/list, and tools/call", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-mcp-unit-"));
    tempDirs.push(root);
    const server = new PaperSearchMcpServer(createConfig(root));

    const init = await server.handleMcpRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "vitest", version: "1.0" },
        },
      }),
    );
    expect(init.status).toBe(200);
    expect(parseBody(init.body)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "paper-search-cli-mcp", version: "0.5.0" },
      },
    });

    const notification = await server.handleMcpRequest(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(notification.status).toBe(202);
    expect(notification.body).toBe("");

    const list = await server.handleMcpRequest(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    );
    const listBody = parseBody(list.body) as {
      result: {
        tools: Array<{
          name: string;
          capability?: string;
          annotations?: { capabilityGroup?: string };
        }>;
      };
    };
    expect(list.status).toBe(200);
    expect(list.body).not.toContain('"enum":[]');
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "mcp_help",
        "academic_search",
        "resource_add",
        "workspace_export",
        "resource_pdf",
        "artifact_download",
        "artifact_list",
        "artifact_show",
        "extract",
        "material_ingest",
        "material_status",
        "material_provider_list_installed",
      ]),
    );
    for (const expected of [
      ["artifact_download", "acquire"],
      ["artifact_list", "acquire"],
      ["artifact_show", "acquire"],
      ["extract", "extract"],
      ["material_ingest", "orchestrate"],
      ["material_status", "orchestrate"],
      ["material_provider_list_installed", "operate"],
    ] as const) {
      const tool = listBody.result.tools.find((entry) => entry.name === expected[0]);
      expect(tool, expected[0]).toBeDefined();
      expect(tool?.capability).toBe(expected[1]);
      expect(tool?.annotations?.capabilityGroup).toBe(expected[1]);
    }

    const call = await server.handleMcpRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "mcp_help",
          arguments: { topic: "workspace", locale: "en" },
        },
      }),
    );
    const callBody = parseBody(call.body) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(call.status).toBe(200);
    expect(callBody.result.content[0]).toMatchObject({ type: "text" });
    expect(JSON.parse(callBody.result.content[0]!.text)).toMatchObject({
      ok: true,
      capability: "operate",
      tool: "mcp_help",
      data: {
        surface: "capability-first",
        locale: "en",
      },
    });
  });

  it("returns ResultEnvelope failures for known invalid tool arguments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-mcp-invalid-args-"));
    tempDirs.push(root);
    const server = new PaperSearchMcpServer(createConfig(root));

    const invalidExport = await server.handleMcpRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "workspace_export",
          arguments: { format: "xml" },
        },
      }),
    );
    expect(invalidExport.status).toBe(200);
    const invalidExportBody = parseBody(invalidExport.body) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(invalidExportBody.result.isError).toBe(true);
    expect(JSON.parse(invalidExportBody.result.content[0]!.text)).toMatchObject({
      ok: false,
      capability: "organize",
      tool: "workspace_export",
      errors: [expect.stringContaining("format must be one of")],
    });

    const invalidWebSearch = await server.handleMcpRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: {
            query: "RAG evaluation",
            mode: "invalid-mode",
          },
        },
      }),
    );
    expect(invalidWebSearch.status).toBe(200);
    const invalidWebSearchBody = parseBody(invalidWebSearch.body) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(invalidWebSearchBody.result.isError).toBe(true);
    expect(JSON.parse(invalidWebSearchBody.result.content[0]!.text)).toMatchObject({
      ok: false,
      capability: "discover",
      tool: "web_search",
      errors: [expect.stringContaining("mode must be one of")],
    });
  });

  it("routes material provider status through the shared canonical tool runner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-mcp-material-provider-"));
    tempDirs.push(root);
    const server = new PaperSearchMcpServer(createConfig(root, materialDownloaderFixturesRoot));

    const response = await server.handleMcpRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "material_provider_list_installed",
          arguments: { kind: "material" },
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = parseBody(response.body) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({
      ok: true,
      capability: "operate",
      tool: "material_provider_list_installed",
      data: {
        kind: "material",
        installDir: materialDownloaderFixturesRoot,
        installed: [
          expect.objectContaining({
            id: "fixture-artifact-downloader",
            valid: true,
          }),
        ],
      },
      diagnostics: {
        installedCount: 1,
        invalidCount: 0,
      },
      provenance: {
        providerIds: ["fixture-artifact-downloader"],
      },
    });
  });

  it("returns JSON-RPC errors for malformed requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-mcp-errors-"));
    tempDirs.push(root);
    const server = new PaperSearchMcpServer(createConfig(root));

    const parseError = await server.handleMcpRequest("{not-json");
    expect(parseError.status).toBe(400);
    expect(parseBody(parseError.body)).toMatchObject({
      error: { code: -32700, message: "Parse error" },
    });

    const unknown = await server.handleMcpRequest(
      JSON.stringify({ jsonrpc: "2.0", id: "bad", method: "missing/method" }),
    );
    expect(unknown.status).toBe(200);
    expect(parseBody(unknown.body)).toMatchObject({
      id: "bad",
      error: { code: -32601, message: "Method not found: missing/method" },
    });
  });
});
