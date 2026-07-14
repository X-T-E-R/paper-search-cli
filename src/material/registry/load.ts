import { readFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeUrlForDisplay } from "../../runtime/sanitizeUrl.js";
import { MATERIAL_PROVIDER_KINDS, type MaterialProviderKind } from "../types.js";

export class MaterialProviderRegistryLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MaterialProviderRegistryLoadError";
  }
}

export interface MaterialProviderRegistryChecksum {
  sha256?: string;
}

export interface MaterialProviderRegistryEntry {
  id: string;
  version: string;
  /** Material provider subtype. This is not the runtime kind (`material`). */
  kind?: MaterialProviderKind;
  downloadUrl?: string;
  packagePath?: string;
  archivePath?: string;
  archiveRef?: string;
  sha256?: string;
  checksum?: MaterialProviderRegistryChecksum;
  minCliVersion?: string;
  minPluginVersion?: string;
}

export interface MaterialProviderRegistryManifest {
  providers: MaterialProviderRegistryEntry[];
}

export interface LoadedMaterialProviderRegistryManifest {
  source: string;
  resolvedFrom: string;
  kind: "local" | "remote";
  /** Local registry directory or remote registry URL used for relative refs. */
  baseDir: string;
  manifest: MaterialProviderRegistryManifest;
}

function fail(message: string): never {
  throw new MaterialProviderRegistryLoadError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function assertOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return assertNonEmptyString(value, label);
}

function assertProviderId(value: unknown, label: string): string {
  const id = assertNonEmptyString(value, label);
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id)) {
    fail(`${label} must match /^[a-z][a-z0-9_-]{1,63}$/`);
  }
  return id;
}

function assertSemverLike(value: unknown, label: string): string {
  const version = assertNonEmptyString(value, label);
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    fail(`${label} must be semver-like (e.g. 1.0.0)`);
  }
  return version;
}

function assertOptionalSha256(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const sha256 = assertNonEmptyString(value, label);
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    fail(`${label} must be 64 hex chars`);
  }
  return sha256.toLowerCase();
}

function parseChecksum(value: unknown, label: string): MaterialProviderRegistryChecksum | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const sha256 = assertOptionalSha256(value.sha256, `${label}.sha256`);
  return sha256 ? { sha256 } : {};
}

