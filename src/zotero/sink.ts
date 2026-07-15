import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  readExtractionRecord,
  resolveExtractionOutputPath,
} from "../material/extractionStore.js";
import {
  listArtifactRecords,
  readArtifactRecord,
  resolveArtifactRecordPath,
} from "../material/artifactStore.js";
import type { ExtractionRecord } from "../material/records.js";
import { withLocks } from "../runtime/locks.js";
import { readWorkspaceItemRecord, type WorkspaceItemRecord } from "../workspace/store.js";
import type { ZoteroToolClient } from "./client.js";
import { ZoteroRemoteError, ZoteroUnavailableError } from "./client.js";
import { readZoteroItemMapping, writeZoteroItemMapping } from "./mapping.js";
import type {
  ZoteroItemMapping,
  ZoteroResolvedSettings,
  ZoteroSinkPlan,
  ZoteroSinkPreview,
  ZoteroSinkReceipt,
  ZoteroWriteAction,
} from "./types.js";

const RECEIPTS_DIR = "zotero/receipts";
const CREATED_ITEM_PLACEHOLDER = "$createdItemKey";
const ZOTERO_KEY_RE = /^[A-Za-z0-9]+$/u;

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
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
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

function itemTags(item: WorkspaceItemRecord): string[] {
  return [...new Set([...(item.item.tags ?? []).map((entry) => entry.tag), ...item.tags])];
}

function supportedItemProjection(item: WorkspaceItemRecord, collectionKeys: string[]): Record<string, unknown> {
  const year = item.item.date?.match(/\b\d{4}\b/u)?.[0];
  const tags = itemTags(item);
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
    ...(collectionKeys.length > 0 ? { collectionKeys } : {}),
  };
}

