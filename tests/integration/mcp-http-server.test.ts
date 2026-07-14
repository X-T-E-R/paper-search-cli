import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { startMcpHttpServer, type RunningMcpHttpServer } from "../../src/mcp/httpServer.js";

const tempDirs: string[] = [];
const servers: RunningMcpHttpServer[] = [];
const materialDownloaderFixturesRoot = path.resolve("tests", "fixtures", "material-downloaders");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
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

function createConfig(root: string): ResolvedConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    providers: {
      ...structuredClone(DEFAULT_CONFIG.providers),
      installDir: materialDownloaderFixturesRoot,
    },
    workspace: {
      ...structuredClone(DEFAULT_CONFIG.workspace),
      root: path.join(root, "workspace"),
      defaultCollection: "Inbox",
    },
    server: {
      ...structuredClone(DEFAULT_CONFIG.server),
      host: "127.0.0.1",
      port: 23121,
      transport: "http",
    },
    meta: {
      cwd: root,
      userConfigPath: path.join(root, "config.toml"),
      projectConfigPath: null,
      explicitConfigPath: null,
      loadedFiles: [],
      appliedEnvOverrides: [],
    },
    platform: {
      "fixture-artifact-downloader": { mode: "mcp" },
    },
    api: {},
  };
}

async function postRpc(endpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

describe("MCP HTTP server", () => {
  it("serves JSON-RPC tools and writes through the shared workspace core", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-mcp-http-"));
    tempDirs.push(root);
    const running = await startMcpHttpServer(createConfig(root), { port: 0 });
    servers.push(running);

    const info = await fetch(running.endpoint);
    expect(info.status).toBe(200);
    await expect(info.json()).resolves.toMatchObject({
      endpoint: "/mcp",
      status: "available",
      transport: "Streamable HTTP",
    });

    await expect(fetch(`${running.endpoint}/status`).then((response) => response.json())).resolves.toMatchObject({
      endpoint: running.endpoint,
      initialized: false,
    });

    const init = await postRpc(running.endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1.0" },
      },
    });
    expect(init).toMatchObject({
      result: {
        capabilities: {
          tools: { listChanged: false },
        },
      },
    });

    const tools = await postRpc(running.endpoint, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect((tools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain(
      "resource_add",
    );
    expect((tools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain(
      "artifact_download",
    );

    const add = await postRpc(running.endpoint, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "resource_add",
        arguments: {
          item: {
            itemType: "journalArticle",
            title: "MCP Stored Article",
            url: "https://example.test/mcp",
          },
          collectionPath: "MCP/Inbox",
          tags: ["mcp", "agent"],
        },
      },
    });
    const addText = (add.result as { content: Array<{ text: string }> }).content[0]!.text;
    const addResult = JSON.parse(addText) as {
      ok: boolean;
      data: { record: { id: string; tags: string[]; collectionPath: string } };
    };
    expect(addResult.ok).toBe(true);
    expect(addResult.data.record).toMatchObject({
      collectionPath: "MCP/Inbox",
      tags: ["mcp", "agent"],
    });
    await expect(
      readFile(path.join(root, "workspace", "items", `${addResult.data.record.id}.json`), "utf8"),
    ).resolves.toContain("MCP Stored Article");

    const list = await postRpc(running.endpoint, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "collection_list",
        arguments: { flat: true },
      },
    });
    const listText = (list.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(listText)).toMatchObject({
      ok: true,
      capability: "organize",
      tool: "collection_list",
      data: {
        format: "flat",
        count: 3,
        collections: expect.arrayContaining([
          expect.objectContaining({ path: "Inbox" }),
          expect.objectContaining({ path: "MCP" }),
          expect.objectContaining({ path: "MCP/Inbox", itemCount: 1 }),
        ]),
      },
    });

    const exported = await postRpc(running.endpoint, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "workspace_export",
        arguments: { format: "csv", collectionPath: "MCP", includeChildren: true },
      },
    });
    const exportText = (exported.result as { content: Array<{ text: string }> }).content[0]!.text;
    const exportResult = JSON.parse(exportText) as {
      ok: boolean;
      data: { format: string; count: number; content: string };
    };
    expect(exportResult).toMatchObject({
      ok: true,
      data: {
        format: "csv",
        count: 1,
        collectionPath: "MCP",
        includeChildren: true,
      },
    });
    expect(exportResult.data.content).toContain("MCP Stored Article");

    const artifactDownload = await postRpc(running.endpoint, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "artifact_download",
        arguments: {
          input: "https://example.test/mcp-fixture.pdf",
          provider: "fixture-artifact-downloader",
          policy: "mcp-fixture",
        },
      },
    });
    const artifactText = (artifactDownload.result as { content: Array<{ text: string }> }).content[0]!.text;
    const artifactResult = JSON.parse(artifactText) as {
      ok: boolean;
      capability: string;
      tool: string;
      data: {
        provider: { id: string };
        record: { id: string; path: string; provenance: { policy: string } };
      };
    };
    expect(artifactResult).toMatchObject({
      ok: true,
      capability: "acquire",
      tool: "artifact_download",
      data: {
        provider: { id: "fixture-artifact-downloader" },
        record: {
          provenance: { policy: "mcp-fixture" },
        },
      },
    });
    await expect(
      readFile(path.join(root, "workspace", artifactResult.data.record.path), "utf8"),
    ).resolves.toBe("fixture downloader bytes\n");

    const artifactList = await postRpc(running.endpoint, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "artifact_list",
        arguments: { standalone: true },
      },
    });
    const artifactListText = (artifactList.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(artifactListText)).toMatchObject({
      ok: true,
      capability: "acquire",
      tool: "artifact_list",
      data: {
        count: 1,
        standalone: true,
        records: [
          expect.objectContaining({
            id: artifactResult.data.record.id,
          }),
        ],
      },
      diagnostics: {
        sourceCounts: { artifacts: 1 },
        standalone: true,
      },
    });

    const artifactShow = await postRpc(running.endpoint, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "artifact_show",
        arguments: { artifactId: artifactResult.data.record.id },
      },
    });
    const artifactShowText = (artifactShow.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(artifactShowText)).toMatchObject({
      ok: true,
      capability: "acquire",
      tool: "artifact_show",
      data: {
        record: {
          id: artifactResult.data.record.id,
          provenance: {
            providerId: "fixture-artifact-downloader",
            policy: "mcp-fixture",
          },
        },
      },
    });

    const materialStatus = await postRpc(running.endpoint, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "material_status",
        arguments: { target: artifactResult.data.record.id },
      },
    });
    const materialStatusText = (materialStatus.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(materialStatusText)).toMatchObject({
      ok: true,
      capability: "orchestrate",
      tool: "material_status",
      data: {
        target: {
          kind: "artifact",
          id: artifactResult.data.record.id,
          artifactId: artifactResult.data.record.id,
        },
        hasArtifacts: true,
        artifactCount: 1,
        artifactIds: [artifactResult.data.record.id],
        hasExtractedOutputs: false,
        extractedOutputCount: 0,
        extractionCount: 0,
        extractionIds: [],
      },
      provenance: {
        providerIds: ["fixture-artifact-downloader"],
      },
    });

    const help = await fetch(`${running.helpEndpoint}?topic=workspace&locale=en`);
    expect(help.status).toBe(200);
    await expect(help.json()).resolves.toMatchObject({
      surface: "capability-first",
      locale: "en",
    });
  });
});