function parseRegistryEntry(value: unknown, index: number): MaterialProviderRegistryEntry {
  const label = `providers[${index}]`;
  if (!isPlainObject(value)) fail(`${label} must be an object`);

  const id = assertProviderId(value.id, `${label}.id`);
  const version = assertSemverLike(value.version, `${label}.version`);
  let kind: MaterialProviderKind | undefined;
  if (value.kind !== undefined) {
    const candidate = assertNonEmptyString(value.kind, `${label}.kind`);
    if (!MATERIAL_PROVIDER_KINDS.includes(candidate as MaterialProviderKind)) {
      fail(`${label}.kind must be one of: ${MATERIAL_PROVIDER_KINDS.join(", ")}`);
    }
    kind = candidate as MaterialProviderKind;
  }
  const downloadUrl = assertOptionalString(value.downloadUrl, `${label}.downloadUrl`);
  const packagePath = assertOptionalString(value.packagePath, `${label}.packagePath`);
  const archivePath = assertOptionalString(value.archivePath, `${label}.archivePath`);
  const archiveRef = assertOptionalString(value.archiveRef, `${label}.archiveRef`);
  const sha256 = assertOptionalSha256(value.sha256, `${label}.sha256`);
  const checksum = parseChecksum(value.checksum, `${label}.checksum`);
  const minCliVersion =
    value.minCliVersion === undefined
      ? undefined
      : assertSemverLike(value.minCliVersion, `${label}.minCliVersion`);
  const minPluginVersion =
    value.minPluginVersion === undefined
      ? undefined
      : assertSemverLike(value.minPluginVersion, `${label}.minPluginVersion`);

  if (!downloadUrl && !packagePath && !archivePath && !archiveRef) {
    fail(`${label} must include downloadUrl, packagePath, archivePath, or archiveRef`);
  }

  return {
    id,
    version,
    ...(kind ? { kind } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(packagePath ? { packagePath } : {}),
    ...(archivePath ? { archivePath } : {}),
    ...(archiveRef ? { archiveRef } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(checksum ? { checksum } : {}),
    ...(minCliVersion ? { minCliVersion } : {}),
    ...(minPluginVersion ? { minPluginVersion } : {}),
  };
}

/** Registry min-version gate: prefer minCliVersion, fall back to legacy minPluginVersion. */
export function materialRegistryMinRequiredVersion(
  entry: MaterialProviderRegistryEntry,
): string | undefined {
  return entry.minCliVersion ?? entry.minPluginVersion;
}

export function parseMaterialProviderRegistryManifest(
  raw: string,
): MaterialProviderRegistryManifest {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    fail("material provider registry is not valid JSON");
  }

  if (!isPlainObject(data)) fail("material provider registry root must be an object");
  if (!Array.isArray(data.providers)) fail("providers must be an array");

  const seen = new Set<string>();
  const providers = data.providers.map((entry, index) => {
    const parsed = parseRegistryEntry(entry, index);
    if (seen.has(parsed.id)) fail(`duplicate provider id: ${parsed.id}`);
    seen.add(parsed.id);
    return parsed;
  });

  return { providers };
}

export async function loadMaterialProviderRegistryManifest(
  source: string,
): Promise<LoadedMaterialProviderRegistryManifest> {
  if (/^https?:\/\//i.test(source)) {
    let response: Response;
    try {
      response = await fetch(source, { cache: "no-store" });
    } catch (error) {
      throw new MaterialProviderRegistryLoadError(
        `Unable to read material provider registry at ${sanitizeUrlForDisplay(source)}: request failed`,
        { cause: error },
      );
    }
    if (!response.ok) {
      fail(
        `Unable to read material provider registry at ${sanitizeUrlForDisplay(source)}: HTTP ${response.status}`,
      );
    }
    let manifest: MaterialProviderRegistryManifest;
    try {
      manifest = parseMaterialProviderRegistryManifest(await response.text());
    } catch (error) {
      throw new MaterialProviderRegistryLoadError(
        `${sanitizeUrlForDisplay(source)}: ${formatError(error)}`,
        { cause: error },
      );
    }
    return {
      source: sanitizeUrlForDisplay(source),
      resolvedFrom: sanitizeUrlForDisplay(source),
      kind: "remote",
      baseDir: source,
      manifest,
    };
  }

  const resolved = path.resolve(source);
  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (error) {
    throw new MaterialProviderRegistryLoadError(
      `Unable to read material provider registry at ${resolved}: ${formatError(error)}`,
      { cause: error },
    );
  }

  return {
    source,
    resolvedFrom: resolved,
    kind: "local",
    baseDir: path.dirname(resolved),
    manifest: parseMaterialProviderRegistryManifest(raw),
  };
}

export function resolveMaterialRegistryPackagePath(
  registry: LoadedMaterialProviderRegistryManifest,
  packagePath: string,
): string {
  if (registry.kind === "remote") {
    fail("Remote material registries cannot reference directory packages");
  }
  if (path.isAbsolute(packagePath)) return path.resolve(packagePath);
  return path.resolve(registry.baseDir, packagePath);
}

export function resolveMaterialRegistryArchiveRef(
  registry: LoadedMaterialProviderRegistryManifest,
  entry: MaterialProviderRegistryEntry,
): string | undefined {
  const archiveRef = entry.downloadUrl ?? entry.archiveRef ?? entry.archivePath;
  if (!archiveRef) return undefined;
  if (/^https?:\/\//i.test(archiveRef)) return archiveRef;
  if (registry.kind === "remote") return new URL(archiveRef, registry.baseDir).toString();
  if (path.isAbsolute(archiveRef)) return path.resolve(archiveRef);
  return path.resolve(registry.baseDir, archiveRef);
}

export async function loadMaterialRegistryArchive(
  registry: LoadedMaterialProviderRegistryManifest,
  entry: MaterialProviderRegistryEntry,
): Promise<{ resolvedRef: string; bytes: Uint8Array }> {
  const resolvedRef = resolveMaterialRegistryArchiveRef(registry, entry);
  if (!resolvedRef) fail(`registry entry ${entry.id} has no archive ref`);

  if (/^https?:\/\//i.test(resolvedRef)) {
    let response: Response;
    try {
      response = await fetch(resolvedRef, { cache: "no-store" });
    } catch (error) {
      throw new MaterialProviderRegistryLoadError(
        `Download failed for ${entry.id}: network request failed`,
        { cause: error },
      );
    }
    if (!response.ok) fail(`Download failed for ${entry.id}: HTTP ${response.status}`);
    return {
      resolvedRef: sanitizeUrlForDisplay(resolvedRef),
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }

  return {
    resolvedRef,
    bytes: new Uint8Array(await readFile(resolvedRef)),
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
