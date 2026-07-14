import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@iarna/toml";
import { createDefaultConfig } from "./defaults.js";
import { isPlainConfigObject } from "./env.js";
import { parseLegacyV0Config, type LegacyV0Blocker } from "./legacyV0.js";
import {
  resolveConfigBundlePaths,
  resolveExplicitConfigPath,
  resolveProjectConfigCandidates,
} from "./paths.js";
import { loadInstalledProviderConfigMetadata } from "./providerDescriptors.js";
import { type UserConfig } from "./schema.js";
import {
  classifyConfigKey,
  digestConfigContent,
  flattenUserConfig,
  readCredentialsConfigFile,
  serializeCredentialsConfigFile,
  serializeUserConfigFile,
  setUserConfigValue,
  type ConfigKeyMetadata,
} from "./userConfig.js";
import {
  applyConfigTransaction,
  recoverConfigTransactions,
  type ConfigTransactionChange,
} from "./transactions.js";
import { resolveInstallPaths } from "../runtime/installLayout.js";
import { withLocks } from "../runtime/locks.js";
import { expandRegistryUrlCandidates } from "../providers/registry/urlCandidates.js";
import { identityPath } from "../subscriptions/paths.js";
import { canonicalizeRegistrySource } from "../subscriptions/source.js";
import {
  jsonContent,
  readIdentity,
  readSubscriptionsFile,
  serializeSubscriptionsFile,
} from "../subscriptions/store.js";
import type { SubscriptionIdentity } from "../subscriptions/types.js";

const LEGACY_SUBSCRIPTION_ID = "legacy-search";

export interface ProjectConfigMigrationReport {
  path: string;
  exists: boolean;
  digest?: string;
  keys?: string[];
}

export interface LegacyInstallDirectoryReport {
  source: string;
  target: string;
  origin:
    | "explicit-option"
    | "legacy-user-config"
    | "built-in-default"
    | "project-requires-explicit"
    | "explicit-config-requires-explicit"
    | "environment-requires-explicit";
  requiresExplicitSelection: boolean;
  selectedForProviderMigration: boolean;
  operationalOwnership: "machine-data-root";
  conflict: boolean;
  crossVolumeStrategy: "same-volume-rename" | "copy-verify-target-rename";
  action: "report-only";
}

export interface ConfigMigrationPlan {
  schemaVersion: 1;
  source: string;
  sourceDigest: string;
  alreadyMigrated: boolean;
  blockers: LegacyV0Blocker[];
  moves: Array<{ key: string; target: "config" | "credentials" | "subscriptions" }>;
  targets: Array<{ path: string; inputDigest: string; backupPath?: string }>;
  subscriptionProposal: { id: string; runtimeKind: "search"; url: string } | null;
  projectConfigs: ProjectConfigMigrationReport[];
  duplicateProjectConfigs: boolean;
  legacyInstallDirectory: LegacyInstallDirectoryReport;
  planDigest: string;
}

