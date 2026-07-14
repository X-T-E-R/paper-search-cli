import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeUrlForDisplay } from "../runtime/sanitizeUrl.js";
import type { RegistryCandidateSummary, RegistrySnapshotSummary, SubscriptionIdentity } from "../subscriptions/types.js";
import { resolveProviderLifecyclePaths } from "./paths.js";

const SECRET_QUERY_NAME = /(?:api[-_]?key|token|secret|password|credential|private[-_]?key)/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_SAFE_REDIRECTS = 10;

export interface ResolvedProviderArchive {
  sourceType: "https" | "local";
  ref: string;
  displayRef: string;
}

export interface CachedProviderArchive extends ResolvedProviderArchive {
  archiveSha256: string;
  cachePath: string;
  cacheHit: boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertArchiveSha256(value: string | null): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Bound provider archive requires a publisher-declared SHA-256");
  }
  return value;
}

function assertSafeHttpsArchiveUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`Bound provider archive must use HTTPS: ${sanitizeUrlForDisplay(raw)}`);
  if (url.username || url.password || url.hash) {
    throw new Error(`Bound provider archive URL contains forbidden credentials or fragment: ${sanitizeUrlForDisplay(raw)}`);
  }
  for (const [name] of url.searchParams) {
    if (SECRET_QUERY_NAME.test(name)) {
      throw new Error(`Bound provider archive URL contains credential-like query parameter: ${name}`);
    }
  }
  return url.toString();
}

export function resolveProviderArchiveRef(options: {
  identity: SubscriptionIdentity;
  snapshot: RegistrySnapshotSummary;
  candidate: RegistryCandidateSummary;
}): ResolvedProviderArchive {
  const archiveRef = options.candidate.archiveRef;
  if (!archiveRef) throw new Error(`Registry candidate has no archive reference: ${options.candidate.id}`);
  if (/^https?:/i.test(archiveRef)) {
    const ref = assertSafeHttpsArchiveUrl(archiveRef);
    return { sourceType: "https", ref, displayRef: sanitizeUrlForDisplay(ref) };
  }
  if (/^file:/i.test(archiveRef)) {
    if (options.identity.sourceType !== "local") {
      throw new Error(`Remote registry cannot reference a local provider archive: ${options.candidate.id}`);
    }
    const ref = path.resolve(fileURLToPath(archiveRef));
    return { sourceType: "local", ref, displayRef: ref };
  }
  if (options.identity.sourceType === "https") {
    const ref = assertSafeHttpsArchiveUrl(new URL(archiveRef, options.snapshot.resolvedSource).toString());
    return { sourceType: "https", ref, displayRef: sanitizeUrlForDisplay(ref) };
  }
  const ref = path.isAbsolute(archiveRef)
    ? path.resolve(archiveRef)
    : path.resolve(path.dirname(options.identity.canonicalSource), archiveRef);
  return { sourceType: "local", ref, displayRef: ref };
}

async function readVerifiedCache(cachePath: string, expectedSha256: string): Promise<Uint8Array | null> {
  try {
    const bytes = new Uint8Array(await readFile(cachePath));
    if (sha256(bytes) === expectedSha256) return bytes;
    await rm(cachePath, { force: true });
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fetchArchive(source: ResolvedProviderArchive): Promise<Uint8Array> {
  if (source.sourceType === "local") {
    return new Uint8Array(await readFile(source.ref));
  }
  let current = assertSafeHttpsArchiveUrl(source.ref);
  for (let redirectCount = 0; ; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetch(current, { cache: "no-store", redirect: "manual" });
    } catch (error) {
      throw new Error(`Provider archive download failed: ${sanitizeUrlForDisplay(current)}`, { cause: error });
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirectCount >= MAX_SAFE_REDIRECTS) {
        throw new Error(`Provider archive download exceeded ${MAX_SAFE_REDIRECTS} redirects`);
      }
      const location = response.headers.get("location");
      if (!location) throw new Error(`Provider archive redirect is missing a Location header: ${response.status}`);
      current = assertSafeHttpsArchiveUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      throw new Error(`Provider archive download failed: HTTP ${response.status} (${sanitizeUrlForDisplay(current)})`);
    }
    assertSafeHttpsArchiveUrl(response.url || current);
    return new Uint8Array(await response.arrayBuffer());
  }
}

async function cleanupArchiveCache(
  cacheDir: string,
  keepPath: string,
  maxArchives: number,
): Promise<void> {
  if (!Number.isInteger(maxArchives) || maxArchives < 1) return;
  const entries = await readdir(cacheDir, { withFileTypes: true });
  const archives = await Promise.all(entries
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.zip$/.test(entry.name))
    .map(async (entry) => {
      const filePath = path.join(cacheDir, entry.name);
      return { filePath, mtimeMs: (await stat(filePath)).mtimeMs };
    }));
  archives.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const retained = new Set<string>([keepPath]);
  for (const archive of archives) {
    if (retained.size < maxArchives) retained.add(archive.filePath);
  }
  await Promise.all(archives
    .filter((archive) => !retained.has(archive.filePath))
    .map((archive) => rm(archive.filePath, { force: true })));
}

export async function ensureProviderArchiveCached(options: {
  source: ResolvedProviderArchive;
  archiveSha256: string;
  env?: NodeJS.ProcessEnv;
  maxArchives?: number;
}): Promise<CachedProviderArchive> {
  const env = options.env ?? process.env;
  const expectedSha256 = assertArchiveSha256(options.archiveSha256);
  const cacheDir = resolveProviderLifecyclePaths(env).archiveCacheDir;
  const cachePath = path.join(cacheDir, `${expectedSha256}.zip`);
  await mkdir(cacheDir, { recursive: true });
  if (await readVerifiedCache(cachePath, expectedSha256)) {
    return { ...options.source, archiveSha256: expectedSha256, cachePath, cacheHit: true };
  }

  const bytes = await fetchArchive(options.source);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Provider archive SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}`,
    );
  }
  const tempPath = path.join(cacheDir, `.${expectedSha256}.${randomUUID()}.tmp`);
  await writeFile(tempPath, bytes, { flag: "wx", mode: 0o600 });
  try {
    try {
      // The temporary file and cache entry share a directory, so linking
      // publishes complete bytes atomically without replacing another writer.
      await link(tempPath, cachePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readVerifiedCache(cachePath, expectedSha256))) {
        throw new Error(`Concurrent provider archive cache write was invalid: ${cachePath}`);
      }
    }
  } finally {
    await rm(tempPath, { force: true });
  }
  await cleanupArchiveCache(cacheDir, cachePath, options.maxArchives ?? 64);
  return { ...options.source, archiveSha256: expectedSha256, cachePath, cacheHit: false };
}

export async function assertCachedProviderArchive(
  cachePath: string,
  expectedSha256: string,
): Promise<void> {
  const bytes = await readVerifiedCache(path.resolve(cachePath), assertArchiveSha256(expectedSha256));
  if (!bytes) throw new Error(`Verified provider archive is missing from cache: ${path.resolve(cachePath)}`);
}