function supportedItemUpdate(item: WorkspaceItemRecord, itemKey: string): Record<string, unknown> {
  const fields = {
    title: item.item.title,
    ...(item.item.date ? { date: item.item.date } : {}),
    ...(item.item.DOI ? { DOI: item.item.DOI } : {}),
    ...(item.item.abstractNote ? { abstractNote: item.item.abstractNote } : {}),
    ...(item.item.publicationTitle ? { publicationTitle: item.item.publicationTitle } : {}),
    ...(item.item.url ?? item.url ? { url: item.item.url ?? item.url } : {}),
  };
  const tags = itemTags(item);
  return {
    itemKey,
    fields,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function normalizeCollectionKeys(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of values) {
    const key = raw.trim();
    if (!key || !ZOTERO_KEY_RE.test(key)) {
      throw new ZoteroSinkError("Zotero collection keys must contain only letters and digits");
    }
    if (!result.includes(key)) result.push(key);
  }
  return result;
}

function projectionOmissions(options: {
  item: WorkspaceItemRecord;
  extraction?: ExtractionRecord;
  attachmentMode: "none" | "link" | "import";
  markdownMode: "none" | "note" | "link" | "import";
  materialPathOmissions: string[];
  markdownPathMissing: boolean;
}): string[] {
  const unsupported = [
    "volume", "issue", "pages", "ISSN", "ISBN", "language", "accessDate", "rights", "extra",
    "country", "assignee", "issuingAuthority", "patentNumber", "applicationNumber", "priorityNumbers",
    "filingDate", "issueDate", "legalStatus", "references", "sourceId", "source", "relevanceScore", "citationCount",
  ].filter((key) => options.item.item[key as keyof typeof options.item.item] !== undefined);
  const omissions = unsupported.map((field) => `Unsupported Zotero projection field retained locally: ${field}`);
  if (options.item.detail !== undefined) omissions.push("Workspace detail payload retained locally");
  if ((options.item.attachments ?? []).length > 0 && options.attachmentMode === "none") {
    omissions.push("Local PDF/artifact files were not attached to Zotero by the current attachment policy");
  }
  omissions.push(...options.materialPathOmissions);
  if (options.extraction && options.markdownMode === "note") {
    omissions.push("Local Markdown/JSON/assets were not attached to Zotero; selected Markdown was rendered as a note");
  } else if (options.extraction && options.markdownMode === "none") {
    omissions.push("Local Markdown/JSON/assets were not projected to Zotero by the current Markdown policy");
  } else if (options.extraction && options.markdownPathMissing) {
    omissions.push("The selected extraction has no durable Markdown file to attach; local extraction metadata remains authoritative");
  }
  return omissions;
}

async function validateExtractionOwnership(
  workspaceRoot: string,
  item: WorkspaceItemRecord,
  extractionId?: string,
): Promise<ExtractionRecord | null> {
  const extraction = extractionId ? await readExtractionRecord(workspaceRoot, extractionId) : null;
  if (extractionId && !extraction) throw new ZoteroSinkError(`Extraction not found: ${extractionId}`);
  if (extraction?.itemId && extraction.itemId !== item.id) {
    throw new ZoteroSinkError(`Extraction ${extraction.id} belongs to a different workspace item`);
  }
  if (extraction && !extraction.itemId && extraction.source.kind === "artifact" && extraction.source.artifactId) {
    const artifact = await readArtifactRecord(workspaceRoot, extraction.source.artifactId);
    if (artifact?.itemId && artifact.itemId !== item.id) {
      throw new ZoteroSinkError(`Extraction ${extraction.id} derives from an artifact owned by a different workspace item`);
    }
  }
  return extraction;
}

export async function planZoteroSink(options: {
  workspaceRoot: string;
  itemId: string;
  extractionId?: string;
  collectionKey?: string;
  collectionKeys?: readonly string[];
  existingZoteroItemKey?: string;
  attachmentMode?: "none" | "link" | "import";
  markdownMode?: "none" | "note" | "link" | "import";
}): Promise<ZoteroSinkPlan> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const item = await readWorkspaceItemRecord(workspaceRoot, options.itemId);
  if (!item) throw new ZoteroSinkError(`Workspace item not found: ${options.itemId}`);
  const extraction = await validateExtractionOwnership(workspaceRoot, item, options.extractionId);
  const collectionKeys = normalizeCollectionKeys([
    ...(options.collectionKeys ?? []),
    ...(options.collectionKey ? [options.collectionKey] : []),
  ]);
  const attachmentMode = options.attachmentMode ?? "none";
  const markdownMode = options.markdownMode ?? "note";
  const mapping = await readZoteroItemMapping(workspaceRoot, item.id)
    ?? await readRecoverableZoteroItemMapping(workspaceRoot, item.id);
  const explicitItemKey = options.existingZoteroItemKey?.trim();
  if (explicitItemKey && !ZOTERO_KEY_RE.test(explicitItemKey)) {
    throw new ZoteroSinkError("Zotero item key must contain only letters and digits");
  }
  if (mapping && explicitItemKey && mapping.zoteroItemKey !== explicitItemKey) {
    throw new ZoteroSinkError(`Workspace item ${item.id} is already mapped to Zotero item ${mapping.zoteroItemKey}`);
  }
  const existingZoteroItemKey = mapping?.zoteroItemKey ?? explicitItemKey;
  const targetItemKey = existingZoteroItemKey ?? CREATED_ITEM_PLACEHOLDER;
  const actions: ZoteroWriteAction[] = existingZoteroItemKey
    ? [{ action: "update_item", params: supportedItemUpdate(item, existingZoteroItemKey) }]
    : [{ action: "create_item", params: supportedItemProjection(item, collectionKeys) }];

  if (existingZoteroItemKey) {
    for (const collectionKey of collectionKeys) {
      actions.push({
        action: "add_to_collection",
        params: { itemKeys: [existingZoteroItemKey], collectionKey },
      });
    }
  }

  if (extraction && markdownMode === "note") {
    const sourceRef = `extraction:${extraction.id}:note`;
    const noteKey = mapping?.noteKeys[sourceRef];
    actions.push(noteKey
      ? {
          action: "update_note",
          sourceRef,
          params: { noteKey, note: renderNote(await extractionMarkdown(workspaceRoot, extraction), extraction) },
        }
      : {
          action: "create_note",
          sourceRef,
          params: {
            itemKey: targetItemKey,
            note: renderNote(await extractionMarkdown(workspaceRoot, extraction), extraction),
          },
        });
  }

  const materialPathOmissions: string[] = [];
  if (attachmentMode !== "none") {
    const artifacts = await listArtifactRecords(workspaceRoot, { itemId: item.id });
    for (const artifact of artifacts) {
      if (artifact.status !== "downloaded" && artifact.status !== "recorded") continue;
      const sourceRef = `artifact:${artifact.id}`;
      const projectedAttachment = mapping?.attachments[sourceRef];
      if (projectedAttachment?.mode === attachmentMode && projectedAttachment.verified !== false) continue;
      const artifactPath = await resolveArtifactRecordPath(workspaceRoot, artifact);
      if (!artifactPath) {
        materialPathOmissions.push(`Artifact ${artifact.id} has no durable local file to attach to Zotero`);
        continue;
      }
      actions.push({
        action: "attach_file",
        sourceRef,
        params: {
          itemKey: targetItemKey,
          filePath: artifactPath,
          mode: attachmentMode,
          ...(projectedAttachment?.mode === attachmentMode && projectedAttachment.verified === false
            ? { existingAttachmentKey: projectedAttachment.zoteroAttachmentKey }
            : {}),
          ...(artifact.filename ? { title: artifact.filename } : {}),
          ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
        },
      });
    }
  }

  let markdownPathMissing = false;
  if (extraction && markdownMode !== "none" && markdownMode !== "note") {
    const sourceRef = `extraction:${extraction.id}:markdown`;
    const projectedAttachment = mapping?.attachments[sourceRef];
    if (projectedAttachment?.mode !== markdownMode || projectedAttachment.verified === false) {
      const markdownPath = await resolveExtractionOutputPath(workspaceRoot, extraction, "markdown");
      if (markdownPath) {
        actions.push({
          action: "attach_file",
          sourceRef,
          params: {
            itemKey: targetItemKey,
            filePath: markdownPath,
            mode: markdownMode,
            ...(projectedAttachment?.mode === markdownMode && projectedAttachment.verified === false
              ? { existingAttachmentKey: projectedAttachment.zoteroAttachmentKey }
              : {}),
            title: `${item.item.title}.md`,
            contentType: "text/markdown",
          },
        });
      } else {
        markdownPathMissing = true;
      }
    }
  }

  const omissions = projectionOmissions({
    item,
    extraction: extraction ?? undefined,
    attachmentMode,
    markdownMode,
    materialPathOmissions,
    markdownPathMissing,
  });
  const base = {
    schemaVersion: 1 as const,
    workspaceRoot,
    itemId: item.id,
    ...(extraction ? { extractionId: extraction.id } : {}),
    ...(collectionKeys[0] ? { collectionKey: collectionKeys[0] } : {}),
    collectionKeys,
    ...(existingZoteroItemKey ? { existingZoteroItemKey } : {}),
    actions,
    omissions,
  };
  return { ...base, planDigest: digest(base) };
}

