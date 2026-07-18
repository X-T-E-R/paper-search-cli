import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtractionRecord } from "../../src/material/extractionStore.js";
import { buildProgram } from "../../src/program.js";
import { addResourceToWorkspace } from "../../src/workspace/store.js";

const tempRoots: string[] = [];
const servers: Server[] = [];
const originalPaperSearchHome = process.env.PAPER_SEARCH_HOME;

interface RpcRequest {
  name: string;
  arguments: Record<string, unknown>;
}

interface WorkspaceFixture {
  home: string;
  workspaceRoot: string;
  itemId: string;
  extractionId: string;
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  restore("PAPER_SEARCH_HOME", originalPaperSearchHome);
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspaceFixture(options: { unavailable?: "error" | "warn" } = {}): Promise<WorkspaceFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-zotero-command-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const workspaceRoot = path.join(home, "workspace");
  process.env.PAPER_SEARCH_HOME = home;

  if (options.unavailable) {
    await mkdir(home, { recursive: true });
    await writeFile(
      path.join(home, "config.toml"),
      `schemaVersion = 1\n[zotero]\nunavailable = "${options.unavailable}"\n`,
      "utf8",
    );
  }

  const added = await addResourceToWorkspace(workspaceRoot, {
    item: {
      itemType: "journalArticle",
      title: "CLI Zotero export",
      date: "2025-03-04",
      DOI: "10.1000/cli-zotero",
      volume: "12",
      creators: [{ firstName: "Ada", lastName: "Lovelace", creatorType: "author" }],
    },
    defaultCollectionPath: "Inbox",
  });
  const extraction = await createExtractionRecord(workspaceRoot, {
    source: { kind: "path", path: "local/source.pdf" },
    backend: "fixture",
    outputs: { markdown: "Local markdown remains authoritative." },
    cacheHit: false,
    itemId: added.record.id,
  });
  return { home, workspaceRoot, itemId: added.record.id, extractionId: extraction.id };
}

async function runCommand(args: string[]): Promise<{ envelope: Record<string, any>; stderr: string }> {
  let stdout = "";
  let stderr = "";
  await buildProgram({
    stdout: { write(chunk: string) { stdout += chunk; } },
    stderr: { write(chunk: string) { stderr += chunk; } },
  }).exitOverride().parseAsync(["node", "paper-search", ...args]);
  return { envelope: JSON.parse(stdout.trim()) as Record<string, any>, stderr };
}

async function startRpcServer(respond: (request: RpcRequest) => unknown): Promise<{ endpoint: string; requests: RpcRequest[] }> {
  const requests: RpcRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: string | number | null;
      params: { name: string; arguments: Record<string, unknown> };
    };
    const toolRequest: RpcRequest = { name: rpc.params.name, arguments: rpc.params.arguments };
    requests.push(toolRequest);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { content: [{ type: "text", text: JSON.stringify(respond(toolRequest)) }] },
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected fake Zotero server to bind a TCP port");
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, requests };
}

async function startUnavailableRpcServer(): Promise<{ endpoint: string; requests: RpcRequest[] }> {
  const requests: RpcRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    requests.push({ name: rpc.params.name, arguments: rpc.params.arguments });
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unavailable" }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected fake Zotero server to bind a TCP port");
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, requests };
}

function receiptDirectory(workspaceRoot: string): string {
  return path.join(workspaceRoot, "zotero", "receipts");
}

function successfulPreflightResponse(request: RpcRequest): Record<string, unknown> {
  if (request.name === "zotero_status") {
    return {
      ok: true,
      connected: true,
      capabilities: {
        write: { level: "create", enabled: true },
        read: { metadata: true, abstract: true, notes: true },
        list: { collectionItems: true },
      },
    };
  }
  if (request.name === "zotero_list" && request.arguments.limit === 1) {
    return {
      ok: true,
      scope: request.arguments.scope,
      type: "items",
      results: [],
      total: 0,
      hasMore: false,
    };
  }
  if (request.name === "zotero_write" && request.arguments.dryRun === true) {
    return { ok: true, dryRun: true, action: request.arguments.action };
  }
  return { ok: true };
}

