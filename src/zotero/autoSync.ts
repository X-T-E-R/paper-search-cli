import type { ResolvedConfig } from "../config/schema.js";
import { resolveZoteroSelectionBinding } from "./binding.js";
import { createZoteroHttpClient } from "./client.js";
import {
  applyZoteroSink,
  findZoteroProjectionReceipt,
  planZoteroSink,
  previewZoteroSink,
  recordPendingZoteroSink,
} from "./sink.js";
import type { ZoteroProjectionCorrelation } from "./types.js";

export type ZoteroAutoSyncStatus = "not_requested" | "pending" | "partial" | "complete";

export interface ZoteroAutoSyncResult {
  status: ZoteroAutoSyncStatus;
  reason?: string;
}

async function pending(options: {
  config: ResolvedConfig;
  itemId: string;
  extractionId?: string;
  reason: string;
  plan?: Awaited<ReturnType<typeof planZoteroSink>>;
}): Promise<ZoteroAutoSyncResult> {
  try {
    await recordPendingZoteroSink({
      workspaceRoot: options.config.workspace.root,
      itemId: options.itemId,
      extractionId: options.extractionId,
      reason: options.reason,
      plan: options.plan,
    });
  } catch {
    return { status: "pending", reason: `${options.reason}; receipt_write_failed` };
  }
  return { status: "pending", reason: options.reason };
}

/**
 * Run the durably configured selection projection. Remote or receipt failures
 * never roll back the authoritative local workspace selection/material files.
 */
export async function syncSelectedItemToZotero(options: {
  config: ResolvedConfig;
  itemId: string;
  extractionId?: string;
  /** Exact host-owned identity for caller crash-window reconciliation. */
  projectionCorrelation?: ZoteroProjectionCorrelation;
}): Promise<ZoteroAutoSyncResult> {
  const binding = resolveZoteroSelectionBinding(options.config);
  if (!binding.requested) return { status: "not_requested" };
  if (options.projectionCorrelation) {
    const recovered = await findZoteroProjectionReceipt(
      options.config.workspace.root,
      options.projectionCorrelation,
    );
    if (recovered) {
      return recovered.status === "pending"
        ? { status: "pending", ...(recovered.pendingReason ? { reason: recovered.pendingReason } : {}) }
        : { status: recovered.status };
    }
  }

  let plan: Awaited<ReturnType<typeof planZoteroSink>>;
  try {
    plan = await planZoteroSink({
      workspaceRoot: options.config.workspace.root,
      itemId: options.itemId,
      extractionId: options.extractionId,
      collectionKeys: binding.collectionKeys,
      attachmentMode: binding.attachmentMode,
      markdownMode: binding.markdownMode,
      projectionCorrelation: options.projectionCorrelation,
    });
  } catch (error) {
    return pending({
      ...options,
      reason: `plan_failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (!options.config.zotero.enabled) {
    return pending({ ...options, plan, reason: "zotero_not_configured" });
  }

  const settings = {
    enabled: true,
    endpoint: options.config.zotero.endpoint,
    timeoutMs: options.config.zotero.timeoutMs,
    unavailable: options.config.zotero.unavailable,
  } as const;
  const client = createZoteroHttpClient(settings);
  try {
    const preview = await previewZoteroSink({ plan, settings, client });
    const applied = await applyZoteroSink({
      plan,
      settings,
      acknowledgedPreviewDigest: preview.previewDigest,
      client,
    });
    return { status: applied.receipt.status === "complete" ? "complete" : "partial" };
  } catch (error) {
    return pending({
      ...options,
      plan,
      reason: `sync_failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