function isDeferredAttachmentPreview(action: ZoteroWriteAction): boolean {
  return action.action === "attach_file" && action.params.itemKey === CREATED_ITEM_PLACEHOLDER;
}

export async function previewZoteroSink(options: {
  plan: ZoteroSinkPlan;
  settings: ZoteroResolvedSettings;
  client: ZoteroToolClient;
}): Promise<ZoteroSinkPreview> {
  if (!options.settings.enabled) {
    throw new ZoteroSinkError("Zotero sink is disabled; enable it in user configuration or use an explicit CLI endpoint");
  }
  const status = await options.client.callTool("zotero_status", {});
  const collectionProbes: Record<string, unknown> = {};
  for (const collectionKey of options.plan.collectionKeys) {
    collectionProbes[collectionKey] = await options.client.callTool("zotero_list", {
      scope: `collection:${collectionKey}`,
      type: "items",
      limit: 1,
    });
  }
  const actionPreviews: unknown[] = [];
  for (const action of options.plan.actions) {
    if (isDeferredAttachmentPreview(action)) {
      actionPreviews.push({
        ok: true,
        dryRun: true,
        action: action.action,
        deferredUntilItemCreation: true,
        params: action.params,
      });
      continue;
    }
    actionPreviews.push(await options.client.callTool("zotero_write", {
      action: action.action,
      params: action.params,
      dryRun: true,
    }));
  }
  const collectionProbe = options.plan.collectionKeys[0]
    ? collectionProbes[options.plan.collectionKeys[0]]
    : undefined;
  const previewDigest = digest({
    schemaVersion: 1,
    endpoint: options.settings.endpoint,
    planDigest: options.plan.planDigest,
    status,
    collectionProbes,
    actionPreviews,
  });
  return {
    plan: options.plan,
    endpoint: options.settings.endpoint,
    previewDigest,
    status,
    ...(collectionProbe !== undefined ? { collectionProbe } : {}),
    ...(options.plan.collectionKeys.length > 0 ? { collectionProbes } : {}),
    actionPreviews,
  };
}