describe("zotero sink CLI command", () => {
  it("creates a local-only plan with explicit omissions and no remote request or receipt", async () => {
    const fixture = await createWorkspaceFixture();

    const { envelope, stderr } = await runCommand([
      "zotero", "sink", fixture.itemId, "--extraction", fixture.extractionId, "--collection-key", "COLLECTION1",
    ]);

    expect(stderr).toBe("");
    expect(envelope).toMatchObject({
      ok: true,
      tool: "zotero_sink",
      planned: true,
      data: {
        status: "planned",
        plan: {
          omissions: expect.arrayContaining([
            expect.stringContaining("volume"),
            expect.stringContaining("were not attached to Zotero"),
          ]),
        },
      },
      diagnostics: { remoteRequests: 0, localWrites: 0 },
    });
    await expect(readdir(receiptDirectory(fixture.workspaceRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses only status, list, and dry-run RPC calls during a remote preview", async () => {
    const fixture = await createWorkspaceFixture();
    const rpc = await startRpcServer(successfulPreflightResponse);

    const { envelope, stderr } = await runCommand([
      "zotero", "sink", fixture.itemId,
      "--extraction", fixture.extractionId,
      "--collection-key", "COLLECTION1",
      "--endpoint", rpc.endpoint,
      "--preview",
    ]);

    expect(stderr).toBe("");
    expect(envelope).toMatchObject({
      ok: true,
      tool: "zotero_sink",
      planned: true,
      data: { status: "previewed", preview: { previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) } },
      diagnostics: { remoteWrites: 0 },
    });
    expect(rpc.requests).toEqual([
      { name: "zotero_status", arguments: {} },
      { name: "zotero_list", arguments: { scope: "collection:COLLECTION1", type: "items", limit: 1 } },
      expect.objectContaining({ name: "zotero_write", arguments: expect.objectContaining({ action: "create_item", dryRun: true }) }),
      expect.objectContaining({ name: "zotero_write", arguments: expect.objectContaining({ action: "create_note", dryRun: true }) }),
    ]);
    expect(rpc.requests.filter((request) => request.name === "zotero_write").every(
      (request) => request.arguments.dryRun === true,
    )).toBe(true);
    await expect(readdir(receiptDirectory(fixture.workspaceRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses incomplete status, collection, and action authority before issuing an approval digest", async () => {
    const responders: Array<(request: RpcRequest) => unknown> = [
      () => ({ ok: true }),
      (request) => request.name === "zotero_list"
        ? { ok: true, type: "items" }
        : successfulPreflightResponse(request),
      (request) => request.name === "zotero_write" && request.arguments.dryRun === true
        ? { ok: true, dryRun: true }
        : successfulPreflightResponse(request),
    ];

    for (const respond of responders) {
      const fixture = await createWorkspaceFixture();
      const rpc = await startRpcServer(respond);
      const { envelope } = await runCommand([
        "zotero", "sink", fixture.itemId,
        "--extraction", fixture.extractionId,
        "--collection-key", "COLLECTION1",
        "--endpoint", rpc.endpoint,
        "--preview",
      ]);

      expect(envelope).toMatchObject({
        ok: false,
        tool: "zotero_sink",
        errors: [expect.stringContaining("preflight authority")],
      });
      expect(rpc.requests.some((request) =>
        request.name === "zotero_write" && request.arguments.dryRun === false,
      )).toBe(false);
      await expect(readdir(receiptDirectory(fixture.workspaceRoot))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("repeats the preview, applies acknowledged item and note writes, verifies them, and records one receipt", async () => {
    const fixture = await createWorkspaceFixture();
    const rpc = await startRpcServer((request) => {
      if (request.name === "zotero_list") {
        return request.arguments.limit === 100
          ? { items: [{ key: "ITEMKEY1" }] }
          : successfulPreflightResponse(request);
      }
      if (request.name === "zotero_read") return { key: "ITEMKEY1", title: "CLI Zotero export" };
      if (request.name === "zotero_write" && request.arguments.dryRun === false) {
        return request.arguments.action === "create_item" ? { key: "ITEMKEY1" } : { key: "NOTEKEY1" };
      }
      return successfulPreflightResponse(request);
    });
    const baseArgs = [
      "zotero", "sink", fixture.itemId,
      "--extraction", fixture.extractionId,
      "--collection-key", "COLLECTION1",
      "--endpoint", rpc.endpoint,
    ];

    const preview = await runCommand([...baseArgs, "--preview"]);
    const previewDigest = preview.envelope.data.preview.previewDigest as string;
    expect(preview.envelope).toMatchObject({ ok: true, data: { status: "previewed" } });

    const applied = await runCommand([...baseArgs, "--apply", "--ack", previewDigest]);
    expect(applied.stderr).toBe("");
    expect(applied.envelope).toMatchObject({
      ok: true,
      tool: "zotero_sink",
      data: {
        status: "complete",
        receipt: {
          status: "complete",
          zoteroItemKey: "ITEMKEY1",
          zoteroNoteKey: "NOTEKEY1",
          completedPhases: ["create_item", "create_note", "verify"],
        },
      },
    });

    expect(rpc.requests.map((request) => [request.name, request.arguments.dryRun ?? null, request.arguments.limit ?? null])).toEqual([
      ["zotero_status", null, null],
      ["zotero_list", null, 1],
      ["zotero_write", true, null],
      ["zotero_write", true, null],
      ["zotero_status", null, null],
      ["zotero_list", null, 1],
      ["zotero_write", true, null],
      ["zotero_write", true, null],
      ["zotero_write", false, null],
      ["zotero_write", false, null],
      ["zotero_read", null, null],
      ["zotero_list", null, 100],
    ]);
    const receipts = await readdir(receiptDirectory(fixture.workspaceRoot));
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(await readFile(
      path.join(receiptDirectory(fixture.workspaceRoot), receipts[0]!), "utf8",
    ))).toMatchObject({ status: "complete", zoteroItemKey: "ITEMKEY1", zoteroNoteKey: "NOTEKEY1" });
  });

  it("reports unavailable endpoints as an error by default and as a configured warning without writing a receipt", async () => {
    const errorFixture = await createWorkspaceFixture();
    const unavailable = await startUnavailableRpcServer();

    const errorResult = await runCommand([
      "zotero", "sink", errorFixture.itemId, "--endpoint", unavailable.endpoint, "--preview",
    ]);
    expect(errorResult.envelope).toMatchObject({
      ok: false,
      tool: "zotero_sink",
      diagnostics: { failureKind: "zotero_unavailable", zoteroWriteOccurred: false },
    });
    expect(unavailable.requests).toEqual([{ name: "zotero_status", arguments: {} }]);
    await expect(readdir(receiptDirectory(errorFixture.workspaceRoot))).rejects.toMatchObject({ code: "ENOENT" });

    const warnFixture = await createWorkspaceFixture({ unavailable: "warn" });
    const warnResult = await runCommand([
      "zotero", "sink", warnFixture.itemId, "--endpoint", unavailable.endpoint, "--preview",
    ]);
    expect(warnResult.envelope).toMatchObject({
      ok: true,
      tool: "zotero_sink",
      data: { status: "zotero_unavailable", zoteroWriteOccurred: false },
      warnings: expect.arrayContaining([expect.stringContaining("Zotero endpoint unavailable")]),
    });
    expect(unavailable.requests).toEqual([
      { name: "zotero_status", arguments: {} },
      { name: "zotero_status", arguments: {} },
    ]);
    await expect(readdir(receiptDirectory(warnFixture.workspaceRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
