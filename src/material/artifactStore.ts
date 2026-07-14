import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactAttempt, ArtifactProvenance, ArtifactRecord } from "./records.js";
import { parseLocalStorageRef, resolveLegacyWorkspacePath, resolveLocalStorageRef } from "../storage/local.js";

export type { ArtifactRecord } from "./records.js";

export const ARTIFACT_RECORDS_DIR = "material/artifacts";

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ArtifactRecordStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactRecordStoreError";
  }
}

export type CreateArtifactRecordInput = Omit<ArtifactRecord, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

export interface ListArtifactRecordsOptions {
  /** Return only records attached to this workspace item id. */
  itemId?: string;
  /** Return only records that are not attached to any workspace item. */
  standalone?: boolean;
}

function fail(message: string): never {
  throw new ArtifactRecordStoreError(message);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function assertArtifactId(id: string): string {
  if (!ARTIFACT_ID_RE.test(id) || id === "." || id === "..") {
    fail(`Invalid artifact record id: ${id}`);
  }
  return id;
}

function artifactRecordPath(root: string, id: string): string {
  return path.join(path.resolve(root), ARTIFACT_RECORDS_DIR, `${assertArtifactId(id)}.json`);
}

async function ensureArtifactRecordDir(root: string): Promise<void> {
  await mkdir(path.join(path.resolve(root), ARTIFACT_RECORDS_DIR), { recursive: true });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function assertOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be a finite number`);
  return value;
}

function parseArtifactProvenance(value: unknown): ArtifactProvenance {
  if (!isPlainObject(value)) fail("provenance must be an object");
  const origin = value.origin;
  if (origin !== "download" && origin !== "user_supplied" && origin !== "resolved") {
    fail("provenance.origin must be download | user_supplied | resolved");
  }
  return {
    origin,
    ...(value.sourceUrl !== undefined ? { sourceUrl: assertOptionalString(value.sourceUrl, "provenance.sourceUrl") } : {}),
    ...(value.providerId !== undefined
      ? { providerId: assertOptionalString(value.providerId, "provenance.providerId") }
      : {}),
    ...(value.policy !== undefined ? { policy: assertOptionalString(value.policy, "provenance.policy") } : {}),
    ...(value.resolvedFrom !== undefined
      ? { resolvedFrom: assertOptionalString(value.resolvedFrom, "provenance.resolvedFrom") }
      : {}),
    ...(value.resolverProviderId !== undefined
      ? { resolverProviderId: assertOptionalString(value.resolverProviderId, "provenance.resolverProviderId") }
      : {}),
    ...(value.resolverSource !== undefined
      ? { resolverSource: assertOptionalString(value.resolverSource, "provenance.resolverSource") }
      : {}),
  };
}

function parseArtifactAttempt(value: unknown, index: number): ArtifactAttempt {
  if (!isPlainObject(value)) fail(`attempts[${index}] must be an object`);
  const ok = value.ok;
  if (typeof ok !== "boolean") fail(`attempts[${index}].ok must be a boolean`);
  return {
    tier: assertString(value.tier, `attempts[${index}].tier`),
    ...(value.source !== undefined ? { source: assertOptionalString(value.source, `attempts[${index}].source`) } : {}),
    ...(value.providerId !== undefined
      ? { providerId: assertOptionalString(value.providerId, `attempts[${index}].providerId`) }
      : {}),
    ok,
    ...(value.status !== undefined ? { status: assertOptionalNumber(value.status, `attempts[${index}].status`) } : {}),
    ...(value.message !== undefined ? { message: assertOptionalString(value.message, `attempts[${index}].message`) } : {}),
    at: assertString(value.at, `attempts[${index}].at`),
  };
}

function parseArtifactRecord(value: unknown): ArtifactRecord {
  if (!isPlainObject(value)) fail("artifact record must be an object");
  const kind = value.kind;
  if (kind !== "pdf" && kind !== "html" && kind !== "office" && kind !== "image" && kind !== "bytes" && kind !== "auto") {
    fail("kind must be pdf | html | office | image | bytes | auto");
  }
  const status = value.status;
  if (status !== "recorded" && status !== "downloaded" && status !== "requested" && status !== "failed") {
    fail("status must be recorded | downloaded | requested | failed");
  }
  if (!Array.isArray(value.attempts)) fail("attempts must be an array");
  const storage = value.storage !== undefined ? parseLocalStorageRef(value.storage, "storage") : undefined;
  if (storage && storage.area !== "artifact") fail("storage.area must be artifact");
  return {
    id: assertArtifactId(assertString(value.id, "id")),
    kind,
    status,
    ...(value.itemId !== undefined ? { itemId: assertOptionalString(value.itemId, "itemId") } : {}),
    ...(value.filename !== undefined ? { filename: assertOptionalString(value.filename, "filename") } : {}),
    ...(value.contentType !== undefined ? { contentType: assertOptionalString(value.contentType, "contentType") } : {}),
    ...(value.path !== undefined ? { path: assertOptionalString(value.path, "path") } : {}),
    ...(storage ? { storage } : {}),
    ...(value.remoteUrl !== undefined ? { remoteUrl: assertOptionalString(value.remoteUrl, "remoteUrl") } : {}),
    ...(value.sizeBytes !== undefined ? { sizeBytes: assertOptionalNumber(value.sizeBytes, "sizeBytes") } : {}),
    provenance: parseArtifactProvenance(value.provenance),
    attempts: value.attempts.map(parseArtifactAttempt),
    ...(value.message !== undefined ? { message: assertOptionalString(value.message, "message") } : {}),
    createdAt: assertString(value.createdAt, "createdAt"),
  };
}

export async function createArtifactRecord(
  workspaceRoot: string,
  input: CreateArtifactRecordInput,
): Promise<ArtifactRecord> {
  await ensureArtifactRecordDir(workspaceRoot);
  const record = parseArtifactRecord({
    ...input,
    id: input.id ?? randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  const target = artifactRecordPath(workspaceRoot, record.id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    try {
      await lstat(target);
      fail(`Artifact record already exists: ${record.id}`);
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

export async function readArtifactRecord(
  workspaceRoot: string,
  artifactId: string,
): Promise<ArtifactRecord | null> {
  try {
    return parseArtifactRecord(JSON.parse(await readFile(artifactRecordPath(workspaceRoot, artifactId), "utf8")));
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

/** Resolve new captured storage refs first; legacy paths keep workspace-relative meaning. */
export async function resolveArtifactRecordPath(
  workspaceRoot: string,
  record: ArtifactRecord,
): Promise<string | null> {
  if (record.storage) return resolveLocalStorageRef(record.storage);
  if (record.path) return resolveLegacyWorkspacePath(workspaceRoot, record.path);
  return null;
}

export async function listArtifactRecords(
  workspaceRoot: string,
  options: ListArtifactRecordsOptions = {},
): Promise<ArtifactRecord[]> {
  if (options.itemId && options.standalone) {
    fail("listArtifactRecords cannot filter by itemId and standalone at the same time");
  }

  let entries;
  try {
    entries = await readdir(path.join(path.resolve(workspaceRoot), ARTIFACT_RECORDS_DIR), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => readArtifactRecord(workspaceRoot, path.basename(entry.name, ".json"))),
  );

  return records
    .filter((record): record is ArtifactRecord => {
      if (!record) return false;
      if (options.itemId) return record.itemId === options.itemId;
      if (options.standalone) return record.itemId === undefined;
      return true;
    })
    .sort((left, right) =>
      left.createdAt === right.createdAt ? left.id.localeCompare(right.id) : left.createdAt.localeCompare(right.createdAt),
    );
}