function returnedKey(value: unknown, action: ZoteroWriteAction["action"]): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const key = action === "attach_file"
      ? record.attachmentKey ?? record.key
      : action === "create_note" || action === "update_note"
        ? record.noteKey ?? record.key
        : record.itemKey ?? record.key;
    if (typeof key === "string" && key) return key;
  }
  throw new ZoteroSinkError(`Zotero ${action} response did not return a key`);
}

function partialAttachmentKey(error: unknown): string | undefined {
  if (!(error instanceof ZoteroRemoteError) || typeof error.payload !== "object" || error.payload === null) {
    return undefined;
  }
  const partial = (error.payload as Record<string, unknown>).partial;
  if (typeof partial !== "object" || partial === null) return undefined;
  const attachmentKey = (partial as Record<string, unknown>).attachmentKey;
  return typeof attachmentKey === "string" && attachmentKey.length > 0 ? attachmentKey : undefined;
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

function resolveActionParams(action: ZoteroWriteAction, zoteroItemKey?: string): Record<string, unknown> {
  if (action.params.itemKey !== CREATED_ITEM_PLACEHOLDER) return action.params;
  if (!zoteroItemKey) throw new ZoteroSinkError(`Zotero ${action.action} requires the created item key`);
  return { ...action.params, itemKey: zoteroItemKey };
}

function emptyMapping(itemId: string, zoteroItemKey: string): ZoteroItemMapping {
  return {
    schemaVersion: 1,
    itemId,
    zoteroItemKey,
    noteKeys: {},
    attachments: {},
    updatedAt: new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecoveryMapping(value: unknown, itemId: string): ZoteroItemMapping | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.itemId !== itemId
    || typeof value.zoteroItemKey !== "string"
    || !ZOTERO_KEY_RE.test(value.zoteroItemKey)
    || !isRecord(value.noteKeys)
    || !isRecord(value.attachments)
    || typeof value.updatedAt !== "string") {
    return null;
  }
  if (Object.values(value.noteKeys).some((key) => typeof key !== "string" || !ZOTERO_KEY_RE.test(key))) {
    return null;
  }
  for (const attachment of Object.values(value.attachments)) {
    if (!isRecord(attachment)
      || typeof attachment.zoteroAttachmentKey !== "string"
      || !ZOTERO_KEY_RE.test(attachment.zoteroAttachmentKey)
      || (attachment.mode !== "link" && attachment.mode !== "import")
      || typeof attachment.filePath !== "string"
      || (attachment.verified !== undefined && typeof attachment.verified !== "boolean")) {
      return null;
    }
  }
  return structuredClone(value) as unknown as ZoteroItemMapping;
}

async function readRecoverableZoteroItemMapping(
  workspaceRoot: string,
  itemId: string,
): Promise<ZoteroItemMapping | null> {
  const dir = path.join(path.resolve(workspaceRoot), RECEIPTS_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let latest: { createdAt: number; mapping: ZoteroItemMapping } | null = null;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const receipt = JSON.parse(await readFile(path.join(dir, name), "utf8")) as unknown;
      if (!isRecord(receipt) || receipt.itemId !== itemId) continue;
      const mapping = parseRecoveryMapping(receipt.mappingRecovery, itemId);
      if (!mapping) continue;
      const createdAt = typeof receipt.createdAt === "string" ? Date.parse(receipt.createdAt) : Number.NaN;
      const order = Number.isFinite(createdAt) ? createdAt : 0;
      if (!latest || order > latest.createdAt) latest = { createdAt: order, mapping };
    } catch {
      // Invalid or concurrently written receipts are not recovery authority.
    }
  }
  return latest?.mapping ?? null;
}

