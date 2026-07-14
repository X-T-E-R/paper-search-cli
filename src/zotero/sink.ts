import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readExtractionRecord, resolveExtractionOutputPath } from "../material/extractionStore.js";
import { readArtifactRecord } from "../material/artifactStore.js";
import type { ExtractionRecord } from "../material/records.js";
import { readWorkspaceItemRecord, type WorkspaceItemRecord } from "../workspace/store.js";
import type { ZoteroToolClient } from "./client.js";
import { ZoteroUnavailableError } from "./client.js";
import type {
  ZoteroResolvedSettings,
  ZoteroSinkPlan,
  ZoteroSinkPreview,
  ZoteroSinkReceipt,
  ZoteroWriteAction,
} from "./types.js";

const RECEIPTS_DIR = "zotero/receipts";
const CREATED_ITEM_PLACEHOLDER = "$createdItemKey";

export class ZoteroSinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoteroSinkError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ZoteroSinkError("Zotero preview authority contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new ZoteroSinkError(`Zotero preview authority contains a non-JSON ${typeof value} value`);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderNote(markdown: string, extraction: ExtractionRecord): string {
  const body = markdown
    .split(/\r?\n\r?\n/gu)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll(/\r?\n/gu, "<br>")}</p>`)
    .join("");
  return `<p><strong>Paper Search extraction ${escapeHtml(extraction.id)}</strong></p>${body}`;
}

async function extractionMarkdown(workspaceRoot: string, extraction: ExtractionRecord): Promise<string> {
  if (typeof extraction.outputs.markdown === "string") return extraction.outputs.markdown;
  const outputPath = await resolveExtractionOutputPath(workspaceRoot, extraction, "markdown");
  if (outputPath) return readFile(outputPath, "utf8");
  throw new ZoteroSinkError(`Extraction ${extraction.id} has no Markdown output`);
}

function supportedItemProjection(item: WorkspaceItemRecord, collectionKey?: string): Record<string, unknown> {
  const year = item.item.date?.match(/\b\d{4}\b/u)?.[0];
  const tags = [...new Set([...(item.item.tags ?? []).map((entry) => entry.tag), ...item.tags])];
  return {
    itemType: item.item.itemType,
    title: item.item.title,
    ...(year ? { year } : {}),
    ...(item.item.DOI ? { doi: item.item.DOI } : {}),
    ...(item.item.abstractNote ? { abstractNote: item.item.abstractNote } : {}),
    ...(item.item.publicationTitle ? { publicationTitle: item.item.publicationTitle } : {}),
    ...(item.item.url ?? item.url ? { url: item.item.url ?? item.url } : {}),
    ...(item.item.creators ? { creators: item.item.creators } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(collectionKey ? { collectionKeys: [collectionKey] } : {}),
  };
}

function projectionOmissions(item: WorkspaceItemRecord, extraction?: ExtractionRecord): string[] {
  const unsupported = [
    "volume", "issue", "pages", "ISSN", "ISBN", "language", "accessDate", "rights", "extra",
    "country", "assignee", "issuingAuthority", "patentNumber", "applicationNumber", "priorityNumbers",
    "filingDate", "issueDate", "legalStatus", "references", "sourceId", "source", "relevanceScore", "citationCount",
  ].filter((key) => item.item[key as keyof typeof item.item] !== undefined);
  const omissions = [
    "Zotero attachment import is unsupported; no local PDF, Markdown, JSON, or asset files will be attached",
    ...unsupported.map((field) => `Unsupported Zotero projection field retained locally: ${field}`),
  ];
  if (item.detail !== undefined) omissions.push("Workspace detail payload retained locally");
  if ((item.attachments ?? []).length > 0) omissions.push("Local PDF/artifact files were not attached to Zotero");
  if (extraction) omissions.push("Local Markdown/JSON/assets were not attached to Zotero; selected Markdown was rendered as a note");
  return omissions;
}

export async function planZoteroSink(options: {
  workspaceRoot: string;
  itemId: string;
  extractionId?: string;
  collectionKey?: string;
}): Promise<ZoteroSinkPlan> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const item = await readWorkspaceItemRecord(workspaceRoot, options.itemId);
  if (!item) throw new ZoteroSinkError(`Workspace item not found: ${options.itemId}`);
  const extraction = options.extractionId
    ? await readExtractionRecord(workspaceRoot, options.extractionId)
    : null;
  if (options.extractionId && !extraction) throw new ZoteroSinkError(`Extraction not found: ${options.extractionId}`);
  if (extraction?.itemId && extraction.itemId !== item.id) {
    throw new ZoteroSinkError(`Extraction ${extraction.id} belongs to a different workspace item`);
  }
  if (extraction && !extraction.itemId && extraction.source.kind === "artifact" && extraction.source.artifactId) {
    const artifact = await readArtifactRecord(workspaceRoot, extraction.source.artifactId);
    if (artifact?.itemId && artifact.itemId !== item.id) {
      throw new ZoteroSinkError(`Extraction ${extraction.id} derives from an artifact owned by a different workspace item`);
    }
  }
  const collectionKey = options.collectionKey?.trim() || undefined;
  if (collectionKey && !/^[A-Za-z0-9]+$/u.test(collectionKey)) {
    throw new ZoteroSinkError("Zotero collection key must contain only letters and digits");
  }
  const actions: ZoteroWriteAction[] = [
    { action: "create_item", params: supportedItemProjection(item, collectionKey) },
  ];
  if (extraction) {
    actions.push({
      action: "create_note",
      params: {
        itemKey: CREATED_ITEM_PLACEHOLDER,
        note: renderNote(await extractionMarkdown(workspaceRoot, extraction), extraction),
      },
    });
  }
  const base = {
    schemaVersion: 1 as const,
    workspaceRoot,
    itemId: item.id,
    ...(extraction ? { extractionId: extraction.id } : {}),
    ...(collectionKey ? { collectionKey } : {}),
    actions,
    omissions: projectionOmissions(item, extraction ?? undefined),
  };
  return { ...base, planDigest: digest(base) };
}

export async function previewZoteroSink(options: {
  plan: ZoteroSinkPlan;
  settings: ZoteroResolvedSettings;
  client: ZoteroToolClient;
}): Promise<ZoteroSinkPreview> {
  if (!options.settings.enabled) throw new ZoteroSinkError("Zotero sink is disabled; enable it in user configuration or use an explicit CLI endpoint");
  const status = await options.client.callTool("zotero_status", {});
  const collectionProbe = options.plan.collectionKey
    ? await options.client.callTool("zotero_list", {
        scope: `collection:${options.plan.collectionKey}`,
        type: "items",
        limit: 1,
      })
    : undefined;
  const actionPreviews: unknown[] = [];
  for (const action of options.plan.actions) {
    actionPreviews.push(await options.client.callTool("zotero_write", {
      action: action.action,
      params: action.params,
      dryRun: true,
    }));
  }
  const previewDigest = digest({
    schemaVersion: 1,
    endpoint: options.settings.endpoint,
    planDigest: options.plan.planDigest,
    status,
    ...(collectionProbe !== undefined ? { collectionProbe } : {}),
    actionPreviews,
  });
  return {
    plan: options.plan,
    endpoint: options.settings.endpoint,
    previewDigest,
    status,
    ...(collectionProbe !== undefined ? { collectionProbe } : {}),
    actionPreviews,
  };
}

function returnedKey(value: unknown, phase: string): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const key = record.key ?? record.itemKey;
    if (typeof key === "string" && key) return key;
  }
  throw new ZoteroSinkError(`Zotero ${phase} response did not return a key`);
}

function payloadContainsKey(value: unknown, key: string): boolean {
  if (value === key) return true;
  if (Array.isArray(value)) return value.some((entry) => payloadContainsKey(entry, key));
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).some((entry) => payloadContainsKey(entry, key));
  }
  return false;
}

async function writeReceipt(workspaceRoot: string, receipt: ZoteroSinkReceipt): Promise<string> {
  const dir = path.join(path.resolve(workspaceRoot), RECEIPTS_DIR);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${receipt.receiptId}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
    return target;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function applyZoteroSink(options: {
  plan: ZoteroSinkPlan;
  settings: ZoteroResolvedSettings;
  acknowledgedPreviewDigest: string;
  client: ZoteroToolClient;
}): Promise<{ receipt: ZoteroSinkReceipt; receiptPath?: string; receiptError?: string }> {
  const preview = await previewZoteroSink(options);
  if (options.acknowledgedPreviewDigest !== preview.previewDigest) {
    throw new ZoteroSinkError("Acknowledged preview digest does not match the exact current remote dry-run preview");
  }
  const completedPhases: string[] = [];
  let zoteroItemKey: string | undefined;
  let zoteroNoteKey: string | undefined;
  let failedPhase: string | undefined;
  try {
    const itemAction = options.plan.actions[0]!;
    zoteroItemKey = returnedKey(await options.client.callTool("zotero_write", {
      action: itemAction.action,
      params: itemAction.params,
      dryRun: false,
    }), "create_item");
    completedPhases.push("create_item");
    const noteAction = options.plan.actions.find((action) => action.action === "create_note");
    if (noteAction) {
      const params = { ...noteAction.params, itemKey: zoteroItemKey };
      zoteroNoteKey = returnedKey(await options.client.callTool("zotero_write", {
        action: noteAction.action,
        params,
        dryRun: false,
      }), "create_note");
      completedPhases.push("create_note");
    }
  } catch (error) {
    if (!zoteroItemKey) throw error;
    failedPhase = completedPhases.includes("create_note") ? "verification" : "create_note";
  }
  if (!zoteroItemKey) throw new ZoteroSinkError("Zotero item creation did not complete");

  let verification: unknown;
  if (!failedPhase) {
    try {
      const item = await options.client.callTool("zotero_read", {
        key: zoteroItemKey,
        sections: ["metadata", "abstract", "notes"],
        format: "markdown",
      });
      const collection = options.plan.collectionKey
        ? await options.client.callTool("zotero_list", {
            scope: `collection:${options.plan.collectionKey}`,
            type: "items",
            limit: 100,
          })
        : undefined;
      if (!payloadContainsKey(item, zoteroItemKey)) {
        throw new ZoteroSinkError(`Zotero verification did not return item key ${zoteroItemKey}`);
      }
      if (options.plan.collectionKey && !payloadContainsKey(collection, zoteroItemKey)) {
        throw new ZoteroSinkError(`Zotero collection verification did not contain item key ${zoteroItemKey}`);
      }
      verification = {
        itemVerified: true,
        ...(options.plan.collectionKey ? { collectionVerified: true } : {}),
      };
      completedPhases.push("verify");
    } catch {
      failedPhase = "verification";
    }
  }
  const receipt: ZoteroSinkReceipt = {
    schemaVersion: 1,
    receiptId: randomUUID(),
    createdAt: new Date().toISOString(),
    status: failedPhase ? "partial" : "complete",
    planDigest: options.plan.planDigest,
    previewDigest: preview.previewDigest,
    itemId: options.plan.itemId,
    ...(options.plan.extractionId ? { extractionId: options.plan.extractionId } : {}),
    ...(options.plan.collectionKey ? { collectionKey: options.plan.collectionKey } : {}),
    zoteroItemKey,
    ...(zoteroNoteKey ? { zoteroNoteKey } : {}),
    completedPhases,
    ...(failedPhase ? { failedPhase } : {}),
    ...(verification !== undefined ? { verification } : {}),
  };
  try {
    return { receipt, receiptPath: await writeReceipt(options.plan.workspaceRoot, receipt) };
  } catch (error) {
    const receiptWithFailure: ZoteroSinkReceipt = {
      ...receipt,
      status: "partial",
      failedPhase: "receipt",
    };
    return {
      receipt: receiptWithFailure,
      receiptError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isZoteroUnavailable(error: unknown): error is ZoteroUnavailableError {
  return error instanceof ZoteroUnavailableError;
}
