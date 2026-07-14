import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseMaterialProviderRegistryManifest } from "../material/registry/load.js";
import { parseRegistryManifest } from "../providers/registry/load.js";
import { sanitizeUrlForDisplay } from "../runtime/sanitizeUrl.js";
import { atomicWriteConfigFile } from "../config/userConfig.js";
import { identityPath, resolveSubscriptionPaths } from "./paths.js";
import type {
  LoadedRegistrySnapshot,
  RegistryCandidateSummary,
  RegistrySnapshotSummary,
  SubscriptionIdentity,
} from "./types.js";

interface FetchedRegistry {
  raw: string;
  registryDigest: string;
  resolvedSource: string;
  candidates: RegistryCandidateSummary[];
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function assertSha(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a 64-character SHA-256`);
  }
  return value.toLowerCase();
}

const SECRET_ARCHIVE_QUERY = /(?:api[-_]?key|token|secret|password|credential|private[-_]?key)/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_SAFE_REDIRECTS = 10;

function assertSafeResolvedRegistryUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Registry redirect must remain on HTTPS");
  if (url.username || url.password || url.hash) {
    throw new Error("Registry redirect must not contain userinfo or a fragment");
  }
  for (const [name] of url.searchParams) {
    if (SECRET_ARCHIVE_QUERY.test(name)) {
      throw new Error(`Registry redirect contains credential-like query parameter: ${name}`);
    }
  }
  return url.toString();
}

async function fetchRegistryResponse(source: string): Promise<{ response: Response; resolvedSource: string }> {
  let current = assertSafeResolvedRegistryUrl(source);
  for (let redirectCount = 0; ; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetch(current, { cache: "no-store", redirect: "manual" });
    } catch (error) {
      throw new Error(`Registry refresh request failed: ${sanitizeUrlForDisplay(current)}`, { cause: error });
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      return {
        response,
        resolvedSource: assertSafeResolvedRegistryUrl(response.url || current),
      };
    }
    if (redirectCount >= MAX_SAFE_REDIRECTS) {
      throw new Error(`Registry refresh exceeded ${MAX_SAFE_REDIRECTS} redirects`);
    }
    const location = response.headers.get("location");
    if (!location) throw new Error(`Registry redirect is missing a Location header: ${response.status}`);
    current = assertSafeResolvedRegistryUrl(new URL(location, current).toString());
  }
}

function assertSafeArchiveRef(value: string, label: string): string {
  if (/^http:/i.test(value)) throw new Error(`${label} must use HTTPS when it is remote`);
  if (/^https:/i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password || url.hash) {
      throw new Error(`${label} must not contain userinfo or a fragment`);
    }
    for (const [name] of url.searchParams) {
      if (SECRET_ARCHIVE_QUERY.test(name)) {
        throw new Error(`${label} contains credential-like query parameter: ${name}`);
      }
    }
    return url.toString();
  }
  if (/^file:/i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search) {
      throw new Error(`${label} file URL must not contain userinfo, a query, or a fragment`);
    }
    return url.toString();
  }
  if (!path.isAbsolute(value) && /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error(`${label} uses an unsupported URL scheme`);
  }
  const query = value.split("?", 2)[1]?.split("#", 1)[0];
  if (query) {
    for (const [name] of new URLSearchParams(query)) {
      if (SECRET_ARCHIVE_QUERY.test(name)) {
        throw new Error(`${label} contains credential-like query parameter: ${name}`);
      }
    }
  }
  return value;
}

function searchCandidates(raw: string): RegistryCandidateSummary[] {
  return parseRegistryManifest(raw).providers.map((entry, index) => {
    const { id, version } = entry;
    const archiveSha256 = assertSha(entry.sha256, `providers[${index}].sha256`);
    const archiveRef = assertSafeArchiveRef(entry.downloadUrl, `providers[${index}].downloadUrl`);
    const minRequiredVersion = typeof entry.minPluginVersion === "string" && entry.minPluginVersion
      ? entry.minPluginVersion
      : undefined;
    return archiveSha256
      ? {
          id,
          version,
          archiveRef,
          archiveSha256,
          status: "available",
          ...(minRequiredVersion ? { minRequiredVersion } : {}),
        }
      : {
          id,
          version,
          archiveRef,
          archiveSha256: null,
          status: "blocked",
          blockedReason: "missing-integrity",
          ...(minRequiredVersion ? { minRequiredVersion } : {}),
        };
  });
}

function materialCandidates(raw: string): RegistryCandidateSummary[] {
  return parseMaterialProviderRegistryManifest(raw).providers.map((entry) => {
    const archiveSha256 = entry.sha256 ?? entry.checksum?.sha256 ?? null;
    const declaredArchiveRef = entry.downloadUrl ?? entry.archiveRef ?? entry.archivePath;
    const archiveRef = declaredArchiveRef
      ? assertSafeArchiveRef(declaredArchiveRef, `provider ${entry.id} archive reference`)
      : undefined;
    const common = {
      id: entry.id,
      version: entry.version,
      ...(entry.kind ? { providerKind: entry.kind } : {}),
      ...(archiveRef ? { archiveRef } : {}),
      ...(entry.minCliVersion || entry.minPluginVersion
        ? { minRequiredVersion: entry.minCliVersion ?? entry.minPluginVersion }
        : {}),
    };
    if (!archiveRef) {
      return {
        ...common,
        archiveSha256,
        status: "blocked" as const,
        blockedReason: "missing-archive" as const,
      };
    }
    return archiveSha256
      ? { ...common, archiveSha256, status: "available" as const }
      : {
          ...common,
          archiveSha256: null,
          status: "blocked" as const,
          blockedReason: "missing-integrity" as const,
        };
  });
}

export function parseRegistryCandidates(
  raw: string,
  runtimeKind: SubscriptionIdentity["runtimeKind"],
): RegistryCandidateSummary[] {
  return runtimeKind === "search" ? searchCandidates(raw) : materialCandidates(raw);
}

export async function fetchAndValidateRegistry(identity: SubscriptionIdentity): Promise<FetchedRegistry> {
  let raw: string;
  let resolvedSource = identity.canonicalSource;
  if (identity.sourceType === "https") {
    const fetched = await fetchRegistryResponse(identity.canonicalSource);
    const response = fetched.response;
    if (!response.ok) throw new Error(`Registry refresh failed: HTTP ${response.status}`);
    raw = await response.text();
    resolvedSource = fetched.resolvedSource;
  } else {
    try {
      raw = await readFile(identity.canonicalSource, "utf8");
    } catch (error) {
      throw new Error(`Registry source unavailable: ${identity.canonicalSource}`, { cause: error });
    }
  }
  const candidates = parseRegistryCandidates(raw, identity.runtimeKind);
  return { raw, registryDigest: sha256(raw), resolvedSource, candidates };
}

function assertSnapshotSummary(
  value: unknown,
  subscriptionId: string,
  identity: SubscriptionIdentity,
  registryDigest: string,
): RegistrySnapshotSummary {
  const summary = value as Partial<RegistrySnapshotSummary>;
  if (
    summary.schemaVersion !== 1 ||
    summary.subscriptionId !== subscriptionId ||
    summary.runtimeKind !== identity.runtimeKind ||
    summary.sourceFingerprint !== identity.sourceFingerprint ||
    summary.registryDigest !== registryDigest ||
    typeof summary.resolvedSource !== "string" ||
    typeof summary.fetchedAt !== "string" ||
    !Array.isArray(summary.candidates)
  ) {
    throw new Error(`Invalid current registry snapshot for subscription: ${subscriptionId}`);
  }
  return summary as RegistrySnapshotSummary;
}

export async function readCurrentRegistrySnapshot(
  subscriptionId: string,
  identity: SubscriptionIdentity,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedRegistrySnapshot | null> {
  const root = path.join(resolveSubscriptionPaths(env).cacheDir, identity.sourceFingerprint);
  let pointerRaw: string;
  try {
    pointerRaw = await readFile(path.join(root, "current.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const pointer = JSON.parse(pointerRaw) as { schemaVersion?: unknown; registryDigest?: unknown };
  if (
    pointer.schemaVersion !== 1 ||
    typeof pointer.registryDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(pointer.registryDigest)
  ) {
    throw new Error(`Invalid current registry pointer for subscription: ${subscriptionId}`);
  }
  if (identity.latestRegistryDigest !== pointer.registryDigest) {
    throw new Error(`Subscription identity and registry pointer disagree: ${subscriptionId}`);
  }
  const snapshotDir = path.join(root, "snapshots", pointer.registryDigest);
  const [raw, summaryRaw] = await Promise.all([
    readFile(path.join(snapshotDir, "registry.json"), "utf8"),
    readFile(path.join(snapshotDir, "summary.json"), "utf8"),
  ]);
  if (sha256(raw) !== pointer.registryDigest) {
    throw new Error(`Registry snapshot digest mismatch for subscription: ${subscriptionId}`);
  }
  const summary = assertSnapshotSummary(
    JSON.parse(summaryRaw),
    subscriptionId,
    identity,
    pointer.registryDigest,
  );
  const candidates = parseRegistryCandidates(raw, identity.runtimeKind);
  return { summary, raw, candidates };
}

export async function writeRegistrySnapshot(
  subscriptionId: string,
  identity: SubscriptionIdentity,
  fetched: FetchedRegistry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegistrySnapshotSummary> {
  const root = path.join(resolveSubscriptionPaths(env).cacheDir, identity.sourceFingerprint);
  const snapshotDir = path.join(root, "snapshots", fetched.registryDigest);
  await mkdir(snapshotDir, { recursive: true });
  const summary: RegistrySnapshotSummary = {
    schemaVersion: 1,
    subscriptionId,
    runtimeKind: identity.runtimeKind,
    sourceFingerprint: identity.sourceFingerprint,
    registryDigest: fetched.registryDigest,
    resolvedSource: fetched.resolvedSource,
    fetchedAt: new Date().toISOString(),
    candidates: fetched.candidates,
  };
  await atomicWriteConfigFile(path.join(snapshotDir, "registry.json"), fetched.raw);
  await atomicWriteConfigFile(
    path.join(snapshotDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  const updatedIdentity: SubscriptionIdentity = {
    ...identity,
    latestRegistryDigest: fetched.registryDigest,
  };
  const identityFile = identityPath(subscriptionId, env);
  await atomicWriteConfigFile(identityFile, `${JSON.stringify(updatedIdentity, null, 2)}\n`, 0o600);
  try {
    // The pointer is the usable-state selector, so advance it only after the
    // matching identity is durable. A handled pointer failure restores the
    // prior identity and leaves the last validated pointer untouched.
    await atomicWriteConfigFile(
      path.join(root, "current.json"),
      `${JSON.stringify({ schemaVersion: 1, registryDigest: fetched.registryDigest, snapshot: snapshotDir }, null, 2)}\n`,
    );
  } catch (error) {
    try {
      await atomicWriteConfigFile(identityFile, `${JSON.stringify(identity, null, 2)}\n`, 0o600);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Registry pointer update failed and subscription identity could not be restored: ${subscriptionId}`,
      );
    }
    throw error;
  }
  return summary;
}
