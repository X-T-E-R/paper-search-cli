import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@iarna/toml";
import { DEFAULT_CONFIG } from "./defaults.js";
import {
  collectEnvOverrides,
  envNameToConfigPath,
  isPlainConfigObject,
} from "./env.js";
import {
  expandHome,
  resolveConfigBundlePaths,
  resolveExplicitConfigPath,
  resolveProjectConfigCandidates,
} from "./paths.js";
import { loadInstalledProviderConfigMetadata } from "./providerDescriptors.js";
import {
  ResolvedConfigSchema,
  SubscriptionsConfigFileSchema,
  type ResolvedConfig,
  type UserConfig,
} from "./schema.js";
import {
  classifyConfigKey,
  flattenUserConfig,
  parseCredentialsConfigDocument,
  parseUserConfigDocument,
  type ConfigKeyMetadata,
} from "./userConfig.js";

export interface LoadConfigOptions {
  cwd?: string;
  explicitConfigPath?: string;
}

export interface ValidatedConfigFile {
  kind: "config" | "subscriptions" | "credentials" | "project" | "explicit";
  path: string;
  exists: boolean;
  legacy: boolean;
}

interface LoadedConfigFile {
  path: string;
  data: UserConfig;
  legacy: boolean;
  originKind: "user" | "project" | "explicit" | "credentials";
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainConfigObject(base) || !isPlainConfigObject(patch)) {
    return patch as T;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    if (isPlainConfigObject(existing) && isPlainConfigObject(value)) {
      result[key] = deepMerge(existing, value);
      continue;
    }
    result[key] = value;
  }
  return result as T;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveConfigRelativePaths(config: UserConfig, filePath: string): UserConfig {
  const baseDir = path.dirname(filePath);
  const next: UserConfig = structuredClone(config);

  if (next.providers?.installDir) {
    const expanded = expandHome(next.providers.installDir);
    next.providers.installDir = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(baseDir, expanded);
  }

  if (next.workspace?.root) {
    const expanded = expandHome(next.workspace.root);
    next.workspace.root = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
  }

  return next;
}

function assertSafeNonSecretLayer(
  data: UserConfig,
  filePath: string,
  options: {
    allowLegacyUserSecrets: boolean;
    allowLifecycleOwnedCompatibility?: boolean;
    metadata?: ConfigKeyMetadata;
  },
): void {
  if (options.allowLegacyUserSecrets) return;
  for (const entry of flattenUserConfig(data)) {
    const classification = classifyConfigKey(entry.key, options.metadata);
    if (classification === "secret") {
      throw new Error(`Secret-like key is forbidden in non-secret config ${filePath}: ${entry.key}`);
    }
    if (classification === "owned" && !options.allowLifecycleOwnedCompatibility) {
      throw new Error(`Machine/subscription-owned key is forbidden in this config layer ${filePath}: ${entry.key}`);
    }
  }
}

async function loadNonSecretTomlConfig(
  filePath: string,
  originKind: "user" | "project" | "explicit",
  metadata: ConfigKeyMetadata = {},
): Promise<LoadedConfigFile | null> {
  if (!(await fileExists(filePath))) return null;
  const raw = await readFile(filePath, "utf8");
  const parsed = parseUserConfigDocument(parse(raw), { allowLegacy: originKind !== "user" });
  assertSafeNonSecretLayer(parsed.data, filePath, {
    allowLegacyUserSecrets: originKind === "user" && parsed.legacy,
    // Project/explicit values remain one-off compatibility overrides. Loader
    // acceptance never promotes them into a trusted subscription or migration
    // authority.
    allowLifecycleOwnedCompatibility:
      originKind === "project" || originKind === "explicit" || parsed.legacy,
    metadata,
  });
  return {
    path: filePath,
    data: resolveConfigRelativePaths(parsed.data, filePath),
    legacy: parsed.legacy,
    originKind,
  };
}

async function loadCredentialsTomlConfig(
  filePath: string,
  metadata: ConfigKeyMetadata = {},
): Promise<LoadedConfigFile | null> {
  if (!(await fileExists(filePath))) return null;
  const raw = await readFile(filePath, "utf8");
  return {
    path: filePath,
    data: parseCredentialsConfigDocument(parse(raw), metadata),
    legacy: false,
    originKind: "credentials",
  };
}

function normalizeResolvedConfigPaths(
  config: Omit<ResolvedConfig, "meta">,
  cwd: string,
): Omit<ResolvedConfig, "meta"> {
  const next = structuredClone(config);
  const installDir = expandHome(next.providers.installDir);
  next.providers.installDir = path.isAbsolute(installDir)
    ? installDir
    : path.resolve(cwd, installDir);

  const workspaceRoot = expandHome(next.workspace.root);
  next.workspace.root = path.isAbsolute(workspaceRoot)
    ? workspaceRoot
    : path.resolve(cwd, workspaceRoot);

  return next;
}

