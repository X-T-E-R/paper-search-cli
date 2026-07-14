import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExtractionOutputs,
  ExtractionRecord,
  ExtractionSource,
  ExtractionStatus,
} from "./records.js";
import { parseLocalStorageRef, resolveLegacyWorkspacePath, resolveLocalStorageRef } from "../storage/local.js";

export type { ExtractionRecord } from "./records.js";

export const EXTRACTION_RECORDS_DIR = "material/extractions";

const EXTRACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ExtractionRecordStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionRecordStoreError";
  }
}

export type CreateExtractionRecordInput = Omit<ExtractionRecord, "id" | "createdAt" | "status"> & {
  id?: string;
  createdAt?: string;
  status?: ExtractionStatus;
};

export interface ListExtractionRecordsOptions {
  /** Return only records attached to this workspace item id. */
  itemId?: string;
  /** Return only records that are not attached to any workspace item. */
  standalone?: boolean;
}

function fail(message: string): never {
  throw new ExtractionRecordStoreError(message);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExtractionId(id: string): string {
  if (!EXTRACTION_ID_RE.test(id) || id === "." || id === "..") {
    fail(`Invalid extraction record id: ${id}`);
  }
  return id;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`${field} must be a string`);
  return value;
}

function parseExtractionSource(value: unknown): ExtractionSource {
  if (!isPlainObject(value)) fail("source must be an object");
  const kind = value.kind;
  if (kind !== "artifact" && kind !== "path" && kind !== "url") {
    fail("source.kind must be artifact | path | url");
  }
  return {
    kind,
    ...(value.artifactId !== undefined
      ? { artifactId: assertOptionalString(value.artifactId, "source.artifactId") }
      : {}),
    ...(value.path !== undefined ? { path: assertOptionalString(value.path, "source.path") } : {}),
    ...(value.url !== undefined ? { url: assertOptionalString(value.url, "source.url") } : {}),
  };
}

function parseExtractionOutputs(value: unknown): ExtractionOutputs {
  if (!isPlainObject(value)) fail("outputs must be an object");
  const markdownStorage = value.markdownStorage !== undefined
    ? parseLocalStorageRef(value.markdownStorage, "outputs.markdownStorage")
    : undefined;
  const jsonStorage = value.jsonStorage !== undefined
    ? parseLocalStorageRef(value.jsonStorage, "outputs.jsonStorage")
    : undefined;
  const assetsStorage = value.assetsStorage !== undefined
    ? parseLocalStorageRef(value.assetsStorage, "outputs.assetsStorage")
    : undefined;
  if ([markdownStorage, jsonStorage, assetsStorage].some((storage) => storage && storage.area !== "extraction")) {
    fail("extraction output storage.area must be extraction");
  }
  return {
    ...(value.markdownPath !== undefined
      ? { markdownPath: assertOptionalString(value.markdownPath, "outputs.markdownPath") }
      : {}),
    ...(value.jsonPath !== undefined ? { jsonPath: assertOptionalString(value.jsonPath, "outputs.jsonPath") } : {}),
    ...(value.assetsDir !== undefined ? { assetsDir: assertOptionalString(value.assetsDir, "outputs.assetsDir") } : {}),
    ...(markdownStorage ? { markdownStorage } : {}),
    ...(jsonStorage ? { jsonStorage } : {}),
    ...(assetsStorage ? { assetsStorage } : {}),
    ...(value.markdown !== undefined ? { markdown: assertOptionalString(value.markdown, "outputs.markdown") } : {}),
  };
}

function parseOptions(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail("options must be an object");
  return value;
}

function parseExtractionRecord(value: unknown): ExtractionRecord {
  if (!isPlainObject(value)) fail("extraction record must be an object");
  const status = value.status;
  if (status !== "extracted" && status !== "requested" && status !== "failed") {
    fail("status must be extracted | requested | failed");
  }
  const cacheHit = value.cacheHit;
  if (typeof cacheHit !== "boolean") fail("cacheHit must be a boolean");
  return {
    id: assertExtractionId(assertString(value.id, "id")),
    source: parseExtractionSource(value.source),
    backend: assertString(value.backend, "backend"),
    status,
    ...(value.options !== undefined ? { options: parseOptions(value.options) } : {}),
    outputs: parseExtractionOutputs(value.outputs),
    cacheHit,
    ...(value.itemId !== undefined ? { itemId: assertOptionalString(value.itemId, "itemId") } : {}),
    ...(value.message !== undefined ? { message: assertOptionalString(value.message, "message") } : {}),
    createdAt: assertString(value.createdAt, "createdAt"),
  };
}

function extractionRecordPath(root: string, id: string): string {
  return path.join(path.resolve(root), EXTRACTION_RECORDS_DIR, `${assertExtractionId(id)}.json`);
}

async function ensureExtractionRecordDir(root: string): Promise<void> {
  await mkdir(path.join(path.resolve(root), EXTRACTION_RECORDS_DIR), { recursive: true });
}

export async function createExtractionRecord(
  workspaceRoot: string,
  input: CreateExtractionRecordInput,
): Promise<ExtractionRecord> {
  await ensureExtractionRecordDir(workspaceRoot);
  const record = parseExtractionRecord({
    ...input,
    id: input.id ?? randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    status: input.status ?? "extracted",
  });
  const target = extractionRecordPath(workspaceRoot, record.id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    try {
      await lstat(target);
      fail(`Extraction record already exists: ${record.id}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return record;
}

export async function readExtractionRecord(
  workspaceRoot: string,
  extractionId: string,
): Promise<ExtractionRecord | null> {
  try {
    return parseExtractionRecord(JSON.parse(await readFile(extractionRecordPath(workspaceRoot, extractionId), "utf8")));
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function resolveExtractionOutputPath(
  workspaceRoot: string,
  record: ExtractionRecord,
  kind: "markdown" | "json" | "assets",
): Promise<string | null> {
  const storage = kind === "markdown"
    ? record.outputs.markdownStorage
    : kind === "json"
      ? record.outputs.jsonStorage
      : record.outputs.assetsStorage;
  if (storage) return resolveLocalStorageRef(storage);
  const legacy = kind === "markdown"
    ? record.outputs.markdownPath
    : kind === "json"
      ? record.outputs.jsonPath
      : record.outputs.assetsDir;
  return legacy ? resolveLegacyWorkspacePath(workspaceRoot, legacy) : null;
}

export async function listExtractionRecords(
  workspaceRoot: string,
  options: ListExtractionRecordsOptions = {},
): Promise<ExtractionRecord[]> {
  if (options.itemId && options.standalone) {
    fail("listExtractionRecords cannot filter by itemId and standalone at the same time");
  }

  let entries;
  try {
    entries = await readdir(path.join(path.resolve(workspaceRoot), EXTRACTION_RECORDS_DIR), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => readExtractionRecord(workspaceRoot, path.basename(entry.name, ".json"))),
  );

  return records
    .filter((record): record is ExtractionRecord => {
      if (!record) return false;
      if (options.itemId) return record.itemId === options.itemId;
      if (options.standalone) return record.itemId === undefined;
      return true;
    })
    .sort((left, right) =>
      left.createdAt === right.createdAt ? left.id.localeCompare(right.id) : left.createdAt.localeCompare(right.createdAt),
    );
}
