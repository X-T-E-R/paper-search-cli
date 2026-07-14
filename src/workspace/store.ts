import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createArtifactRecord, type ArtifactRecord } from "../material/artifactStore.js";
import type { PatentDetailResult, ResourceItem } from "../providers/sdk/types.js";
import type { LocalStorageRefV1 } from "../storage/types.js";
import { resolveLegacyWorkspacePath, resolveLocalStorageRef } from "../storage/local.js";

export type WorkspaceDetailPayload = PatentDetailResult["detail"];

interface WorkspaceManifest {
  version: 1;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceCollectionsFile {
  collections: WorkspaceCollectionRecord[];
}

export interface WorkspaceCollectionRecord {
  key: string;
  name: string;
  parentKey: string | null;
  path: string;
  itemIds: string[];
  createdAt: string;
}

export interface WorkspaceItemRecord {
  id: string;
  item: ResourceItem;
  url?: string;
  detail?: WorkspaceDetailPayload;
  tags: string[];
  fetchPdfRequested: boolean;
  attachments?: WorkspaceAttachmentRecord[];
  createdAt: string;
  collectionKey: string;
  collectionPath: string;
}

export interface WorkspaceAttachmentRecord {
  id: string;
  itemId: string;
  artifactId?: string;
  filename: string;
  contentType: string;
  sourceUrl?: string;
  path?: string;
  storage?: LocalStorageRefV1;
  status: "attached" | "requested" | "failed";
  sizeBytes?: number;
  message?: string;
  createdAt: string;
}

export interface WorkspacePdfResult {
  ok: boolean;
  /** Compatibility alias for the workspace item id accepted by the command. */
  itemKey?: string;
  /** Workspace item id that owns the attachment/artifact. */
  itemId?: string;
  /** Workspace attachment id kept for legacy attachment-sink consumers. */
  attachmentId?: string;
  /** Durable material artifact record id. */
  artifactId?: string;
  filename?: string;
  path?: string;
  storage?: LocalStorageRefV1;
  sourceUrl?: string;
  message?: string;
  attachment?: WorkspaceAttachmentRecord;
}

export async function resolveWorkspaceAttachmentPath(
  workspaceRoot: string,
  attachment: WorkspaceAttachmentRecord,
): Promise<string | null> {
  if (attachment.storage) return resolveLocalStorageRef(attachment.storage);
  if (attachment.path) return resolveLegacyWorkspacePath(workspaceRoot, attachment.path);
  return null;
}

export interface WorkspaceCollectionNode {
  key: string;
  name: string;
  path: string;
  itemCount: number;
  children?: WorkspaceCollectionNode[];
}

export type WorkspaceExportFormat = "json" | "jsonl" | "csv" | "bibtex";

export interface WorkspaceExportResult {
  format: WorkspaceExportFormat;
  exportedAt: string;
  workspaceRoot: string;
  count: number;
  collectionKey?: string;
  collectionPath?: string;
  includeChildren: boolean;
  items: WorkspaceItemRecord[];
  content: string;
}

const MANIFEST_FILE = "manifest.json";
const COLLECTIONS_FILE = "collections.json";
const ITEMS_DIR = "items";
const WORKSPACE_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const workspaceMutationLocks = new Map<string, Promise<void>>();

async function withWorkspaceMutation<T>(root: string, work: () => Promise<T>): Promise<T> {
  const normalizedRoot = path.resolve(root);
  const previous = workspaceMutationLocks.get(normalizedRoot) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  workspaceMutationLocks.set(normalizedRoot, previous.then(() => current));
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (workspaceMutationLocks.get(normalizedRoot) === current) {
      workspaceMutationLocks.delete(normalizedRoot);
    }
  }
}

async function ensureWorkspaceRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await mkdir(path.join(root, ITEMS_DIR), { recursive: true });
}

