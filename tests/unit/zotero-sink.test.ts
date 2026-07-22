import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtractionRecord } from "../../src/material/extractionStore.js";
import { createArtifactRecord } from "../../src/material/artifactStore.js";
import { addResourceToWorkspace } from "../../src/workspace/store.js";
import {
  createZoteroHttpClient,
  ZoteroRemoteError,
  ZoteroUnavailableError,
  type ZoteroToolClient,
} from "../../src/zotero/client.js";
import { applyZoteroSink, planZoteroSink, previewZoteroSink } from "../../src/zotero/sink.js";
import type { ZoteroResolvedSettings, ZoteroSinkPlan } from "../../src/zotero/types.js";
import { readZoteroItemMapping, writeZoteroItemMapping } from "../../src/zotero/mapping.js";
import { syncSelectedItemToZotero } from "../../src/zotero/autoSync.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";

const roots: string[] = [];
const settings: ZoteroResolvedSettings = {
  enabled: true,
  endpoint: "http://127.0.0.1:23120/mcp",
  timeoutMs: 1_000,
  unavailable: "error",
};

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function fixturePlan() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-zotero-"));
  roots.push(workspaceRoot);
  const added = await addResourceToWorkspace(workspaceRoot, {
    item: {
      itemType: "journalArticle",
      title: "Plan <Title>",
      date: "2025-03-04",
      DOI: "10.1000/example",
      volume: "12",
      creators: [{ firstName: "Ada", lastName: "Lovelace", creatorType: "author" }],
    },
    tags: ["local"],
    defaultCollectionPath: "Inbox",
  });
  const extraction = await createExtractionRecord(workspaceRoot, {
    source: { kind: "path", path: "legacy/input.pdf" },
    backend: "fixture",
    outputs: { markdown: "First <unsafe> paragraph." },
    cacheHit: false,
    itemId: added.record.id,
  });
  const plan = await planZoteroSink({
    workspaceRoot,
    itemId: added.record.id,
    extractionId: extraction.id,
    collectionKey: "COLLECTION1",
  });
  return { workspaceRoot, plan };
}

function successfulPreflightResponse(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "zotero_status") {
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
  if (name === "zotero_list" && args.limit === 1) {
    return { ok: true, scope: args.scope, type: "items", results: [], total: 0, hasMore: false };
  }
  if (name === "zotero_write" && args.dryRun === true) {
    const params = args.params as Record<string, unknown> | undefined;
    return {
      ok: true,
      dryRun: true,
      action: args.action,
      ...(args.action === "attach_file" && params
        ? {
            preview: {
              itemKey: params.itemKey,
              filePath: params.filePath,
              mode: params.mode,
              ...(typeof params.existingAttachmentKey === "string"
                ? { existingAttachmentKey: params.existingAttachmentKey, operation: "verify_existing" }
                : { operation: "create" }),
            },
          }
        : {}),
    };
  }
  return { ok: true };
}

