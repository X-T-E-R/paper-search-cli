import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "@iarna/toml";
import { isPlainConfigObject, setNestedValue } from "./env.js";
import { resolveConfigBundlePaths, resolveDefaultUserConfigPath } from "./paths.js";
import {
  CredentialsConfigFileSchema,
  UserConfigFileSchema,
  UserConfigSchema,
  type UserConfig,
} from "./schema.js";
import { withLocks } from "../runtime/locks.js";
import { applyCredentialPermissions, type CredentialPermissionReport } from "./permissions.js";

export const CONFIGURABLE_FIXED_KEYS = [
  "providers.registryUrl",
  "providers.installDir",
  "providers.autoUpdate",
  "providers.allowReleaseFallback",
  "workspace.root",
  "workspace.defaultSink",
  "workspace.defaultCollection",
  "server.enabled",
  "server.transport",
  "server.host",
  "server.port",
  "defaults.timeoutMs",
  "defaults.maxResults",
  "output.format",
  "output.locale",
  "output.prettyJson",
  "smoke.enabled",
  "smoke.envVar",
  "search.selection.mode",
  "search.selection.includeIds",
  "search.selection.excludeIds",
  "search.selection.includeDomains",
  "search.selection.excludeDomains",
  "search.selection.includeContentKinds",
  "search.selection.excludeContentKinds",
  "search.selection.includeAccess",
  "search.selection.excludeAccess",
] as const;

export const CONFIGURABLE_DYNAMIC_KEY_PATTERNS = [
  "api.<section>.<key>",
  "platform.<provider>.<key>",
] as const;

export const LEGACY_OWNED_CONFIG_KEYS = [
  "providers.registryUrl",
  "providers.installDir",
] as const;

const KNOWN_DYNAMIC_NON_SECRET_LEAVES = new Set([
  "authMode",
  "baseUrl",
  "email",
  "enabled",
  "endpoint",
  "locale",
  "loginName",
  "maxResults",
  "model",
  "name",
  "timeoutMs",
  "transport",
  "url",
  "userAgent",
  "username",
]);

export type ConfigKeyClassification = "non-secret" | "secret" | "owned" | "ambiguous";
export type ConfigKeyMetadata = Readonly<Record<string, "secret" | "non-secret">>;

export interface UserConfigFile {
  path: string;
  data: UserConfig;
  exists: boolean;
  digest: string;
  legacy: boolean;
}

export interface CredentialsConfigFile {
  path: string;
  data: UserConfig;
  exists: boolean;
  digest: string;
}

export interface FlattenedConfigEntry {
  key: string;
  value: unknown;
}

export interface ConfigWriteOptions {
  expectedDigest?: string;
  metadata?: ConfigKeyMetadata;
  env?: NodeJS.ProcessEnv;
  lockHeld?: boolean;
  lockRoot?: string;
}

export function resolveUserConfigPath(): string {
  return resolveDefaultUserConfigPath();
}

export function resolveCredentialsConfigPath(): string {
  return resolveConfigBundlePaths().credentials;
}

export function digestConfigContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const EMPTY_CONFIG_DIGEST = digestConfigContent("");

export function parseConfigKey(key: string): string[] {
  const segments = key.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`Config key must contain at least one dot: ${key}`);
  }
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
      throw new Error(`Invalid config key segment "${segment}" in ${key}`);
    }
  }
  return segments;
}

export function configKeyToString(pathSegments: readonly string[]): string {
  return pathSegments.join(".");
}

export function isSupportedConfigKey(pathSegments: readonly string[]): boolean {
  const key = configKeyToString(pathSegments);
  if ((CONFIGURABLE_FIXED_KEYS as readonly string[]).includes(key)) return true;
  if (pathSegments[0] === "api" && pathSegments.length >= 3) return true;
  if (pathSegments[0] === "platform" && pathSegments.length >= 3) return true;
  return false;
}

export function assertSupportedConfigKey(key: string): string[] {
  const pathSegments = parseConfigKey(key);
  if (!isSupportedConfigKey(pathSegments)) {
    throw new Error(`Unsupported config key: ${key}`);
  }
  return pathSegments;
}

function normalizeSecretTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1.$2")
    .toLowerCase()
    .split(/[._-]+/)
    .filter(Boolean);
}

export function isSecretConfigKey(pathSegments: readonly string[] | string): boolean {
  const key = typeof pathSegments === "string" ? pathSegments : pathSegments.join(".");
  const tokens = normalizeSecretTokens(key);
  if (tokens.some((token) => ["token", "secret", "password", "credential", "credentials"].includes(token))) {
    return true;
  }
  return tokens.some((token, index) =>
    token === "key" && (tokens[index - 1] === "api" || tokens[index - 1] === "private"),
  );
}

