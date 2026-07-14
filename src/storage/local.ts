import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { LocalStorageArea, LocalStorageRefV1 } from "./types.js";

export class LocalStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStorageError";
  }
}

function fail(message: string): never {
  throw new LocalStorageError(message);
}

function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  fail(`${label} escapes local storage root`);
}

export function normalizeLocalStorageKey(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("Local storage key must be a non-empty portable relative path");
  }
  const portable = value.replaceAll("\\", "/");
  if (
    portable.startsWith("/") ||
    /^[A-Za-z]:/u.test(portable) ||
    portable.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`Unsafe local storage key: ${value}`);
  }
  return portable;
}

export function parseLocalStorageRef(value: unknown, label = "storage"): LocalStorageRefV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || candidate.sink !== "local") {
    fail(`${label} must be a LocalStorageRefV1`);
  }
  if (candidate.area !== "artifact" && candidate.area !== "extraction" && candidate.area !== "export") {
    fail(`${label}.area must be artifact | extraction | export`);
  }
  if (typeof candidate.root !== "string" || !path.isAbsolute(candidate.root)) {
    fail(`${label}.root must be an absolute path`);
  }
  const key = normalizeLocalStorageKey(String(candidate.key ?? ""));
  if (candidate.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(String(candidate.sha256))) {
    fail(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (
    candidate.sizeBytes !== undefined &&
    (typeof candidate.sizeBytes !== "number" || !Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes < 0)
  ) {
    fail(`${label}.sizeBytes must be a non-negative safe integer`);
  }
  return {
    schemaVersion: 1,
    sink: "local",
    area: candidate.area,
    root: path.resolve(candidate.root),
    key,
    ...(candidate.sha256 !== undefined ? { sha256: String(candidate.sha256) } : {}),
    ...(candidate.sizeBytes !== undefined ? { sizeBytes: candidate.sizeBytes } : {}),
  };
}

async function ensureSafeTarget(root: string, key: string): Promise<{ root: string; target: string }> {
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, ...normalizeLocalStorageKey(key).split("/"));
  assertInside(normalizedRoot, target, "Local storage target");
  await mkdir(normalizedRoot, { recursive: true });
  const rootStat = await lstat(normalizedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("Local storage root must be a real directory");
  const rootReal = await realpath(normalizedRoot);
  const relativeParent = path.relative(normalizedRoot, path.dirname(target));
  let current = normalizedRoot;
  for (const segment of relativeParent ? relativeParent.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const currentStat = await lstat(current);
      if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
        fail(`Local storage parent must be a real directory: ${segment}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
    assertInside(rootReal, await realpath(current), "Local storage target parent");
  }
  const parentReal = await realpath(path.dirname(target));
  assertInside(rootReal, parentReal, "Local storage target parent");
  try {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) fail(`Local storage target must not be a symlink: ${key}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { root: normalizedRoot, target };
}

export async function resolveLocalStorageRef(ref: LocalStorageRefV1): Promise<string> {
  const parsed = parseLocalStorageRef(ref);
  const root = path.resolve(parsed.root);
  const target = path.resolve(root, ...parsed.key.split("/"));
  assertInside(root, target, "Local storage reference");
  try {
    const [rootReal, parentReal] = await Promise.all([realpath(root), realpath(path.dirname(target))]);
    assertInside(rootReal, parentReal, "Local storage reference parent");
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) fail(`Local storage reference target must not be a symlink: ${parsed.key}`);
    const targetReal = await realpath(target);
    assertInside(rootReal, targetReal, "Local storage reference");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
    throw error;
  }
  return target;
}

/** Resolve an unchanged legacy workspace-relative path without treating it as a storage ref. */
export async function resolveLegacyWorkspacePath(workspaceRoot: string, legacyPath: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const key = normalizeLocalStorageKey(legacyPath);
  const target = path.resolve(root, ...key.split("/"));
  assertInside(root, target, "Legacy workspace path");
  try {
    const [rootReal, parentReal] = await Promise.all([realpath(root), realpath(path.dirname(target))]);
    assertInside(rootReal, parentReal, "Legacy workspace path parent");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

export async function writeLocalStorageBytes(options: {
  root: string;
  key: string;
  area: LocalStorageArea;
  bytes: Uint8Array;
}): Promise<{ ref: LocalStorageRefV1; path: string }> {
  const key = normalizeLocalStorageKey(options.key);
  const { root, target } = await ensureSafeTarget(options.root, key);
  const stagingDir = path.join(root, ".staging");
  await mkdir(stagingDir, { recursive: true });
  const stagingStat = await lstat(stagingDir);
  if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
    fail("Local storage staging path must be a real directory");
  }
  const stagingReal = await realpath(stagingDir);
  assertInside(await realpath(root), stagingReal, "Local storage staging directory");
  const stagingPath = path.join(stagingDir, `${randomUUID()}.tmp`);
  const handle = await open(stagingPath, "wx", 0o600);
  let stagingError: unknown;
  try {
    await handle.writeFile(options.bytes);
    await handle.sync();
  } catch (error) {
    stagingError = error;
  } finally {
    await handle.close();
  }
  if (stagingError !== undefined) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    throw stagingError;
  }

  try {
    try {
      await lstat(target);
      fail(`Local storage target already exists: ${key}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // `rename` replaces an existing file on POSIX.  The preceding `lstat` is
    // useful for diagnostics, but cannot make the placement race-free.  A
    // hard link is an atomic create-if-absent operation when source and target
    // share this storage root, so it preserves the no-overwrite contract.
    await link(stagingPath, target);
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
  // Placement is already durable. A best-effort staging cleanup must not turn a
  // successful commit into an unreported orphaned result.
  await rm(stagingPath, { force: true }).catch(() => undefined);

  const bytes = Buffer.from(options.bytes);
  return {
    path: target,
    ref: {
      schemaVersion: 1,
      sink: "local",
      area: options.area,
      root,
      key,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
    },
  };
}
