import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ZoteroItemMapping } from "./types.js";

const MAPPINGS_DIR = "zotero/mappings";
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function mappingPath(workspaceRoot: string, itemId: string): string {
  if (!ITEM_ID_RE.test(itemId) || itemId === "." || itemId === "..") {
    throw new Error(`Invalid workspace item id: ${itemId}`);
  }
  return path.join(path.resolve(workspaceRoot), MAPPINGS_DIR, `${itemId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMapping(value: unknown, itemId: string): ZoteroItemMapping {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.itemId !== itemId) {
    throw new Error(`Invalid Zotero mapping for workspace item ${itemId}`);
  }
  if (typeof value.zoteroItemKey !== "string" || !value.zoteroItemKey) {
    throw new Error(`Invalid Zotero mapping item key for workspace item ${itemId}`);
  }
  if (!isRecord(value.noteKeys) || !isRecord(value.attachments) || typeof value.updatedAt !== "string") {
    throw new Error(`Invalid Zotero mapping payload for workspace item ${itemId}`);
  }
  return value as unknown as ZoteroItemMapping;
}

export async function readZoteroItemMapping(
  workspaceRoot: string,
  itemId: string,
): Promise<ZoteroItemMapping | null> {
  try {
    return parseMapping(JSON.parse(await readFile(mappingPath(workspaceRoot, itemId), "utf8")), itemId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeZoteroItemMapping(
  workspaceRoot: string,
  mapping: ZoteroItemMapping,
): Promise<string> {
  const target = mappingPath(workspaceRoot, mapping.itemId);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(mapping, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, target);
    return target;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