export function classifyConfigKey(
  pathSegments: readonly string[] | string,
  metadata: ConfigKeyMetadata = {},
): ConfigKeyClassification {
  const segments = typeof pathSegments === "string" ? parseConfigKey(pathSegments) : [...pathSegments];
  const key = configKeyToString(segments);
  if ((LEGACY_OWNED_CONFIG_KEYS as readonly string[]).includes(key)) return "owned";
  if ((CONFIGURABLE_FIXED_KEYS as readonly string[]).includes(key)) return "non-secret";
  if (segments[0] !== "api" && segments[0] !== "platform") return "ambiguous";
  const described = metadata[key];
  if (described) return described;
  if (isSecretConfigKey(segments)) return "secret";
  return KNOWN_DYNAMIC_NON_SECRET_LEAVES.has(segments.at(-1) ?? "") ? "non-secret" : "ambiguous";
}

export function assertWritableNonSecretConfigKey(key: string, metadata: ConfigKeyMetadata = {}): string[] {
  const pathSegments = assertSupportedConfigKey(key);
  const classification = classifyConfigKey(pathSegments, metadata);
  if (classification === "secret") {
    throw new Error(`Secret-like config key must be managed with config credentials: ${key}`);
  }
  if (classification === "owned") {
    throw new Error(`Config key is owned by lifecycle migration/subscription commands: ${key}`);
  }
  if (classification === "ambiguous") {
    throw new Error(`Config key cannot be safely classified: ${key}`);
  }
  return pathSegments;
}

export function assertCredentialConfigKey(key: string, metadata: ConfigKeyMetadata = {}): string[] {
  const pathSegments = assertSupportedConfigKey(key);
  const classification = classifyConfigKey(pathSegments, metadata);
  if (classification !== "secret") {
    throw new Error(
      classification === "non-secret"
        ? `Known non-secret key cannot be stored in credentials.toml: ${key}`
        : `Config key cannot be safely classified as a credential: ${key}`,
    );
  }
  return pathSegments;
}

function stripSchemaVersion(document: Record<string, unknown>): UserConfig {
  const { schemaVersion: _schemaVersion, ...config } = document;
  return UserConfigSchema.parse(config);
}

export function parseUserConfigDocument(
  value: unknown,
  options: { allowLegacy?: boolean } = {},
): { data: UserConfig; legacy: boolean } {
  const parsed = UserConfigFileSchema.parse(value);
  if (parsed.schemaVersion === undefined && !options.allowLegacy) {
    throw new Error("Legacy config v0 requires `paper-search migrate`; normal runtime loading accepts schemaVersion = 1 only");
  }
  return {
    data: stripSchemaVersion(parsed as Record<string, unknown>),
    legacy: parsed.schemaVersion === undefined,
  };
}

export function parseCredentialsConfigDocument(
  value: unknown,
  metadata: ConfigKeyMetadata = {},
): UserConfig {
  const parsed = CredentialsConfigFileSchema.parse(value);
  const data = stripSchemaVersion(parsed as Record<string, unknown>);
  for (const entry of flattenUserConfig(data)) {
    if (classifyConfigKey(entry.key, metadata) !== "secret") {
      throw new Error(`credentials.toml contains a non-secret or ambiguous key: ${entry.key}`);
    }
  }
  return data;
}

async function readOptionalText(filePath: string): Promise<{ raw: string; exists: boolean }> {
  try {
    return { raw: await readFile(filePath, "utf8"), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { raw: "", exists: false };
    }
    throw error;
  }
}

export async function readUserConfigFile(filePath = resolveUserConfigPath()): Promise<UserConfigFile> {
  const { raw, exists } = await readOptionalText(filePath);
  if (!exists) {
    return { path: filePath, data: {}, exists: false, digest: EMPTY_CONFIG_DIGEST, legacy: false };
  }
  const parsed = parseUserConfigDocument(parse(raw));
  return {
    path: filePath,
    data: parsed.data,
    exists: true,
    digest: digestConfigContent(raw),
    legacy: parsed.legacy,
  };
}

export async function readCredentialsConfigFile(
  filePath = resolveCredentialsConfigPath(),
  metadata: ConfigKeyMetadata = {},
): Promise<CredentialsConfigFile> {
  const { raw, exists } = await readOptionalText(filePath);
  if (!exists) {
    return { path: filePath, data: {}, exists: false, digest: EMPTY_CONFIG_DIGEST };
  }
  return {
    path: filePath,
    data: parseCredentialsConfigDocument(parse(raw), metadata),
    exists: true,
    digest: digestConfigContent(raw),
  };
}

async function assertExpectedDigest(filePath: string, expectedDigest?: string): Promise<void> {
  if (!expectedDigest) return;
  const { raw } = await readOptionalText(filePath);
  const actualDigest = digestConfigContent(raw);
  if (actualDigest !== expectedDigest) {
    throw new Error(`Config file changed since it was read: ${filePath}`);
  }
}

export function configFileLockScope(filePath: string): string {
  return `config-file/${path.basename(filePath).toLowerCase()}`;
}