describe("Zotero sink safety boundary", () => {
  it("classifies an unreachable endpoint without retrying or inventing a fallback", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("connection refused"); });
    const client = createZoteroHttpClient({
      endpoint: settings.endpoint,
      timeoutMs: settings.timeoutMs,
      fetchImpl,
    });
    await expect(client.callTool("zotero_status", {})).rejects.toBeInstanceOf(ZoteroUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves structured partial-write evidence returned by Zotero MCP", async () => {
    const payload = {
      ok: false,
      code: "NOT_AVAILABLE",
      error: "attachment verification failed",
      partial: { attachmentKey: "ATTACHPARTIAL" },
    };
    const client = createZoteroHttpClient({
      endpoint: settings.endpoint,
      timeoutMs: settings.timeoutMs,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "fixture",
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      }), { status: 200, headers: { "content-type": "application/json" } })),
    });

    const error = await client.callTool("zotero_write", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ZoteroRemoteError);
    expect((error as ZoteroRemoteError).payload).toEqual(payload);
  });

  it("builds a local-only lossy plan with escaped note content and attachment omissions", async () => {
    const { plan } = await fixturePlan();
    expect(plan.actions).toEqual([
      expect.objectContaining({
        action: "create_item",
        params: expect.objectContaining({
          title: "Plan <Title>",
          year: "2025",
          doi: "10.1000/example",
          collectionKeys: ["COLLECTION1"],
        }),
      }),
      expect.objectContaining({
        action: "create_note",
        params: expect.objectContaining({
          itemKey: "$createdItemKey",
          note: expect.stringContaining("First &lt;unsafe&gt; paragraph."),
        }),
      }),
    ]);
    expect(plan.omissions).toContain("Unsupported Zotero projection field retained locally: volume");
    expect(plan.omissions.join(" ")).toContain("were not attached to Zotero");
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("previews the exact action templates with dryRun true and performs no local write", async () => {
    const { workspaceRoot, plan } = await fixturePlan();
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) =>
      successfulPreflightResponse(name, args));
    const preview = await previewZoteroSink({ plan, settings, client: { callTool } });
    expect(callTool.mock.calls).toEqual([
      ["zotero_status", {}],
      ["zotero_list", { scope: "collection:COLLECTION1", type: "items", limit: 1 }],
      ["zotero_write", { action: "create_item", params: plan.actions[0]!.params, dryRun: true }],
      ["zotero_write", { action: "create_note", params: plan.actions[1]!.params, dryRun: true }],
    ]);
    expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(readFile(path.join(workspaceRoot, "zotero", "receipts", "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("canonically binds semantic preflight authority while ignoring volatile library diagnostics", async () => {
    const { workspaceRoot, plan } = await fixturePlan();
    interface PreviewObservations {
      status: {
        ok: boolean;
        connected: boolean;
        zoteroVersion: string;
        library: { items: number; collections: number };
        capabilities: {
          write: { level: string; enabled: boolean };
          read: { metadata: boolean; abstract: boolean; notes: boolean; content: boolean };
          list: { collections: boolean; collectionItems: boolean };
        };
        config: { timeoutMs: number; defaultLimit: number };
      };
      collectionProbe: {
        ok: boolean;
        code?: string;
        scope: string;
        type: string;
        results: Array<{ key: string }>;
        total: number;
        hasMore: boolean;
      };
      actionPreviews: Array<{
        ok: boolean;
        code?: string;
        dryRun: boolean;
        action: string;
        preview: Record<string, unknown>;
      }>;
    }
    interface ClientObservations {
      status: unknown;
      collectionProbe: unknown;
      actionPreviews: unknown[];
    }
    const baselineObservations: PreviewObservations = {
      status: {
        ok: true,
        connected: true,
        zoteroVersion: "7.0.15",
        library: { items: 10, collections: 2 },
        capabilities: {
          write: { level: "create", enabled: true },
          read: { metadata: true, abstract: true, notes: true, content: true },
          list: { collections: true, collectionItems: true },
        },
        config: { timeoutMs: 10_000, defaultLimit: 20 },
      },
      collectionProbe: {
        ok: true,
        scope: "collection:COLLECTION1",
        type: "items",
        results: [{ key: "EXISTING" }],
        total: 1,
        hasMore: false,
      },
      actionPreviews: [
        {
          ok: true,
          dryRun: true,
          action: "create_item",
          preview: { itemType: "journalArticle", title: "Plan <Title>" },
        },
        {
          ok: true,
          dryRun: true,
          action: "create_note",
          preview: { parentKey: "$createdItemKey", noteLength: 115 },
        },
      ],
    };
    function clientFor(observations: ClientObservations, onWrite?: () => void): ZoteroToolClient {
      let dryRunIndex = 0;
      return {
        async callTool(name, args) {
          if (name === "zotero_status") return observations.status;
          if (name === "zotero_list" && args.limit === 1) return observations.collectionProbe;
          if (name === "zotero_list" && args.limit === 100) {
            return { ok: true, scope: "collection:COLLECTION1", type: "items", results: [{ key: "ITEMKEY1" }] };
          }
          if (name === "zotero_read") return { ok: true, key: "ITEMKEY1" };
          if (name === "zotero_write" && args.dryRun === true) {
            return observations.actionPreviews[dryRunIndex++];
          }
          if (name === "zotero_write" && args.dryRun === false) {
            onWrite?.();
            return { ok: true, key: args.action === "create_item" ? "ITEMKEY1" : "NOTEKEY1" };
          }
          return { ok: true };
        },
      };
    }

    const baseline = await previewZoteroSink({
      plan,
      settings,
      client: clientFor(baselineObservations),
    });
    const reordered = await previewZoteroSink({
      plan,
      settings,
      client: clientFor({
        status: {
          config: { defaultLimit: 99, timeoutMs: 25_000 },
          capabilities: {
            list: { collectionItems: true, collections: false },
            read: { content: false, notes: true, abstract: true, metadata: true },
            write: { enabled: true, level: "create" },
          },
          library: { collections: 50, items: 9999 },
          zoteroVersion: "7.0.99",
          connected: true,
          ok: true,
        },
        collectionProbe: {
          hasMore: true,
          total: 999,
          results: [{ key: "DIFFERENT_LIBRARY_ITEM" }],
          type: "items",
          scope: "collection:COLLECTION1",
          ok: true,
        },
        actionPreviews: [
          {
            preview: { title: "Plan <Title>", itemType: "journalArticle", incidental: "changed" },
            action: "create_item",
            dryRun: true,
            ok: true,
          },
          {
            preview: { noteLength: 999, parentKey: "$createdItemKey" },
            action: "create_note",
            dryRun: true,
            ok: true,
          },
        ],
      }),
    });
    expect(reordered.previewDigest).toBe(baseline.previewDigest);

    const invalidObservations: ClientObservations[] = [
      {
        ...baselineObservations,
        status: {
          ok: true,
          capabilities: baselineObservations.status.capabilities,
        },
      },
      {
        ...baselineObservations,
        status: { ...baselineObservations.status, connected: false },
      },
      {
        ...baselineObservations,
        status: {
          ...baselineObservations.status,
          capabilities: {
            ...baselineObservations.status.capabilities,
            write: { ...baselineObservations.status.capabilities.write, enabled: false },
          },
        },
      },
      {
        ...baselineObservations,
        status: {
          ...baselineObservations.status,
          capabilities: {
            ...baselineObservations.status.capabilities,
            read: { ...baselineObservations.status.capabilities.read, metadata: false },
          },
        },
      },
      {
        ...baselineObservations,
        status: {
          ...baselineObservations.status,
          capabilities: {
            ...baselineObservations.status.capabilities,
            read: { ...baselineObservations.status.capabilities.read, notes: false },
          },
        },
      },
      {
        ...baselineObservations,
        status: {
          ...baselineObservations.status,
          capabilities: {
            ...baselineObservations.status.capabilities,
            list: { ...baselineObservations.status.capabilities.list, collectionItems: false },
          },
        },
      },
      {
        ...baselineObservations,
        collectionProbe: {
          ...baselineObservations.collectionProbe,
          ok: false,
          code: "NOT_FOUND",
          scope: "collection:OTHER",
        },
      },
      {
        ...baselineObservations,
        collectionProbe: { ok: true, type: "items" },
      },
      {
        ...baselineObservations,
        actionPreviews: [
          { ok: false, code: "NOT_AVAILABLE", dryRun: true, action: "create_item", preview: {} },
          baselineObservations.actionPreviews[1]!,
        ],
      },
      {
        ...baselineObservations,
        actionPreviews: [
          { ok: true, action: "create_item", preview: {} },
          baselineObservations.actionPreviews[1]!,
        ],
      },
    ];
    for (const observations of invalidObservations) {
      await expect(previewZoteroSink({
        plan,
        settings,
        client: clientFor(observations),
      })).rejects.toThrow("preflight authority");
      let writeCount = 0;
      await expect(applyZoteroSink({
        plan,
        settings,
        acknowledgedPreviewDigest: baseline.previewDigest,
        client: clientFor(observations, () => { writeCount += 1; }),
      })).rejects.toThrow("preflight authority");
      expect(writeCount).toBe(0);
    }

    const changedCapability = await previewZoteroSink({
      plan,
      settings,
      client: clientFor({
        ...baselineObservations,
        status: {
          ...baselineObservations.status,
          capabilities: {
            ...baselineObservations.status.capabilities,
            write: { ...baselineObservations.status.capabilities.write, level: "full" },
          },
        },
      }),
    });
    expect(changedCapability.previewDigest).not.toBe(baseline.previewDigest);

    const changedOutcomeCode = await previewZoteroSink({
      plan,
      settings,
      client: clientFor({
        ...baselineObservations,
        actionPreviews: [
          { ...baselineObservations.actionPreviews[0]!, code: "OK" },
          baselineObservations.actionPreviews[1]!,
        ],
      }),
    });
    expect(changedOutcomeCode.previewDigest).not.toBe(baseline.previewDigest);

    const differentEndpoint = await previewZoteroSink({
      plan,
      settings: { ...settings, endpoint: "http://127.0.0.1:23121/mcp" },
      client: clientFor(baselineObservations),
    });
    expect(differentEndpoint.previewDigest).not.toBe(baseline.previewDigest);

    const actionChangedPlan = await planZoteroSink({
      workspaceRoot,
      itemId: plan.itemId,
      extractionId: plan.extractionId,
      collectionKey: "COLLECTION1",
      markdownMode: "none",
    });
    const actionChanged = await previewZoteroSink({
      plan: actionChangedPlan,
      settings,
      client: clientFor(baselineObservations),
    });
    expect(actionChanged.previewDigest).not.toBe(baseline.previewDigest);

    const collectionChangedPlan = await planZoteroSink({
      workspaceRoot,
      itemId: plan.itemId,
      extractionId: plan.extractionId,
      collectionKey: "COLLECTION2",
    });
    const collectionChanged = await previewZoteroSink({
      plan: collectionChangedPlan,
      settings,
      client: clientFor({
        ...baselineObservations,
        collectionProbe: { ...baselineObservations.collectionProbe, scope: "collection:COLLECTION2" },
      }),
    });
    expect(collectionChanged.previewDigest).not.toBe(baseline.previewDigest);

    let writeCount = 0;
    const applied = await applyZoteroSink({
      plan,
      settings,
      acknowledgedPreviewDigest: baseline.previewDigest,
      client: clientFor({
        ...baselineObservations,
        status: {
          ...baselineObservations.status,
          library: { ...baselineObservations.status.library, items: 11 },
        },
      }, () => { writeCount += 1; }),
    });
    expect(applied.receipt.status).toBe("complete");
    expect(writeCount).toBe(2);
  });

  it("requires the preview digest and preserves the returned item key on partial note failure", async () => {
    const { workspaceRoot, plan } = await fixturePlan();
    const previewClient: ZoteroToolClient = {
      callTool: async (name, args) => successfulPreflightResponse(name, args),
    };
    const preview = await previewZoteroSink({ plan, settings, client: previewClient });
    const calls: Array<[string, Record<string, unknown>]> = [];
    let realWriteCount = 0;
    const client: ZoteroToolClient = {
      async callTool(name, args) {
        calls.push([name, args]);
        if (name === "zotero_write" && args.dryRun === false) {
          realWriteCount += 1;
          if (realWriteCount === 1) return { ok: true, key: "ITEMKEY1" };
          throw new Error("note rejected");
        }
        return successfulPreflightResponse(name, args);
      },
    };
    await expect(applyZoteroSink({
      plan,
      settings,
      acknowledgedPreviewDigest: "0".repeat(64),
      client,
    })).rejects.toThrow("does not match");
    expect(realWriteCount).toBe(0);

    const applied = await applyZoteroSink({
      plan,
      settings,
      acknowledgedPreviewDigest: preview.previewDigest,
      client,
    });
    expect(applied.receipt).toMatchObject({
      status: "partial",
      zoteroItemKey: "ITEMKEY1",
      failedPhase: "create_note",
      completedPhases: ["create_item"],
    });
    expect(calls.some(([name, args]) => name === "zotero_write" && args.action === "trash")).toBe(false);
    await expect(readFile(applied.receiptPath!, "utf8")).resolves.toContain('"zoteroItemKey": "ITEMKEY1"');
    expect(path.dirname(applied.receiptPath!)).toBe(path.join(workspaceRoot, "zotero", "receipts"));
  });

  it("verifies the returned item and explicit collection before writing a complete receipt", async () => {
    const { plan } = await fixturePlan();
    const preview = await previewZoteroSink({
      plan,
      settings,
      client: { callTool: async (name, args) => successfulPreflightResponse(name, args) },
    });
    let realWrites = 0;
    const applied = await applyZoteroSink({
      plan,
      settings,
      acknowledgedPreviewDigest: preview.previewDigest,
      client: {
        async callTool(name, args) {
          if (name === "zotero_write" && args.dryRun === false) {
            realWrites += 1;
            return { ok: true, key: realWrites === 1 ? "ITEMKEY2" : "NOTEKEY2" };
          }
          if (name === "zotero_read") return { key: "ITEMKEY2", title: "Plan <Title>" };
          if (name === "zotero_list" && args.limit === 100) return { items: [{ key: "ITEMKEY2" }] };
          return successfulPreflightResponse(name, args);
        },
      },
    });
    expect(applied.receipt).toMatchObject({
      status: "complete",
      zoteroItemKey: "ITEMKEY2",
      zoteroNoteKey: "NOTEKEY2",
      completedPhases: ["create_item", "create_note", "verify"],
    });
  });

  it("attaches a local artifact after item creation and reuses the durable mapping", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-zotero-attachment-"));
    roots.push(workspaceRoot);
    const added = await addResourceToWorkspace(workspaceRoot, {
      item: { itemType: "journalArticle", title: "Attachment plan" },
      defaultCollectionPath: "Inbox",
    });
    const files = path.join(workspaceRoot, "files");
    await mkdir(files, { recursive: true });
    await writeFile(path.join(files, "paper.pdf"), "pdf bytes", "utf8");
    const artifact = await createArtifactRecord(workspaceRoot, {
      kind: "pdf",
      status: "downloaded",
      itemId: added.record.id,
      filename: "paper.pdf",
      contentType: "application/pdf",
      path: "files/paper.pdf",
      provenance: { origin: "download", providerId: "fixture" },
      attempts: [{ tier: "fixture", ok: true, at: new Date().toISOString() }],
    });
    const plan = await planZoteroSink({
      workspaceRoot,
      itemId: added.record.id,
      collectionKeys: ["COLLECTION1", "SHARED2"],
      attachmentMode: "link",
      markdownMode: "none",
    });
    expect(plan.actions).toEqual([
      expect.objectContaining({ action: "create_item" }),
      expect.objectContaining({
        action: "attach_file",
        sourceRef: `artifact:${artifact.id}`,
        params: expect.objectContaining({
          itemKey: "$createdItemKey",
          filePath: path.join(files, "paper.pdf"),
          mode: "link",
        }),
      }),
    ]);

    const calls: Array<[string, Record<string, unknown>]> = [];
    const client: ZoteroToolClient = {
      async callTool(name, args) {
        calls.push([name, args]);
        if (name === "zotero_write" && args.dryRun === false) {
          return args.action === "create_item"
            ? { key: "ITEMATTACH1" }
            : { itemKey: "ITEMATTACH1", attachmentKey: "ATTACH1", verified: true };
        }
        if (name === "zotero_read") return { key: "ITEMATTACH1" };
        if (name === "zotero_list" && args.limit === 100) return { items: [{ key: "ITEMATTACH1" }] };
        return successfulPreflightResponse(name, args);
      },
    };
    const preview = await previewZoteroSink({ plan, settings, client });
    expect(calls.filter(([name, args]) =>
      name === "zotero_write" && args.action === "attach_file" && args.dryRun === true,
    )).toHaveLength(0);
    const applied = await applyZoteroSink({
      plan,
      settings,
      acknowledgedPreviewDigest: preview.previewDigest,
      client,
    });
    expect(applied.receipt).toMatchObject({
      status: "complete",
      zoteroItemKey: "ITEMATTACH1",
      zoteroAttachmentKeys: ["ATTACH1"],
      collectionKeys: ["COLLECTION1", "SHARED2"],
    });
    expect(calls).toContainEqual([
      "zotero_write",
      expect.objectContaining({
        action: "attach_file",
        dryRun: true,
        params: expect.objectContaining({ itemKey: "ITEMATTACH1" }),
      }),
    ]);
    await expect(readZoteroItemMapping(workspaceRoot, added.record.id)).resolves.toMatchObject({
      zoteroItemKey: "ITEMATTACH1",
      attachments: {
        [`artifact:${artifact.id}`]: {
          zoteroAttachmentKey: "ATTACH1",
          mode: "link",
          verified: true,
        },
      },
    });

    const repeat = await planZoteroSink({
      workspaceRoot,
      itemId: added.record.id,
      collectionKeys: ["COLLECTION1", "SHARED2"],
      attachmentMode: "link",
      markdownMode: "none",
    });
    expect(repeat.existingZoteroItemKey).toBe("ITEMATTACH1");
    expect(repeat.actions.map((action) => action.action)).toEqual([
      "update_item",
      "add_to_collection",
      "add_to_collection",
    ]);
  });

  it("records a partial item and skips the attachment write when its resolved dry-run is invalid", async () => {
    const invalidResolvedPreviews = [
      { ok: false, code: "NOT_AVAILABLE", dryRun: true, action: "attach_file" },
      { ok: true, dryRun: false, action: "attach_file" },
      { ok: true, dryRun: true, action: "create_item" },
      {
        ok: true,
        dryRun: true,
        action: "attach_file",
        preview: { itemKey: "OTHER", filePath: "other.pdf", mode: "link", operation: "create" },
      },
    ];

    for (const [index, invalidResolvedPreview] of invalidResolvedPreviews.entries()) {
      const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-zotero-deferred-"));
      roots.push(workspaceRoot);
      const itemId = `deferred-item-${index}`;
      const itemKey = `DEFERRED${index}`;
      const plan: ZoteroSinkPlan = {
        schemaVersion: 1,
        workspaceRoot,
        itemId,
        collectionKeys: [],
        actions: [
          { action: "create_item", params: { itemType: "journalArticle", title: "Deferred attachment" } },
          {
            action: "attach_file",
            sourceRef: `artifact:deferred-${index}`,
            params: {
              itemKey: "$createdItemKey",
              filePath: path.join(workspaceRoot, "paper.pdf"),
              mode: "link",
            },
          },
        ],
        omissions: [],
        planDigest: String(index).repeat(64),
      };
      const realWriteActions: string[] = [];
      const client: ZoteroToolClient = {
        async callTool(name, args) {
          if (name === "zotero_write" && args.dryRun === false) {
            realWriteActions.push(String(args.action));
            return args.action === "create_item"
              ? { ok: true, itemKey }
              : { ok: true, attachmentKey: `ATTACH${index}` };
          }
          if (
            name === "zotero_write"
            && args.dryRun === true
            && args.action === "attach_file"
            && (args.params as Record<string, unknown>).itemKey === itemKey
          ) {
            return invalidResolvedPreview;
          }
          return successfulPreflightResponse(name, args);
        },
      };
      const preview = await previewZoteroSink({ plan, settings, client });
      const applied = await applyZoteroSink({
        plan,
        settings,
        acknowledgedPreviewDigest: preview.previewDigest,
        client,
      });

      expect(applied.receipt).toMatchObject({
        status: "partial",
        zoteroItemKey: itemKey,
        completedPhases: ["create_item"],
        failedPhase: "attach_file_preflight",
      });
      expect(applied.receipt.zoteroAttachmentKeys).toBeUndefined();
      expect(realWriteActions).toEqual(["create_item"]);
      await expect(readZoteroItemMapping(workspaceRoot, itemId)).resolves.toMatchObject({
        zoteroItemKey: itemKey,
        attachments: {},
      });
    }
  });

  it("records an unverified attachment key and prevents duplicate retry after post-write failure", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-zotero-attachment-partial-"));
    roots.push(workspaceRoot);
    const added = await addResourceToWorkspace(workspaceRoot, {
      item: { itemType: "journalArticle", title: "Partial attachment" },
      defaultCollectionPath: "Inbox",
    });
    const files = path.join(workspaceRoot, "files");
    await mkdir(files, { recursive: true });
    await writeFile(path.join(files, "paper.pdf"), "pdf bytes", "utf8");
    const artifact = await createArtifactRecord(workspaceRoot, {
      kind: "pdf",
      status: "downloaded",
      itemId: added.record.id,
      filename: "paper.pdf",
      contentType: "application/pdf",
      path: "files/paper.pdf",
      provenance: { origin: "download", providerId: "fixture" },
      attempts: [{ tier: "fixture", ok: true, at: new Date().toISOString() }],
    });
    const plan = await planZoteroSink({
      workspaceRoot,
      itemId: added.record.id,
      attachmentMode: "link",
      markdownMode: "none",
    });
    const client: ZoteroToolClient = {
      async callTool(name, args) {
        if (name === "zotero_write" && args.dryRun === false) {
          if (args.action === "create_item") return { itemKey: "ITEMPARTIAL" };
          throw new ZoteroRemoteError("attachment verification failed", {
            ok: false,
            partial: { attachmentKey: "ATTACHPARTIAL" },
          });
        }
        return successfulPreflightResponse(name, args);
      },
    };
    const preview = await previewZoteroSink({ plan, settings, client });
    const applied = await applyZoteroSink({
      plan,
      settings,
      acknowledgedPreviewDigest: preview.previewDigest,
      client,
    });

    expect(applied.receipt).toMatchObject({
      status: "partial",
      zoteroItemKey: "ITEMPARTIAL",
      zoteroAttachmentKeys: ["ATTACHPARTIAL"],
      completedPhases: ["create_item", "attach_file_write"],
      failedPhase: "attach_file_verification",
    });
    await expect(readZoteroItemMapping(workspaceRoot, added.record.id)).resolves.toMatchObject({
      attachments: {
        [`artifact:${artifact.id}`]: {
          zoteroAttachmentKey: "ATTACHPARTIAL",
          mode: "link",
          verified: false,
        },
      },
    });
    const repeat = await planZoteroSink({
      workspaceRoot,
      itemId: added.record.id,
      attachmentMode: "link",
      markdownMode: "none",
    });
    expect(repeat.actions.map((action) => action.action)).toEqual([
      "update_item",
      "attach_file",
    ]);
    expect(repeat.actions[1]?.params).toMatchObject({
      existingAttachmentKey: "ATTACHPARTIAL",
      mode: "link",
    });

    const retryClient: ZoteroToolClient = {
      async callTool(name, args) {
        if (name === "zotero_write" && args.dryRun === false) {
          if (args.action === "update_item") return { itemKey: "ITEMPARTIAL" };
          if (args.action === "attach_file") {
            expect(args.params).toMatchObject({ existingAttachmentKey: "ATTACHPARTIAL" });
            return { attachmentKey: "ATTACHPARTIAL", verified: true, reverified: true };
          }
        }
        if (name === "zotero_read") return { ok: true, key: "ITEMPARTIAL" };
        return successfulPreflightResponse(name, args);
      },
    };
    const retryPreview = await previewZoteroSink({ plan: repeat, settings, client: retryClient });
    const retried = await applyZoteroSink({
      plan: repeat,
      settings,
      acknowledgedPreviewDigest: retryPreview.previewDigest,
      client: retryClient,
    });
    expect(retried.receipt).toMatchObject({
      status: "complete",
      zoteroItemKey: "ITEMPARTIAL",
      zoteroAttachmentKeys: ["ATTACHPARTIAL"],
    });
    await expect(readZoteroItemMapping(workspaceRoot, added.record.id)).resolves.toMatchObject({
      attachments: {
        [`artifact:${artifact.id}`]: {
          zoteroAttachmentKey: "ATTACHPARTIAL",
          verified: true,
        },
      },
    });
  });

  it("recovers a remote item from a mapping-failure receipt before planning another create", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-zotero-recovery-"));
    roots.push(workspaceRoot);
    const added = await addResourceToWorkspace(workspaceRoot, {
      item: { itemType: "journalArticle", title: "Recovered remote item" },
      defaultCollectionPath: "Inbox",
    });
    const receiptsRoot = path.join(workspaceRoot, "zotero", "receipts");
    await mkdir(receiptsRoot, { recursive: true });
    await writeFile(path.join(receiptsRoot, "mapping-failure.json"), `${JSON.stringify({
      schemaVersion: 1,
      receiptId: "mapping-failure",
      createdAt: new Date().toISOString(),
      status: "partial",
      itemId: added.record.id,
      zoteroItemKey: "RECOVERED1",
      failedPhase: "mapping",
      mappingRecovery: {
        schemaVersion: 1,
        itemId: added.record.id,
        zoteroItemKey: "RECOVERED1",
        noteKeys: {},
        attachments: {},
        updatedAt: new Date().toISOString(),
      },
    }, null, 2)}\n`, "utf8");

    const plan = await planZoteroSink({
      workspaceRoot,
      itemId: added.record.id,
      markdownMode: "none",
    });
    expect(plan.existingZoteroItemKey).toBe("RECOVERED1");
    expect(plan.actions.map((action) => action.action)).toEqual(["update_item"]);

    const client: ZoteroToolClient = {
      async callTool(name, args) {
        if (name === "zotero_write" && args.dryRun === false) {
          return { itemKey: "RECOVERED1" };
        }
        if (name === "zotero_read") return { ok: true, key: "RECOVERED1" };
        return successfulPreflightResponse(name, args);
      },
    };
    const preview = await previewZoteroSink({ plan, settings, client });
    const applied = await applyZoteroSink({
      plan,
      settings,
      acknowledgedPreviewDigest: preview.previewDigest,
      client,
    });
    expect(applied.receipt.status).toBe("complete");
    await expect(readZoteroItemMapping(workspaceRoot, added.record.id)).resolves.toMatchObject({
      zoteroItemKey: "RECOVERED1",
    });
  });

  it("rejects a stale create plan before any remote call when a mapping appeared concurrently", async () => {
    const { workspaceRoot, plan } = await fixturePlan();
    const previewClient: ZoteroToolClient = {
      callTool: async (name, args) => successfulPreflightResponse(name, args),
    };
    const preview = await previewZoteroSink({ plan, settings, client: previewClient });
    await writeZoteroItemMapping(workspaceRoot, {
      schemaVersion: 1,
      itemId: plan.itemId,
      zoteroItemKey: "CONCURRENT1",
      noteKeys: {},
      attachments: {},
      updatedAt: new Date().toISOString(),
    });
    const callTool = vi.fn(async () => ({ ok: true }));

    await expect(applyZoteroSink({
      plan,
      settings,
      acknowledgedPreviewDigest: preview.previewDigest,
      client: { callTool },
    })).rejects.toThrow("Stale Zotero create plan");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("records a pending receipt for a bound workspace without a configured Zotero host", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-zotero-pending-"));
    roots.push(workspaceRoot);
    const added = await addResourceToWorkspace(workspaceRoot, {
      item: { itemType: "journalArticle", title: "Pending projection" },
      defaultCollectionPath: "Inbox",
    });
    const config = {
      ...DEFAULT_CONFIG,
      workspace: { ...DEFAULT_CONFIG.workspace, root: workspaceRoot },
      zoteroBinding: { mode: "bound" as const, collectionKeys: ["COLLECTION1"] },
      meta: null as never,
    } satisfies ResolvedConfig;
    await expect(syncSelectedItemToZotero({
      config,
      itemId: added.record.id,
    })).resolves.toEqual({ status: "pending", reason: "zotero_not_configured" });
    const receipts = await readdir(path.join(workspaceRoot, "zotero", "receipts"));
    expect(receipts).toHaveLength(1);
    await expect(readFile(path.join(workspaceRoot, "zotero", "receipts", receipts[0]!), "utf8"))
      .resolves.toContain('"status": "pending"');

    const offConfig = { ...config, zoteroBinding: { mode: "off" as const } };
    await expect(syncSelectedItemToZotero({
      config: offConfig,
      itemId: added.record.id,
    })).resolves.toEqual({ status: "not_requested" });
    await expect(readdir(path.join(workspaceRoot, "zotero", "receipts"))).resolves.toHaveLength(1);
  });
});
