import { access, readFile, readdir } from "node:fs/promises";
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
  resolveConfigFragmentDirectory,
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
  kind:
    | "config"
    | "config-fragment"
    | "subscriptions"
    | "credentials"
    | "project"
    | "project-fragment"
    | "explicit"
    | "explicit-fragment";
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

interface LoadedConfigLayer {
  main: LoadedConfigFile;
  files: LoadedConfigFile[];
}

function isAtomicNamedDefinitionPath(pathSegments: readonly string[]): boolean {
  return pathSegments.length === 3 &&
    pathSegments[0] === "search" &&
    (pathSegments[1] === "classifications" || pathSegments[1] === "presets");
}

function deepMergeAtPath<T>(base: T, patch: unknown, pathSegments: readonly string[]): T {
  if (isAtomicNamedDefinitionPath(pathSegments)) return patch as T;
  if (!isPlainConfigObject(base) || !isPlainConfigObject(patch)) {
    return patch as T;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    if (isPlainConfigObject(existing) && isPlainConfigObject(value)) {
      result[key] = deepMergeAtPath(existing, value, [...pathSegments, key]);
      continue;
    }
    result[key] = value;
  }
  return result as T;
}

export function deepMerge<T>(base: T, patch: unknown): T {
  return deepMergeAtPath(base, patch, []);
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
  options: {
    allowMissingSchemaVersion?: boolean;
    inheritedLegacy?: boolean;
    relativeTo?: string;
  } = {},
): Promise<LoadedConfigFile | null> {
  if (!(await fileExists(filePath))) return null;
  const raw = await readFile(filePath, "utf8");
  const parsed = parseUserConfigDocument(parse(raw), {
    allowLegacy: originKind !== "user" || options.allowMissingSchemaVersion,
  });
  const legacy = options.inheritedLegacy ?? parsed.legacy;
  assertSafeNonSecretLayer(parsed.data, filePath, {
    allowLegacyUserSecrets: originKind === "user" && legacy,
    // Project/explicit values remain one-off compatibility overrides. Loader
    // acceptance never promotes them into a trusted subscription or migration
    // authority.
    allowLifecycleOwnedCompatibility:
      originKind === "project" || originKind === "explicit" || legacy,
    metadata,
  });
  return {
    path: filePath,
    data: resolveConfigRelativePaths(parsed.data, options.relativeTo ?? filePath),
    legacy,
    originKind,
  };
}

async function resolveConfigFragmentPaths(configPath: string): Promise<string[]> {
  const directory = resolveConfigFragmentDirectory(configPath);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".toml")
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(directory, name));
}

async function loadNonSecretTomlConfigLayer(
  configPath: string,
  originKind: "user" | "project" | "explicit",
  metadata: ConfigKeyMetadata = {},
): Promise<LoadedConfigLayer | null> {
  const main = await loadNonSecretTomlConfig(configPath, originKind, metadata);
  if (!main) return null;

  const fragments: LoadedConfigFile[] = [];
  for (const fragmentPath of await resolveConfigFragmentPaths(configPath)) {
    const fragment = await loadNonSecretTomlConfig(fragmentPath, originKind, metadata, {
      // A fragment belongs to its main file and inherits that file's schema
      // generation. An optional explicit schemaVersion must still be valid.
      allowMissingSchemaVersion: true,
      inheritedLegacy: main.legacy,
      // Splitting a file must not change the meaning of its relative paths.
      relativeTo: configPath,
    });
    if (fragment) fragments.push(fragment);
  }
  return { main, files: [main, ...fragments] };
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
  for (const collection of ["classifications", "presets"] as const) {
    const definitions = data.search?.[collection];
    if (!definitions) continue;
    for (const name of Object.keys(definitions)) {
      const prefix = `search.${collection}.${name}`;
      for (const key of Object.keys(origins)) {
        if (key === prefix || key.startsWith(`${prefix}.`)) delete origins[key];
      }
    }
  }
  for (const entry of flattenUserConfig(data)) {
    origins[entry.key] = { kind, source };
  }
}