export async function withConfigFileLocks<T>(
  filePaths: readonly string[],
  action: () => Promise<T>,
  options: Pick<ConfigWriteOptions, "env" | "lockRoot"> & { command?: string; timeoutMs?: number } = {},
): Promise<T> {
  const ordered = [...new Set(filePaths.map((filePath) => path.resolve(filePath)))]
    .sort((left, right) => left.localeCompare(right))
    .map(configFileLockScope);
  return withLocks(ordered, action, options);
}

export async function atomicWriteConfigFile(
  filePath: string,
  content: string,
  mode?: number,
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
    await rename(temporaryPath, filePath);
    if (mode !== undefined) {
      await chmod(filePath, mode).catch((error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32") throw error;
      });
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function serializeConfigDocument(document: Record<string, unknown>): string {
  const serialized = stringify(document as Record<string, never>).trimEnd();
  return serialized ? `${serialized}\n` : "";
}

export function serializeUserConfigFile(data: UserConfig): string {
  return serializeConfigDocument({ schemaVersion: 1, ...UserConfigSchema.parse(data) });
}

export function serializeCredentialsConfigFile(
  data: UserConfig,
  metadata: ConfigKeyMetadata = {},
): string {
  const parsed = parseCredentialsConfigDocument({ schemaVersion: 1, ...data }, metadata);
  return serializeConfigDocument({ schemaVersion: 1, ...parsed });
}

export async function writeUserConfigFile(
  data: UserConfig,
  filePath = resolveUserConfigPath(),
  options: ConfigWriteOptions = {},
): Promise<void> {
  const parsed = UserConfigSchema.parse(data);
  for (const entry of flattenUserConfig(parsed)) {
    const classification = classifyConfigKey(entry.key, options.metadata);
    if (classification !== "non-secret") {
      throw new Error(`config.toml cannot store ${classification} key: ${entry.key}`);
    }
  }
  const write = async () => {
    // Digest verification deliberately occurs after the mutation lock is held.
    await assertExpectedDigest(filePath, options.expectedDigest);
    await atomicWriteConfigFile(
      filePath,
      serializeUserConfigFile(parsed),
    );
  };
  if (options.lockHeld) await write();
  else await withConfigFileLocks([filePath], write, { env: options.env, lockRoot: options.lockRoot, command: "config write" });
}

export async function writeCredentialsConfigFile(
  data: UserConfig,
  filePath = resolveCredentialsConfigPath(),
  options: ConfigWriteOptions = {},
): Promise<CredentialPermissionReport> {
  const parsed = parseCredentialsConfigDocument({ schemaVersion: 1, ...data }, options.metadata);
  let permissions: CredentialPermissionReport | undefined;
  const write = async () => {
    await assertExpectedDigest(filePath, options.expectedDigest);
    await atomicWriteConfigFile(filePath, serializeConfigDocument({ schemaVersion: 1, ...parsed }), 0o600);
    permissions = await applyCredentialPermissions(filePath);
  };
  if (options.lockHeld) await write();
  else await withConfigFileLocks([filePath], write, { env: options.env, lockRoot: options.lockRoot, command: "credentials write" });
  return permissions!;
}

export function getConfigValue(data: UserConfig, pathSegments: readonly string[]): unknown {
  let cursor: unknown = data;
  for (const segment of pathSegments) {
    if (!isPlainConfigObject(cursor) || !(segment in cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

export function setUserConfigValue(
  data: UserConfig,
  pathSegments: readonly string[],
  value: unknown,
): UserConfig {
  const next = structuredClone(data) as Record<string, unknown>;
  setNestedValue(next, pathSegments, value);
  return UserConfigSchema.parse(next);
}

function deleteNestedValue(target: Record<string, unknown>, pathSegments: readonly string[]): boolean {
  const segment = pathSegments[0];
  if (!segment) return false;

  if (pathSegments.length === 1) {
    if (!(segment in target)) return false;
    delete target[segment];
    return true;
  }

  const child = target[segment];
  if (!isPlainConfigObject(child)) return false;
  const removed = deleteNestedValue(child, pathSegments.slice(1));
  if (removed && Object.keys(child).length === 0) {
    delete target[segment];
  }
  return removed;
}

export function unsetUserConfigValue(
  data: UserConfig,
  pathSegments: readonly string[],
): { data: UserConfig; removed: boolean } {
  const next = structuredClone(data) as Record<string, unknown>;
  const removed = deleteNestedValue(next, pathSegments);
  return { data: UserConfigSchema.parse(next), removed };
}

export function flattenUserConfig(data: UserConfig): FlattenedConfigEntry[] {
  const entries: FlattenedConfigEntry[] = [];

  function visit(value: unknown, prefix: string[]): void {
    if (!isPlainConfigObject(value)) {
      entries.push({ key: prefix.join("."), value });
      return;
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      visit(nestedValue, [...prefix, key]);
    }
  }

  visit(data, []);
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

export function maskConfigValue(value: unknown, key: string, raw = false): {
  value: unknown;
  masked: boolean;
} {
  if (raw || !isSecretConfigKey(key) || value === undefined || value === null) {
    return { value, masked: false };
  }
  return { value: "********", masked: true };
}
