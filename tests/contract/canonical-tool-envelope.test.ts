import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { handleMcpToolCall } from "../../src/mcp/toolHandlers.js";
import { getCanonicalToolNames } from "../../src/surface/toolCatalog.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
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
      installDir: path.join(root, "providers"),
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

function stubLookupFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe("https://example.test/lookup");
      return new Response(
        [
          "<html><head>",
          '<meta name="citation_title" content="Envelope Lookup" />',
          '<meta name="description" content="Lookup fixture." />',
          "</head><body></body></html>",
        ].join(""),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }),
  );
}

describe("canonical MCP tool result envelopes", () => {
  it("returns a ResultEnvelope for every canonical tool without live network", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-tool-envelope-"));
    tempDirs.push(root);
    const config = createConfig(root);
    stubLookupFetch();

    let workspaceItemId = "";
    const argsByTool: Record<string, Record<string, unknown>> = {
      mcp_help: { topic: "overview", locale: "en" },
      academic_search: { query: "retrieval augmented generation" },
      resource_lookup: { url: "https://example.test/lookup" },
      patent_search: { query: "solid state battery" },
      patent_detail: { platform: "missing-provider", sourceId: "PAT-001" },
      web_search: { query: "RAG evaluation" },
      web_research: { query: "API docs", includeSocial: false },
      resource_add: {
        item: {
          itemType: "journalArticle",
          title: "Envelope Workspace Item",
          url: "https://example.test/item",
        },
        collectionPath: "Contracts/Envelope",
      },
      collection_list: { flat: true },
      workspace_export: { format: "json" },
      resource_pdf: {},
      artifact_download: {},
      artifact_list: {},
      artifact_show: {},
      extract: {},
      material_ingest: {},
      material_status: {},
      material_provider_list_installed: { kind: "material" },
      platform_status: {},
    };
    const expectedMaterialCapabilities: Record<string, string> = {
      artifact_download: "acquire",
      artifact_list: "acquire",
      artifact_show: "acquire",
      extract: "extract",
      material_ingest: "orchestrate",
      material_status: "orchestrate",
      material_provider_list_installed: "operate",
    };

    for (const tool of getCanonicalToolNames()) {
      if (tool === "resource_pdf") {
        argsByTool.resource_pdf = {
          itemKey: workspaceItemId,
          url: "https://example.test/paper.pdf",
          download: false,
        };
      }

      const result = await handleMcpToolCall(config, tool, argsByTool[tool] ?? {});
      expect(isResultEnvelope(result), tool).toBe(true);
      const envelope = result as ResultEnvelope;
      expect(envelope.tool).toBe(tool);
      if (expectedMaterialCapabilities[tool]) {
        expect(envelope.capability).toBe(expectedMaterialCapabilities[tool]);
      }

      if (tool === "resource_add") {
        expect(envelope.ok).toBe(true);
        workspaceItemId = ((envelope.data as { record: { id: string } }).record.id);
      }
    }
  });
});
