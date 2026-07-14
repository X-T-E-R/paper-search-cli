import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtractionRecord } from "../../src/material/extractionStore.js";
import { addResourceToWorkspace } from "../../src/workspace/store.js";
import { createZoteroHttpClient, ZoteroUnavailableError, type ZoteroToolClient } from "../../src/zotero/client.js";
import { applyZoteroSink, planZoteroSink, previewZoteroSink } from "../../src/zotero/sink.js";
import type { ZoteroResolvedSettings } from "../../src/zotero/types.js";

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
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({ name, args, ok: true }));
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

  it("canonically binds readiness, collection probe, and exact dry-run responses before any write", async () => {
    const { plan } = await fixturePlan();
    const baselineObservations = {
      status: { ready: true, version: "1.2.3" },
      collectionProbe: { items: [{ key: "EXISTING" }], total: 1 },
      actionPreviews: [
        { ok: true, normalized: { itemType: "journalArticle", title: "Plan <Title>" } },
        { ok: true, normalized: { itemKey: "$createdItemKey", noteLength: 115 } },
      ],
    };
    function clientFor(observations: typeof baselineObservations, onWrite?: () => void): ZoteroToolClient {
      let dryRunIndex = 0;
      return {
        async callTool(name, args) {
          if (name === "zotero_status") return observations.status;
          if (name === "zotero_list" && args.limit === 1) return observations.collectionProbe;
          if (name === "zotero_write" && args.dryRun === true) {
            return observations.actionPreviews[dryRunIndex++];
          }
          if (name === "zotero_write" && args.dryRun === false) {
            onWrite?.();
            return { ok: true, key: "UNEXPECTED_WRITE" };
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
        status: { version: "1.2.3", ready: true },
        collectionProbe: { total: 1, items: [{ key: "EXISTING" }] },
        actionPreviews: [
          { normalized: { title: "Plan <Title>", itemType: "journalArticle" }, ok: true },
          { normalized: { noteLength: 115, itemKey: "$createdItemKey" }, ok: true },
        ],
      }),
    });
    expect(reordered.previewDigest).toBe(baseline.previewDigest);

    const changedObservations = [
      {
        ...baselineObservations,
        status: { ready: false, version: "1.2.3" },
      },
      {
        ...baselineObservations,
        collectionProbe: { items: [], total: 0 },
      },
      {
        ...baselineObservations,
        actionPreviews: [
          { ok: false, normalized: { itemType: "journalArticle", title: "Plan <Title>" } },
          baselineObservations.actionPreviews[1]!,
        ],
      },
    ];
    for (const observations of changedObservations) {
      const changed = await previewZoteroSink({ plan, settings, client: clientFor(observations) });
      expect(changed.previewDigest).not.toBe(baseline.previewDigest);

      let writeCount = 0;
      await expect(applyZoteroSink({
        plan,
        settings,
        acknowledgedPreviewDigest: baseline.previewDigest,
        client: clientFor(observations, () => { writeCount += 1; }),
      })).rejects.toThrow("does not match");
      expect(writeCount).toBe(0);
    }
  });

  it("requires the preview digest and preserves the returned item key on partial note failure", async () => {
    const { workspaceRoot, plan } = await fixturePlan();
    const previewClient: ZoteroToolClient = { callTool: async () => ({ ok: true }) };
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
        return { ok: true };
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
    const preview = await previewZoteroSink({ plan, settings, client: { callTool: async () => ({ ok: true }) } });
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
          return { ok: true };
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
});