function recordOrigins(
  origins: Record<string, { kind: "default" | "user" | "project" | "explicit" | "credentials" | "env"; source: string }>,
  data: UserConfig,
  kind: "default" | "user" | "project" | "explicit" | "credentials",
  source: string,
): void {
  for (const entry of flattenUserConfig(data)) {
    origins[entry.key] = { kind, source };
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const bundlePaths = resolveConfigBundlePaths();
  const userConfigPath = bundlePaths.config;
  const projectCandidates = resolveProjectConfigCandidates(cwd);
  const explicitConfigPath = options.explicitConfigPath
    ? resolveExplicitConfigPath(options.explicitConfigPath, cwd)
    : null;

  const loaded: LoadedConfigFile[] = [];
  const userConfig = await loadNonSecretTomlConfig(userConfigPath, "user");
  if (userConfig) loaded.push(userConfig);

  const provisionalConfig = normalizeResolvedConfigPaths(
    deepMerge(
      structuredClone(DEFAULT_CONFIG) as Omit<ResolvedConfig, "meta">,
      userConfig?.data ?? {},
    ),
    cwd,
  );
  const providerMetadata = await loadInstalledProviderConfigMetadata(provisionalConfig.providers.installDir);
  if (userConfig && !userConfig.legacy) {
    assertSafeNonSecretLayer(userConfig.data, userConfig.path, {
      allowLegacyUserSecrets: false,
      metadata: providerMetadata,
    });
  }

  const loadedProjectFiles: LoadedConfigFile[] = [];
  for (const candidate of projectCandidates) {
    const config = await loadNonSecretTomlConfig(candidate, "project", providerMetadata);
    if (config) {
      loaded.push(config);
      loadedProjectFiles.push(config);
    }
  }

  if (explicitConfigPath) {
    const explicitConfig = await loadNonSecretTomlConfig(explicitConfigPath, "explicit", providerMetadata);
    if (!explicitConfig) {
      throw new Error(`Config file not found: ${explicitConfigPath}`);
    }
    loaded.push(explicitConfig);
  }

  const credentials = await loadCredentialsTomlConfig(bundlePaths.credentials, providerMetadata);
  if (credentials) loaded.push(credentials);

  let merged = structuredClone(DEFAULT_CONFIG) as Omit<ResolvedConfig, "meta">;
  const origins: Record<string, { kind: "default" | "user" | "project" | "explicit" | "credentials" | "env"; source: string }> = {};
  recordOrigins(origins, DEFAULT_CONFIG as UserConfig, "default", "built-in defaults");
  for (const config of loaded) {
    merged = deepMerge(merged, config.data);
    recordOrigins(origins, config.data, config.originKind, config.path);
  }

  const envOverrides = collectEnvOverrides(process.env);
  merged = deepMerge(merged, envOverrides.patch);
  for (const envName of envOverrides.applied) {
    const pathSegments = envNameToConfigPath(envName);
    if (pathSegments) {
      origins[pathSegments.join(".")] = { kind: "env", source: envName };
    }
  }
  merged = normalizeResolvedConfigPaths(merged, cwd);

  const warnings = loadedProjectFiles.length > 1
    ? [
        `Both project config candidates are present; compatibility merge order is ${loadedProjectFiles.map((entry) => entry.path).join(" then ")}`,
      ]
    : [];

  return ResolvedConfigSchema.parse({
    ...merged,
    meta: {
      cwd,
      userConfigPath,
      projectConfigPath: loadedProjectFiles[0]?.path ?? null,
      explicitConfigPath,
      loadedFiles: loaded.map((entry) => entry.path),
      appliedEnvOverrides: envOverrides.applied,
      origins,
      warnings,
    },
  });
}

export async function validateConfigFiles(options: LoadConfigOptions = {}): Promise<ValidatedConfigFile[]> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const bundlePaths = resolveConfigBundlePaths();
  const results: ValidatedConfigFile[] = [];

  const user = await loadNonSecretTomlConfig(bundlePaths.config, "user");
  results.push({ kind: "config", path: bundlePaths.config, exists: Boolean(user), legacy: user?.legacy ?? false });
  const provisionalConfig = normalizeResolvedConfigPaths(
    deepMerge(
      structuredClone(DEFAULT_CONFIG) as Omit<ResolvedConfig, "meta">,
      user?.data ?? {},
    ),
    cwd,
  );
  const providerMetadata = await loadInstalledProviderConfigMetadata(provisionalConfig.providers.installDir);
  if (user && !user.legacy) {
    assertSafeNonSecretLayer(user.data, user.path, {
      allowLegacyUserSecrets: false,
      metadata: providerMetadata,
    });
  }

  if (await fileExists(bundlePaths.subscriptions)) {
    SubscriptionsConfigFileSchema.parse(parse(await readFile(bundlePaths.subscriptions, "utf8")));
    results.push({ kind: "subscriptions", path: bundlePaths.subscriptions, exists: true, legacy: false });
  } else {
    results.push({ kind: "subscriptions", path: bundlePaths.subscriptions, exists: false, legacy: false });
  }

  const credentials = await loadCredentialsTomlConfig(bundlePaths.credentials, providerMetadata);
  results.push({ kind: "credentials", path: bundlePaths.credentials, exists: Boolean(credentials), legacy: false });

  for (const projectPath of resolveProjectConfigCandidates(cwd)) {
    const projectConfig = await loadNonSecretTomlConfig(projectPath, "project", providerMetadata);
    if (projectConfig) {
      results.push({ kind: "project", path: projectPath, exists: true, legacy: projectConfig.legacy });
    }
  }

  if (options.explicitConfigPath) {
    const explicitPath = resolveExplicitConfigPath(options.explicitConfigPath, cwd);
    const explicit = await loadNonSecretTomlConfig(explicitPath, "explicit", providerMetadata);
    if (!explicit) throw new Error(`Config file not found: ${explicitPath}`);
    results.push({ kind: "explicit", path: explicitPath, exists: true, legacy: explicit.legacy });
  }
  return results;
}