interface BuiltMigration {
  plan: ConfigMigrationPlan;
  nonSecret: UserConfig;
  credentials: UserConfig;
  metadata: ConfigKeyMetadata;
  subscriptionUrl: string | null;
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hashPlan(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sameVolume(left: string, right: string): boolean {
  return path.parse(path.resolve(left)).root.toLowerCase() === path.parse(path.resolve(right)).root.toLowerCase();
}

function backupPath(filePath: string, digest: string): string {
  return path.join(path.dirname(filePath), ".backups", `${path.basename(filePath)}.${digest}.v0.bak`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function projectReports(cwd: string): Promise<ProjectConfigMigrationReport[]> {
  const reports: ProjectConfigMigrationReport[] = [];
  for (const filePath of resolveProjectConfigCandidates(cwd)) {
    const raw = await readOptional(filePath);
    if (raw === null) {
      reports.push({ path: filePath, exists: false });
      continue;
    }
    let keys: string[] = [];
    try {
      const value = parse(raw);
      if (isPlainConfigObject(value)) {
        const { schemaVersion: _schemaVersion, ...document } = value;
        const parsed = parseLegacyV0Config(document);
        keys = [
          ...flattenUserConfig(parsed.recognized).map((entry) => entry.key),
          ...parsed.blockers.map((entry) => entry.key),
        ].sort();
      }
    } catch {
      keys = ["<invalid-toml>"];
    }
    reports.push({ path: filePath, exists: true, digest: digestConfigContent(raw), keys });
  }
  return reports;
}

function resolveLegacyInstallSource(
  configured: string | undefined,
  explicit: string | undefined,
  sourceConfigPath: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  external?: { source: string; origin: LegacyInstallDirectoryReport["origin"] },
): { source: string; origin: LegacyInstallDirectoryReport["origin"] } {
  if (explicit) return { source: path.resolve(cwd, explicit), origin: "explicit-option" };
  if (external) return external;
  if (configured) {
    return {
      source: path.isAbsolute(configured) ? configured : path.resolve(path.dirname(sourceConfigPath), configured),
      origin: "legacy-user-config",
    };
  }
  const configuredDefault = createDefaultConfig(env).providers.installDir;
  const source = configuredDefault.startsWith("~/") || configuredDefault.startsWith("~\\")
    ? path.join(resolveInstallPaths(env).dataRoot, configuredDefault.slice(2).replace(/^\.paper-search[\\/]/, ""))
    : path.resolve(configuredDefault);
  return { source, origin: "built-in-default" };
}

async function externalLegacyInstallSource(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  explicitConfigPath?: string;
}): Promise<{ source: string; origin: LegacyInstallDirectoryReport["origin"] } | undefined> {
  const readInstallDir = async (filePath: string): Promise<string | undefined> => {
    const raw = await readOptional(filePath);
    if (raw === null) return undefined;
    try {
      const document = parse(raw) as { providers?: { installDir?: unknown } };
      return typeof document.providers?.installDir === "string" ? document.providers.installDir : undefined;
    } catch {
      return undefined;
    }
  };

  const candidates: Array<{ source: string; origin: LegacyInstallDirectoryReport["origin"] }> = [];
  for (const filePath of resolveProjectConfigCandidates(options.cwd)) {
    const configured = await readInstallDir(filePath);
    if (configured) {
      candidates.push({
        source: path.isAbsolute(configured) ? configured : path.resolve(path.dirname(filePath), configured),
        origin: "project-requires-explicit",
      });
    }
  }
  if (options.explicitConfigPath) {
    const filePath = resolveExplicitConfigPath(options.explicitConfigPath, options.cwd);
    const configured = await readInstallDir(filePath);
    if (configured) {
      candidates.push({
        source: path.isAbsolute(configured) ? configured : path.resolve(path.dirname(filePath), configured),
        origin: "explicit-config-requires-explicit",
      });
    }
  }
  const environment = options.env.PAPER_SEARCH_PROVIDERS_INSTALL_DIR;
  if (environment) {
    candidates.push({
      source: path.isAbsolute(environment) ? environment : path.resolve(options.cwd, environment),
      origin: "environment-requires-explicit",
    });
  }
  return candidates.at(-1);
}

async function buildMigration(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  legacyInstallDir?: string;
  explicitConfigPath?: string;
} = {}): Promise<BuiltMigration> {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const bundle = resolveConfigBundlePaths(env);
  const raw = await readOptional(bundle.config);
  const sourceDigest = digestConfigContent(raw ?? "");
  const projects = await projectReports(cwd);
  const duplicateProjectConfigs = projects.filter((entry) => entry.exists).length > 1;
  const dataRoot = resolveInstallPaths(env).dataRoot;

  let alreadyMigrated = false;
  let blockers: LegacyV0Blocker[] = [];
  let recognized: UserConfig = {};
  let metadata: ConfigKeyMetadata = {};
  if (raw !== null) {
    let document: unknown;
    try {
      document = parse(raw);
    } catch (error) {
      blockers = [{ key: "<document>", reason: "invalid-value", detail: error instanceof Error ? error.message : String(error) }];
      document = {};
    }
    if (isPlainConfigObject(document) && document.schemaVersion === 1) {
      alreadyMigrated = true;
    } else if (isPlainConfigObject(document) && document.schemaVersion !== undefined) {
      blockers.push({
        key: "schemaVersion",
        reason: "invalid-value",
        detail: `Unsupported config schemaVersion: ${String(document.schemaVersion)}`,
      });
    } else if (blockers.length === 0) {
      const provisional = parseLegacyV0Config(document);
      const configuredInstallDir = provisional.recognized.providers?.installDir;
      const descriptorRoot = configuredInstallDir
        ? (path.isAbsolute(configuredInstallDir)
            ? configuredInstallDir
            : path.resolve(path.dirname(bundle.config), configuredInstallDir))
        : path.join(dataRoot, "providers");
      metadata = await loadInstalledProviderConfigMetadata(descriptorRoot, env);
      const parsed = parseLegacyV0Config(document, metadata);
      recognized = parsed.recognized;
      blockers = parsed.blockers;
    }
  }

  let nonSecret: UserConfig = {};
  let credentials: UserConfig = {};
  const moves: ConfigMigrationPlan["moves"] = [];
  for (const entry of flattenUserConfig(recognized)) {
    const classification = classifyConfigKey(entry.key, metadata);
    if (classification === "owned") continue;
    const segments = entry.key.split(".");
    if (classification === "secret") {
      credentials = setUserConfigValue(credentials, segments, entry.value);
      moves.push({ key: entry.key, target: "credentials" });
    } else if (classification === "non-secret") {
      nonSecret = setUserConfigValue(nonSecret, segments, entry.value);
      moves.push({ key: entry.key, target: "config" });
    }
  }

  let subscriptionUrl: string | null = null;
  const legacyRegistry = recognized.providers?.registryUrl;
  if (legacyRegistry) {
    subscriptionUrl = expandRegistryUrlCandidates(legacyRegistry)[0] ?? legacyRegistry;
    if (!/^https?:/i.test(subscriptionUrl) && !subscriptionUrl.startsWith("file:") && !path.isAbsolute(subscriptionUrl)) {
      subscriptionUrl = path.resolve(path.dirname(bundle.config), subscriptionUrl);
    }
    try {
      const canonical = await canonicalizeRegistrySource(subscriptionUrl, "search");
      const subscriptions = await readSubscriptionsFile(env);
      const existing = subscriptions.subscriptions[LEGACY_SUBSCRIPTION_ID];
      const existingIdentity = await readIdentity(LEGACY_SUBSCRIPTION_ID, env);
      if (
        (existing && (existing.runtimeKind !== "search" || existing.url !== subscriptionUrl)) ||
        (existingIdentity && existingIdentity.sourceFingerprint !== canonical.sourceFingerprint)
      ) {
        blockers.push({
          key: `subscriptions.${LEGACY_SUBSCRIPTION_ID}`,
          reason: "invalid-value",
          detail: `Existing subscription conflicts with migrated legacy registry: ${LEGACY_SUBSCRIPTION_ID}`,
        });
      } else {
        moves.push({ key: "providers.registryUrl", target: "subscriptions" });
      }
    } catch (error) {
      blockers.push({
        key: "providers.registryUrl",
        reason: "invalid-value",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const externalInstallSource = await externalLegacyInstallSource({
    cwd,
    env,
    explicitConfigPath: options.explicitConfigPath,
  });
  const installSource = resolveLegacyInstallSource(
    recognized.providers?.installDir,
    options.legacyInstallDir,
    bundle.config,
    env,
    cwd,
    externalInstallSource,
  );
  const installTarget = path.join(dataRoot, "providers");
  const sourceIsOperationalRoot = path.resolve(installSource.source) === path.resolve(installTarget);
  const requiresExplicitSelection = installSource.origin.endsWith("-requires-explicit") ||
    (installSource.origin === "legacy-user-config" && !sourceIsOperationalRoot);
  const installReport: LegacyInstallDirectoryReport = {
    ...installSource,
    requiresExplicitSelection,
    selectedForProviderMigration: !requiresExplicitSelection,
    operationalOwnership: "machine-data-root",
    target: installTarget,
    conflict: path.resolve(installSource.source) !== path.resolve(installTarget) && await exists(installTarget),
    crossVolumeStrategy: sameVolume(installSource.source, installTarget)
      ? "same-volume-rename"
      : "copy-verify-target-rename",
    action: "report-only",
  };

  const targetInputs = await Promise.all([bundle.config, bundle.credentials, bundle.subscriptions].map(async (filePath) => {
    const content = await readOptional(filePath);
    const digest = digestConfigContent(content ?? "");
    return { path: filePath, inputDigest: digest, ...(content === null ? {} : { backupPath: backupPath(filePath, digest) }) };
  }));
  const base = {
    schemaVersion: 1 as const,
    source: bundle.config,
    sourceDigest,
    alreadyMigrated,
    blockers: blockers.sort((left, right) => left.key.localeCompare(right.key)),
    moves: moves.sort((left, right) => left.key.localeCompare(right.key)),
    targets: targetInputs,
    subscriptionProposal: subscriptionUrl
      ? { id: LEGACY_SUBSCRIPTION_ID, runtimeKind: "search" as const, url: subscriptionUrl }
      : null,
    projectConfigs: projects,
    duplicateProjectConfigs,
    legacyInstallDirectory: installReport,
  };
  return { plan: { ...base, planDigest: hashPlan(base) }, nonSecret, credentials, metadata, subscriptionUrl };
}

export async function planConfigMigration(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  legacyInstallDir?: string;
  explicitConfigPath?: string;
} = {}): Promise<ConfigMigrationPlan> {
  return (await buildMigration(options)).plan;
}

export async function executeConfigMigration(options: {
  apply?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  legacyInstallDir?: string;
  explicitConfigPath?: string;
} = {}): Promise<{ plan: ConfigMigrationPlan; applied: boolean; operationId?: string; recovered?: string[] }> {
  const env = options.env ?? process.env;
  const initial = await buildMigration(options);
  if (!options.apply) return { plan: initial.plan, applied: false };

  return withLocks(["migration"], async () => {
    const bundle = resolveConfigBundlePaths(env);
    const migrationIdentityPath = identityPath(LEGACY_SUBSCRIPTION_ID, env);
    const recoveredBefore = await recoverConfigTransactions({
      command: "migrate config-v0",
      allowedPaths: [bundle.config, bundle.credentials, bundle.subscriptions, migrationIdentityPath],
      fileLockPaths: [bundle.config, bundle.credentials],
      afterFileLockScopes: ["subscriptions-file", `subscription/${LEGACY_SUBSCRIPTION_ID}`],
      env,
    });
    const current = await buildMigration(options);
    if (current.plan.blockers.length > 0) {
      throw new Error(`Migration is blocked: ${current.plan.blockers.map((item) => item.key).join(", ")}`);
    }
    if (current.plan.alreadyMigrated) {
      return {
        plan: current.plan,
        applied: true,
        ...(recoveredBefore.length > 0 ? { recovered: recoveredBefore } : {}),
      };
    }
    if (current.plan.planDigest !== initial.plan.planDigest) throw new Error("Migration plan became stale before apply");
    const changes: ConfigTransactionChange[] = [];
    const targetByPath = new Map(current.plan.targets.map((target) => [target.path, target]));
    const configTarget = targetByPath.get(bundle.config)!;
    changes.push({
      path: bundle.config,
      expectedDigest: configTarget.inputDigest,
      content: serializeUserConfigFile(current.nonSecret),
      backupPath: configTarget.backupPath,
    });

    if (flattenUserConfig(current.credentials).length > 0) {
      const existing = await readCredentialsConfigFile(bundle.credentials, current.metadata);
      let merged = existing.data;
      for (const entry of flattenUserConfig(current.credentials)) {
        merged = setUserConfigValue(merged, entry.key.split("."), entry.value);
      }
      const target = targetByPath.get(bundle.credentials)!;
      changes.push({
        path: bundle.credentials,
        expectedDigest: target.inputDigest,
        content: serializeCredentialsConfigFile(merged, current.metadata),
        mode: 0o600,
        backupPath: target.backupPath,
      });
    }

    const afterFileLockScopes: string[] = [];
    if (current.subscriptionUrl) {
      const subscriptions = await readSubscriptionsFile(env);
      subscriptions.subscriptions[LEGACY_SUBSCRIPTION_ID] ??= {
        runtimeKind: "search",
        url: current.subscriptionUrl,
        enabled: true,
      };
      const target = targetByPath.get(bundle.subscriptions)!;
      changes.push({
        path: bundle.subscriptions,
        expectedDigest: target.inputDigest,
        content: serializeSubscriptionsFile(subscriptions),
        backupPath: target.backupPath,
      });
      const existingIdentity = await readIdentity(LEGACY_SUBSCRIPTION_ID, env);
      if (!existingIdentity) {
        const canonical = await canonicalizeRegistrySource(current.subscriptionUrl, "search");
        const identity: SubscriptionIdentity = {
          schemaVersion: 1,
          subscriptionId: LEGACY_SUBSCRIPTION_ID,
          runtimeKind: "search",
          ...canonical,
          createdAt: new Date().toISOString(),
          latestRegistryDigest: null,
        };
        const identityFile = identityPath(LEGACY_SUBSCRIPTION_ID, env);
        const identityBefore = await readOptional(identityFile);
        changes.push({
          path: identityFile,
          expectedDigest: digestConfigContent(identityBefore ?? ""),
          content: jsonContent(identity),
          mode: 0o600,
        });
      }
      afterFileLockScopes.push("subscriptions-file", `subscription/${LEGACY_SUBSCRIPTION_ID}`);
    }

    const transaction = await applyConfigTransaction({
      command: "migrate config-v0",
      planDigest: current.plan.planDigest,
      changes,
      env,
      fileLockPaths: changes
        .map((change) => change.path)
        .filter((filePath) => filePath === bundle.config || filePath === bundle.credentials),
      afterFileLockScopes,
    });
    return {
      plan: current.plan,
      applied: true,
      operationId: transaction.operationId,
      recovered: transaction.recovered,
    };
  }, { env, command: "migrate config-v0" });
}