function mergeLoadedConfigFiles(
  base: Omit<ResolvedConfig, "meta">,
  files: readonly LoadedConfigFile[],
): Omit<ResolvedConfig, "meta"> {
  return files.reduce((merged, file) => deepMerge(merged, file.data), base);
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
  const userLayer = await loadNonSecretTomlConfigLayer(userConfigPath, "user");
  if (userLayer) loaded.push(...userLayer.files);

  const provisionalConfig = normalizeResolvedConfigPaths(
    mergeLoadedConfigFiles(
      structuredClone(DEFAULT_CONFIG) as Omit<ResolvedConfig, "meta">,
      userLayer?.files ?? [],
    ),
    cwd,
  );
  const providerMetadata = await loadInstalledProviderConfigMetadata(provisionalConfig.providers.installDir);
  for (const userConfig of userLayer?.files ?? []) {
    if (!userConfig.legacy) {
      assertSafeNonSecretLayer(userConfig.data, userConfig.path, {
        allowLegacyUserSecrets: false,
        metadata: providerMetadata,
      });
    }
  }

  const loadedProjectLayers: LoadedConfigLayer[] = [];
  for (const candidate of projectCandidates) {
    const layer = await loadNonSecretTomlConfigLayer(candidate, "project", providerMetadata);
    if (layer) {
      loaded.push(...layer.files);
      loadedProjectLayers.push(layer);
    }
  }

  if (explicitConfigPath) {
    const explicitLayer = await loadNonSecretTomlConfigLayer(explicitConfigPath, "explicit", providerMetadata);
    if (!explicitLayer) {
      throw new Error(`Config file not found: ${explicitConfigPath}`);
    }
    loaded.push(...explicitLayer.files);
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

  const warnings = loadedProjectLayers.length > 1
    ? [
        `Both project config candidates are present; compatibility merge order is ${loadedProjectLayers.map((entry) => entry.main.path).join(" then ")}`,
      ]
    : [];

  return ResolvedConfigSchema.parse({
    ...merged,
    meta: {
      cwd,
      userConfigPath,
      projectConfigPath: loadedProjectLayers[0]?.main.path ?? null,
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

  const userLayer = await loadNonSecretTomlConfigLayer(bundlePaths.config, "user");
  results.push({
    kind: "config",
    path: bundlePaths.config,
    exists: Boolean(userLayer),
    legacy: userLayer?.main.legacy ?? false,
  });
  for (const fragment of userLayer?.files.slice(1) ?? []) {
    results.push({ kind: "config-fragment", path: fragment.path, exists: true, legacy: fragment.legacy });
  }
  const provisionalConfig = normalizeResolvedConfigPaths(
    mergeLoadedConfigFiles(
      structuredClone(DEFAULT_CONFIG) as Omit<ResolvedConfig, "meta">,
      userLayer?.files ?? [],
    ),
    cwd,
  );
  const providerMetadata = await loadInstalledProviderConfigMetadata(provisionalConfig.providers.installDir);
  for (const user of userLayer?.files ?? []) {
    if (!user.legacy) {
      assertSafeNonSecretLayer(user.data, user.path, {
        allowLegacyUserSecrets: false,
        metadata: providerMetadata,
      });
    }
  }

  if (await fileExists(bundlePaths.subscriptions)) {
    SubscriptionsConfigFileSchema.parse(parse(await readFile(bundlePaths.subscriptions, "utf8")));
    results.push({ kind: "subscriptions", path: bundlePaths.subscriptions, exists: true, legacy: false });
  } else {
    results.push({ kind: "subscriptions", path: bundlePaths.subscriptions, exists: false, legacy: false });
  }

  const credentials = await loadCredentialsTomlConfig(bundlePaths.credentials, providerMetadata);
  results.push({ kind: "credentials", path: bundlePaths.credentials, exists: Boolean(credentials), legacy: false });

  const projectLayers: LoadedConfigLayer[] = [];
  for (const projectPath of resolveProjectConfigCandidates(cwd)) {
    const projectLayer = await loadNonSecretTomlConfigLayer(projectPath, "project", providerMetadata);
    if (projectLayer) {
      projectLayers.push(projectLayer);
      results.push({ kind: "project", path: projectPath, exists: true, legacy: projectLayer.main.legacy });
      for (const fragment of projectLayer.files.slice(1)) {
        results.push({ kind: "project-fragment", path: fragment.path, exists: true, legacy: fragment.legacy });
      }
    }
  }

  let explicitLayer: LoadedConfigLayer | null = null;
  let explicitPath: string | null = null;
  if (options.explicitConfigPath) {
    explicitPath = resolveExplicitConfigPath(options.explicitConfigPath, cwd);
    explicitLayer = await loadNonSecretTomlConfigLayer(explicitPath, "explicit", providerMetadata);
    if (!explicitLayer) throw new Error(`Config file not found: ${explicitPath}`);
    results.push({ kind: "explicit", path: explicitPath, exists: true, legacy: explicitLayer.main.legacy });
    for (const fragment of explicitLayer.files.slice(1)) {
      results.push({ kind: "explicit-fragment", path: fragment.path, exists: true, legacy: fragment.legacy });
    }
  }
  // Per-file schemas intentionally allow references to definitions supplied by
  // a later fragment or higher layer. Validate those references only after the
  // complete precedence stack has been assembled.
  const effectiveFiles = [
    ...(userLayer?.files ?? []),
    ...projectLayers.flatMap((layer) => layer.files),
    ...(explicitLayer?.files ?? []),
    ...(credentials ? [credentials] : []),
  ];
  const merged = normalizeResolvedConfigPaths(
    mergeLoadedConfigFiles(
      structuredClone(DEFAULT_CONFIG) as Omit<ResolvedConfig, "meta">,
      effectiveFiles,
    ),
    cwd,
  );
  ResolvedConfigSchema.parse({
    ...merged,
    meta: {
      cwd,
      userConfigPath: bundlePaths.config,
      projectConfigPath: projectLayers[0]?.main.path ?? null,
      explicitConfigPath: explicitPath,
      loadedFiles: effectiveFiles.map((entry) => entry.path),
      appliedEnvOverrides: [],
    },
  });
  return results;
}