async function applyZoteroSinkUnderLock(options: {
  plan: ZoteroSinkPlan;
  settings: ZoteroResolvedSettings;
  acknowledgedPreviewDigest: string;
  client: ZoteroToolClient;
}): Promise<{ receipt: ZoteroSinkReceipt; receiptPath?: string; receiptError?: string }> {
  const initialMapping = await readZoteroItemMapping(options.plan.workspaceRoot, options.plan.itemId)
    ?? await readRecoverableZoteroItemMapping(options.plan.workspaceRoot, options.plan.itemId);
  if (!options.plan.existingZoteroItemKey && initialMapping) {
    throw new ZoteroSinkError(
      `Stale Zotero create plan: workspace item ${options.plan.itemId} is now mapped to ${initialMapping.zoteroItemKey}`,
    );
  }
  if (
    options.plan.existingZoteroItemKey &&
    initialMapping &&
    initialMapping.zoteroItemKey !== options.plan.existingZoteroItemKey
  ) {
    throw new ZoteroSinkError(
      `Stale Zotero plan: workspace item ${options.plan.itemId} is mapped to ${initialMapping.zoteroItemKey}, not ${options.plan.existingZoteroItemKey}`,
    );
  }
  const preview = await previewZoteroSink(options);
  if (options.acknowledgedPreviewDigest !== preview.previewDigest) {
    throw new ZoteroSinkError("Acknowledged preview digest does not match the exact current remote dry-run preview");
  }
  const completedPhases: string[] = [];
  let mapping = initialMapping && initialMapping.zoteroItemKey === options.plan.existingZoteroItemKey
    ? structuredClone(initialMapping)
    : null;
  let zoteroItemKey = options.plan.existingZoteroItemKey;
  let zoteroNoteKey: string | undefined;
  const zoteroAttachmentKeys: string[] = [];
  let failedPhase: string | undefined;

  for (const action of options.plan.actions) {
    if (failedPhase) break;
    try {
      const params = resolveActionParams(action, zoteroItemKey);
      if (isDeferredAttachmentPreview(action)) {
        await options.client.callTool("zotero_write", {
          action: action.action,
          params,
          dryRun: true,
        });
      }
      const response = await options.client.callTool("zotero_write", {
        action: action.action,
        params,
        dryRun: false,
      });
      if (action.action === "create_item" || action.action === "update_item") {
        zoteroItemKey = returnedKey(response, action.action);
        mapping ??= emptyMapping(options.plan.itemId, zoteroItemKey);
      } else if (action.action === "create_note" || action.action === "update_note") {
        zoteroNoteKey = returnedKey(response, action.action);
        if (action.sourceRef && mapping) mapping.noteKeys[action.sourceRef] = zoteroNoteKey;
      } else if (action.action === "attach_file") {
        const attachmentKey = returnedKey(response, action.action);
        zoteroAttachmentKeys.push(attachmentKey);
        if (action.sourceRef && mapping) {
          mapping.attachments[action.sourceRef] = {
            zoteroAttachmentKey: attachmentKey,
            mode: params.mode as "link" | "import",
            filePath: String(params.filePath),
            verified: true,
          };
        }
      }
      completedPhases.push(action.action);
    } catch (error) {
      const attachmentKey = action.action === "attach_file" ? partialAttachmentKey(error) : undefined;
      if (attachmentKey && action.sourceRef && mapping) {
        if (!zoteroAttachmentKeys.includes(attachmentKey)) zoteroAttachmentKeys.push(attachmentKey);
        mapping.attachments[action.sourceRef] = {
          zoteroAttachmentKey: attachmentKey,
          mode: action.params.mode as "link" | "import",
          filePath: String(action.params.filePath),
          verified: false,
        };
        completedPhases.push("attach_file_write");
        failedPhase = "attach_file_verification";
        continue;
      }
      if (!zoteroItemKey) throw error;
      failedPhase = action.action;
    }
  }
  if (!zoteroItemKey) throw new ZoteroSinkError("Zotero item creation did not complete");
  mapping ??= emptyMapping(options.plan.itemId, zoteroItemKey);

  let verification: unknown;
  if (!failedPhase) {
    try {
      const item = await options.client.callTool("zotero_read", {
        key: zoteroItemKey,
        sections: ["metadata", "abstract", "notes"],
        format: "markdown",
      });
      if (!payloadContainsKey(item, zoteroItemKey)) {
        throw new ZoteroSinkError(`Zotero verification did not return item key ${zoteroItemKey}`);
      }
      for (const collectionKey of options.plan.collectionKeys) {
        const collection = await options.client.callTool("zotero_list", {
          scope: `collection:${collectionKey}`,
          type: "items",
          limit: 100,
        });
        if (!payloadContainsKey(collection, zoteroItemKey)) {
          throw new ZoteroSinkError(`Zotero collection ${collectionKey} did not contain item key ${zoteroItemKey}`);
        }
      }
      verification = {
        itemVerified: true,
        ...(options.plan.collectionKeys.length > 0
          ? { collectionVerified: true, collectionKeys: options.plan.collectionKeys }
          : {}),
      };
      completedPhases.push("verify");
    } catch {
      failedPhase = "verification";
    }
  }

  mapping.updatedAt = new Date().toISOString();
  let mappingRecovery: ZoteroItemMapping | undefined;
  try {
    await writeZoteroItemMapping(options.plan.workspaceRoot, mapping);
  } catch {
    mappingRecovery = structuredClone(mapping);
    failedPhase ??= "mapping";
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
    ...(options.plan.collectionKeys[0] ? { collectionKey: options.plan.collectionKeys[0] } : {}),
    ...(options.plan.collectionKeys.length > 0 ? { collectionKeys: options.plan.collectionKeys } : {}),
    zoteroItemKey,
    ...(zoteroNoteKey ? { zoteroNoteKey } : {}),
    ...(zoteroAttachmentKeys.length > 0 ? { zoteroAttachmentKeys } : {}),
    completedPhases,
    ...(failedPhase ? { failedPhase } : {}),
    ...(verification !== undefined ? { verification } : {}),
    ...(mappingRecovery ? { mappingRecovery } : {}),
  };
  const reportedReceipt = structuredClone(receipt);
  delete reportedReceipt.mappingRecovery;
  try {
    return {
      receipt: reportedReceipt,
      receiptPath: await writeReceipt(options.plan.workspaceRoot, receipt),
    };
  } catch (error) {
    return {
      receipt: { ...reportedReceipt, status: "partial", failedPhase: "receipt" },
      receiptError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function applyZoteroSink(options: {
  plan: ZoteroSinkPlan;
  settings: ZoteroResolvedSettings;
  acknowledgedPreviewDigest: string;
  client: ZoteroToolClient;
}): Promise<{ receipt: ZoteroSinkReceipt; receiptPath?: string; receiptError?: string }> {
  return withLocks(
    [`item/${options.plan.itemId}`],
    () => applyZoteroSinkUnderLock(options),
    {
      lockRoot: path.join(path.resolve(options.plan.workspaceRoot), "zotero", "locks"),
      timeoutMs: 15_000,
      command: "zotero sink apply",
    },
  );
}

export async function recordPendingZoteroSink(options: {
  workspaceRoot: string;
  itemId: string;
  extractionId?: string;
  reason: string;
  plan?: ZoteroSinkPlan;
}): Promise<{ receipt: ZoteroSinkReceipt; receiptPath: string }> {
  const pendingDigest = digest({
    itemId: options.itemId,
    extractionId: options.extractionId ?? null,
    reason: options.reason,
    planDigest: options.plan?.planDigest ?? null,
  });
  const receipt: ZoteroSinkReceipt = {
    schemaVersion: 1,
    receiptId: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "pending",
    planDigest: options.plan?.planDigest ?? pendingDigest,
    previewDigest: pendingDigest,
    itemId: options.itemId,
    ...(options.extractionId ? { extractionId: options.extractionId } : {}),
    ...(options.plan?.collectionKeys[0] ? { collectionKey: options.plan.collectionKeys[0] } : {}),
    ...(options.plan?.collectionKeys.length ? { collectionKeys: options.plan.collectionKeys } : {}),
    completedPhases: [],
    pendingReason: options.reason,
  };
  return { receipt, receiptPath: await writeReceipt(options.workspaceRoot, receipt) };
}

export function isZoteroUnavailable(error: unknown): error is ZoteroUnavailableError {
  return error instanceof ZoteroUnavailableError;
}