async function ensureManifest(root: string): Promise<void> {
  const manifestPath = path.join(root, MANIFEST_FILE);
  try {
    await readFile(manifestPath, "utf8");
  } catch {
    const now = new Date().toISOString();
    const manifest: WorkspaceManifest = {
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }
}

async function loadCollectionsFile(root: string): Promise<WorkspaceCollectionsFile> {
  const collectionsPath = path.join(root, COLLECTIONS_FILE);
  let raw: string;
  try {
    raw = await readFile(collectionsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { collections: [] };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid workspace collection index at ${collectionsPath}: malformed JSON`, {
      cause: error,
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { collections?: unknown }).collections) ||
    !(parsed as { collections: unknown[] }).collections.every(isWorkspaceCollectionRecord)
  ) {
    throw new Error(
      `Invalid workspace collection index at ${collectionsPath}: collections must contain valid collection records`,
    );
  }
  const collections = (parsed as WorkspaceCollectionsFile).collections;
  const keys = new Set<string>();
  const paths = new Set<string>();
  for (const record of collections) {
    if (
      !record.key.trim() ||
      !record.name.trim() ||
      !record.path.trim() ||
      !record.createdAt.trim() ||
      record.itemIds.some((itemId) => !itemId.trim()) ||
      keys.has(record.key) ||
      paths.has(record.path)
    ) {
      throw new Error(
        `Invalid workspace collection index at ${collectionsPath}: collection keys and paths must be non-empty and unique`,
      );
    }
    keys.add(record.key);
    paths.add(record.path);
  }
  const byKey = new Map(collections.map((record) => [record.key, record]));
  for (const record of collections) {
    const ancestry = new Set<string>();
    let current: WorkspaceCollectionRecord | undefined = record;
    while (current) {
      if (ancestry.has(current.key)) {
        throw new Error(
          `Invalid workspace collection index at ${collectionsPath}: collection parent cycle detected`,
        );
      }
      ancestry.add(current.key);
      if (current.parentKey === null) break;
      current = byKey.get(current.parentKey);
      if (!current) {
        throw new Error(
          `Invalid workspace collection index at ${collectionsPath}: unknown parent collection key`,
        );
      }
    }
  }
  return { collections };
}

async function saveCollectionsFile(root: string, data: WorkspaceCollectionsFile): Promise<void> {
  const collectionsPath = path.join(root, COLLECTIONS_FILE);
  const temporaryPath = path.join(
    root,
    `.${COLLECTIONS_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, collectionsPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isWorkspaceCollectionRecord(value: unknown): value is WorkspaceCollectionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<WorkspaceCollectionRecord>;
  return (
    typeof record.key === "string" &&
    typeof record.name === "string" &&
    (record.parentKey === null || typeof record.parentKey === "string") &&
    typeof record.path === "string" &&
    Array.isArray(record.itemIds) &&
    record.itemIds.every((itemId) => typeof itemId === "string") &&
    typeof record.createdAt === "string"
  );
}

async function ensureWorkspace(root: string): Promise<void> {
  await ensureWorkspaceRoot(root);
  await ensureManifest(root);
}

export async function readWorkspaceItemRecord(root: string, itemId: string): Promise<WorkspaceItemRecord | null> {
  if (!WORKSPACE_ITEM_ID_RE.test(itemId) || itemId === "." || itemId === "..") {
    throw new Error(`Invalid workspace item id: ${itemId}`);
  }
  try {
    const raw = await readFile(path.join(root, ITEMS_DIR, `${itemId}.json`), "utf8");
    return JSON.parse(raw) as WorkspaceItemRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function loadAllWorkspaceItems(root: string): Promise<WorkspaceItemRecord[]> {
  try {
    const entries = await readdir(path.join(root, ITEMS_DIR), { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => readWorkspaceItemRecord(root, path.basename(entry.name, ".json"))),
    );
    return records.filter((record): record is WorkspaceItemRecord => Boolean(record));
  } catch {
    return [];
  }
}

async function saveWorkspaceItem(root: string, record: WorkspaceItemRecord): Promise<void> {
  const target = path.join(root, ITEMS_DIR, `${record.id}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizeCollectionPath(input: string): string {
  return input
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

function createCollectionRecord(
  name: string,
  parentKey: string | null,
  collectionPath: string,
): WorkspaceCollectionRecord {
  return {
    key: randomUUID(),
    name,
    parentKey,
    path: collectionPath,
    itemIds: [],
    createdAt: new Date().toISOString(),
  };
}

async function ensureCollectionPath(
  root: string,
  desiredPath: string,
): Promise<{ collection: WorkspaceCollectionRecord; all: WorkspaceCollectionRecord[] }> {
  const normalized = normalizeCollectionPath(desiredPath);
  if (!normalized) {
    throw new Error("Collection path must not be empty");
  }
  const file = await loadCollectionsFile(root);
  let parentKey: string | null = null;
  let currentPath = "";
  let current: WorkspaceCollectionRecord | undefined;

  for (const segment of normalized.split("/")) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    current = file.collections.find((entry) => entry.path === currentPath);
    if (!current) {
      current = createCollectionRecord(segment, parentKey, currentPath);
      file.collections.push(current);
    }
    parentKey = current.key;
  }

  await saveCollectionsFile(root, file);
  return {
    collection: current!,
    all: file.collections,
  };
}

async function resolveCollectionByKey(
  root: string,
  key: string,
): Promise<{ collection: WorkspaceCollectionRecord; all: WorkspaceCollectionRecord[] }> {
  const file = await loadCollectionsFile(root);
  const collection = file.collections.find((entry) => entry.key === key);
  if (!collection) {
    throw new Error(`Collection key not found: ${key}`);
  }
  return { collection, all: file.collections };
}

function buildFallbackItem(url: string, title?: string): ResourceItem {
  return {
    itemType: "webpage",
    title: title?.trim() || url,
    url,
  };
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractFirstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFirstString(item);
      if (found) return found;
    }
  }
  return undefined;
}

function looksLikePdfUrl(value: unknown): string | undefined {
  const text = extractFirstString(value);
  if (!text) return undefined;
  return /\.pdf(?:[?#].*)?$/iu.test(text) ? text : undefined;
}

function findPdfUrlInRecord(record: WorkspaceItemRecord): string | undefined {
  const detailPdf = isRecord(record.detail) ? record.detail.pdf : undefined;
  if (isRecord(detailPdf)) {
    const fromUrls = extractFirstString(detailPdf.urls);
    if (fromUrls) return fromUrls;
  }

  const looseItem = record.item as unknown as Record<string, unknown>;
  return (
    looksLikePdfUrl(record.item.url) ||
    looksLikePdfUrl(looseItem.URL) ||
    looksLikePdfUrl(record.url)
  );
}

function existingPdfAttachment(record: WorkspaceItemRecord): WorkspaceAttachmentRecord | undefined {
  return (record.attachments ?? []).find(
    (attachment) =>
      (attachment.contentType === "application/pdf" || /\.pdf$/iu.test(attachment.filename)) &&
      (attachment.status === "attached" || attachment.status === "requested"),
  );
}

async function createPdfArtifactForAttachment(
  root: string,
  options: {
    itemId: string;
    attachment: WorkspaceAttachmentRecord;
    sourceUrl?: string;
    downloaded: boolean;
    responseStatus?: number;
    createdAt: string;
  },
): Promise<ArtifactRecord> {
  const status: ArtifactRecord["status"] = options.downloaded ? "downloaded" : "requested";
  const origin: ArtifactRecord["provenance"]["origin"] = options.sourceUrl
    ? (options.downloaded ? "download" : "resolved")
    : "user_supplied";
  return createArtifactRecord(root, {
    kind: "pdf",
    status,
    itemId: options.itemId,
    filename: options.attachment.filename,
    contentType: options.attachment.contentType,
    path: options.attachment.path,
    storage: options.attachment.storage,
    remoteUrl: options.sourceUrl,
    sizeBytes: options.attachment.sizeBytes,
    provenance: {
      origin,
      ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    },
    attempts: [
      {
        tier: options.downloaded ? "resource-pdf-download" : "resource-pdf-record",
        ...(options.sourceUrl ? { source: options.sourceUrl } : {}),
        ok: true,
        ...(options.responseStatus !== undefined ? { status: options.responseStatus } : {}),
        ...(options.attachment.message ? { message: options.attachment.message } : {}),
        at: options.createdAt,
      },
    ],
    ...(options.attachment.message ? { message: options.attachment.message } : {}),
    createdAt: options.createdAt,
  });
}

function pdfSuccessResult(options: {
  itemId: string;
  attachment: WorkspaceAttachmentRecord;
  artifactId: string;
  message: string;
}): WorkspacePdfResult {
  return {
    ok: true,
    itemKey: options.itemId,
    itemId: options.itemId,
    attachmentId: options.attachment.id,
    artifactId: options.artifactId,
    filename: options.attachment.filename,
    path: options.attachment.path,
    storage: options.attachment.storage,
    sourceUrl: options.attachment.sourceUrl,
    message: options.message,
    attachment: options.attachment,
  };
}

export async function addResourceToWorkspace(
  root: string,
  options: {
    item?: ResourceItem;
    detail?: WorkspaceDetailPayload;
    url?: string;
    title?: string;
    collectionKey?: string;
    collectionPath?: string;
    tags?: string[];
    fetchPdf?: boolean;
    defaultCollectionPath: string;
  },
): Promise<{ record: WorkspaceItemRecord; collection: WorkspaceCollectionRecord }> {
  return withWorkspaceMutation(root, async () => {
    await ensureWorkspace(root);
    const item = options.item ?? (options.url ? buildFallbackItem(options.url, options.title) : undefined);
    if (!item) {
      throw new Error("Provide item metadata or a URL");
    }

    const collectionResult = options.collectionKey
      ? await resolveCollectionByKey(root, options.collectionKey)
      : await ensureCollectionPath(root, options.collectionPath || options.defaultCollectionPath);

    const record: WorkspaceItemRecord = {
      id: randomUUID(),
      item,
      url: options.url,
      detail: options.detail,
      tags: dedupeTags(options.tags ?? []),
      fetchPdfRequested: Boolean(options.fetchPdf),
      createdAt: new Date().toISOString(),
      collectionKey: collectionResult.collection.key,
      collectionPath: collectionResult.collection.path,
    };

    await writeFile(
      path.join(root, ITEMS_DIR, `${record.id}.json`),
      JSON.stringify(record, null, 2),
      "utf8",
    );

    const updatedCollections = collectionResult.all.map((entry) =>
      entry.key === collectionResult.collection.key
        ? { ...entry, itemIds: [...entry.itemIds, record.id] }
        : entry,
    );
    await saveCollectionsFile(root, { collections: updatedCollections });
    const updatedCollection = updatedCollections.find((entry) => entry.key === record.collectionKey)!;
    return { record, collection: updatedCollection };
  });
}

export async function fetchPdfForWorkspaceItem(
  root: string,
  options: {
    itemKey: string;
    url?: string;
    filename?: string;
    download?: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<WorkspacePdfResult> {
  return withWorkspaceMutation(root, async () => {
    await ensureWorkspace(root);
    const record = await readWorkspaceItemRecord(root, options.itemKey);
    if (!record) {
      return { ok: false, message: `Item not found: ${options.itemKey}` };
    }

    const existing = existingPdfAttachment(record);
    if (existing) {
      const message = existing.status === "attached" ? "PDF already attached" : "PDF already requested";
      if (existing.artifactId) {
        return pdfSuccessResult({
          itemId: record.id,
          attachment: existing,
          artifactId: existing.artifactId,
          message,
        });
      }

      const artifact = await createPdfArtifactForAttachment(root, {
        itemId: record.id,
        attachment: existing,
        sourceUrl: existing.sourceUrl || findPdfUrlInRecord(record),
        downloaded: existing.status === "attached",
        createdAt: new Date().toISOString(),
      });
      const attachmentWithArtifact = { ...existing, artifactId: artifact.id };
      const updated = {
        ...record,
        attachments: (record.attachments ?? []).map((attachment) =>
          attachment.id === existing.id ? attachmentWithArtifact : attachment,
        ),
      };
      await saveWorkspaceItem(root, updated);
      return pdfSuccessResult({
        itemId: record.id,
        attachment: attachmentWithArtifact,
        artifactId: artifact.id,
        message,
      });
    }

    return {
      ok: false,
      itemKey: record.id,
      itemId: record.id,
      sourceUrl: options.url || findPdfUrlInRecord(record),
      message: "Direct core PDF acquisition is disabled; route resource-pdf through an installed material downloader provider",
    };
  });
}

/** Project a provider-created artifact into the legacy attachment list without moving its bytes. */
export async function recordArtifactAsWorkspaceAttachment(
  root: string,
  artifact: ArtifactRecord,
): Promise<WorkspacePdfResult> {
  if (!artifact.itemId) {
    return { ok: false, artifactId: artifact.id, message: "Artifact is not attached to a workspace item" };
  }
  return withWorkspaceMutation(root, async () => {
    await ensureWorkspace(root);
    const record = await readWorkspaceItemRecord(root, artifact.itemId!);
    if (!record) return { ok: false, artifactId: artifact.id, message: `Item not found: ${artifact.itemId}` };
    const existing = (record.attachments ?? []).find((entry) => entry.artifactId === artifact.id);
    if (existing) {
      return pdfSuccessResult({ itemId: record.id, attachment: existing, artifactId: artifact.id, message: "PDF already attached" });
    }
    const createdAt = new Date().toISOString();
    const attachment: WorkspaceAttachmentRecord = {
      id: randomUUID(),
      itemId: record.id,
      artifactId: artifact.id,
      filename: artifact.filename ?? "attachment.pdf",
      contentType: artifact.contentType ?? "application/pdf",
      ...(artifact.remoteUrl ? { sourceUrl: artifact.remoteUrl } : {}),
      ...(artifact.path ? { path: artifact.path } : {}),
      ...(artifact.storage ? { storage: artifact.storage } : {}),
      status: artifact.status === "downloaded" || artifact.status === "recorded" ? "attached" : "requested",
      ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
      message: artifact.message,
      createdAt,
    };
    await saveWorkspaceItem(root, { ...record, attachments: [...(record.attachments ?? []), attachment] });
    return pdfSuccessResult({
      itemId: record.id,
      attachment,
      artifactId: artifact.id,
      message: attachment.status === "attached"
        ? "PDF acquired through material provider and attached to the workspace item"
        : "PDF acquisition recorded through material provider without downloading bytes",
    });
  });
}

function toTree(records: WorkspaceCollectionRecord[]): WorkspaceCollectionNode[] {
  const byParent = new Map<string | null, WorkspaceCollectionRecord[]>();
  for (const record of records) {
    const key = record.parentKey ?? null;
    const bucket = byParent.get(key) ?? [];
    bucket.push(record);
    byParent.set(key, bucket);
  }

  const build = (parentKey: string | null): WorkspaceCollectionNode[] =>
    (byParent.get(parentKey) ?? [])
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((record) => {
        const children = build(record.key);
        return {
          key: record.key,
          name: record.name,
          path: record.path,
          itemCount: record.itemIds.length,
          ...(children.length > 0 ? { children } : {}),
        };
      });

  return build(null);
}

export async function listWorkspaceCollections(
  root: string,
  options: { defaultCollectionPath: string; flat?: boolean },
): Promise<WorkspaceCollectionNode[] | Array<Omit<WorkspaceCollectionNode, "children">>> {
  return withWorkspaceMutation(root, async () => {
    await ensureWorkspace(root);
    await ensureCollectionPath(root, options.defaultCollectionPath);
    const file = await loadCollectionsFile(root);
    if (options.flat) {
      return file.collections
        .slice()
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((record) => ({
          key: record.key,
          name: record.name,
          path: record.path,
          itemCount: record.itemIds.length,
        }));
    }
    return toTree(file.collections);
  });
}

export async function exportWorkspaceItems(
  root: string,
  options: {
    format: WorkspaceExportFormat;
    collectionKey?: string;
    collectionPath?: string;
    includeChildren?: boolean;
  },
): Promise<WorkspaceExportResult> {
  return withWorkspaceMutation(root, async () => {
    await ensureWorkspace(root);
    const includeChildren = Boolean(options.includeChildren);
    const collectionsFile = await loadCollectionsFile(root);
    let items: WorkspaceItemRecord[];

    if (options.collectionKey || options.collectionPath) {
      const normalizedPath = options.collectionPath
        ? normalizeCollectionPath(options.collectionPath)
        : undefined;
      const selectedCollections = collectionsFile.collections.filter((collection) => {
        if (options.collectionKey && collection.key === options.collectionKey) return true;
        if (!normalizedPath) return false;
        return includeChildren
          ? collection.path === normalizedPath || collection.path.startsWith(`${normalizedPath}/`)
          : collection.path === normalizedPath;
      });
      const itemIds = [...new Set(selectedCollections.flatMap((collection) => collection.itemIds))];
      const loaded = await Promise.all(itemIds.map((itemId) => readWorkspaceItemRecord(root, itemId)));
      items = loaded.filter((record): record is WorkspaceItemRecord => Boolean(record));
    } else {
      items = await loadAllWorkspaceItems(root);
    }

    items = items.sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt),
    );

    const resultBase = {
      format: options.format,
      exportedAt: new Date().toISOString(),
      workspaceRoot: path.resolve(root),
      count: items.length,
      collectionKey: options.collectionKey,
      collectionPath: options.collectionPath ? normalizeCollectionPath(options.collectionPath) : undefined,
      includeChildren,
      items,
    };

    return {
      ...resultBase,
      content: serializeWorkspaceExport(resultBase),
    };
  });
}

function serializeWorkspaceExport(payload: Omit<WorkspaceExportResult, "content">): string {
  if (payload.format === "json") {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }
  if (payload.format === "jsonl") {
    return payload.items.length > 0
      ? `${payload.items.map((record) => JSON.stringify(record)).join("\n")}\n`
      : "";
  }
  if (payload.format === "csv") {
    return serializeWorkspaceCsv(payload.items);
  }
  return serializeWorkspaceBibtex(payload.items);
}

function serializeWorkspaceCsv(items: WorkspaceItemRecord[]): string {
  const columns = [
    "id",
    "itemType",
    "title",
    "creators",
    "date",
    "DOI",
    "url",
    "publicationTitle",
    "collectionPath",
    "tags",
    "attachmentCount",
    "createdAt",
  ];
  const rows = items.map((record) => {
    const item = record.item;
    return [
      record.id,
      item.itemType,
      item.title,
      formatCreators(item.creators),
      item.date || item.filingDate || item.issueDate || "",
      item.DOI || "",
      item.url || record.url || "",
      item.publicationTitle || "",
      record.collectionPath,
      record.tags.join("; "),
      String(record.attachments?.length ?? 0),
      record.createdAt,
    ].map(csvEscape).join(",");
  });
  return `${columns.join(",")}\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
}

function serializeWorkspaceBibtex(items: WorkspaceItemRecord[]): string {
  return items.length > 0
    ? `${items.map((record) => serializeRecordBibtex(record)).join("\n\n")}\n`
    : "";
}

function serializeRecordBibtex(record: WorkspaceItemRecord): string {
  const item = record.item;
  const type = bibtexType(item.itemType);
  const fields: Array<[string, string | undefined]> = [
    ["title", item.title],
    ["author", formatCreators(item.creators, " and ")],
    ["year", extractYear(item.date || item.filingDate || item.issueDate)],
    ["doi", item.DOI],
    ["url", item.url || record.url],
    ["journal", item.publicationTitle],
    ["volume", item.volume],
    ["number", item.issue],
    ["pages", item.pages],
    ["abstract", item.abstractNote],
    ["keywords", [...record.tags, ...(item.tags ?? []).map((tag) => tag.tag)].filter(Boolean).join(", ")],
    ["note", item.extra],
    ["patentnumber", item.patentNumber],
    ["holder", item.assignee],
  ];
  const body = fields
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key, value]) => `  ${key} = {${bibtexEscape(value!.trim())}}`)
    .join(",\n");
  return `@${type}{${citationKey(record)},\n${body}\n}`;
}

function bibtexType(itemType: string): string {
  switch (itemType) {
    case "journalArticle":
      return "article";
    case "conferencePaper":
      return "inproceedings";
    case "book":
      return "book";
    case "patent":
      return "patent";
    case "webpage":
      return "online";
    default:
      return "misc";
  }
}

function citationKey(record: WorkspaceItemRecord): string {
  const firstCreator = record.item.creators?.[0]?.lastName || "item";
  const year = extractYear(record.item.date || record.item.filingDate || record.item.issueDate) || "undated";
  const titleSlug = slug(record.item.title).slice(0, 32);
  return [slug(firstCreator), year, titleSlug || record.id.slice(0, 8)]
    .filter(Boolean)
    .join("-")
    .replace(/^-|-$/gu, "");
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
}

function extractYear(value?: string): string | undefined {
  return value?.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/u)?.[1];
}

function formatCreators(creators: ResourceItem["creators"], separator = "; "): string {
  return (creators ?? [])
    .map((creator) => [creator.firstName, creator.lastName].filter(Boolean).join(" ").trim())
    .filter(Boolean)
    .join(separator);
}

function csvEscape(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

function bibtexEscape(value: string): string {
  return value.replace(/\\/gu, "\\textbackslash{}").replace(/[{}]/gu, (match) => `\\${match}`);
}
