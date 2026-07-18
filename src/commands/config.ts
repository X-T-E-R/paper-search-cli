import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Command } from "commander";
import {
  envNameToConfigPath,
  parseConfigScalar,
  parseEnvFile,
} from "../config/env.js";
import { loadConfig, validateConfigFiles } from "../config/load.js";
import {
  resolveConfigBundlePaths,
  resolveConfigFragmentDirectory,
} from "../config/paths.js";
import { loadInstalledProviderConfigMetadata } from "../config/providerDescriptors.js";
import { listProviderSelectionCandidates } from "../search/candidates.js";
import { resolveExplicitProvider } from "../search/selection.js";
import { readCredentialInput } from "../config/credentialInput.js";
import { applyConfigTransaction } from "../config/transactions.js";
import {
  CONFIGURABLE_DYNAMIC_KEY_PATTERNS,
  CONFIGURABLE_FIXED_KEYS,
  assertCredentialConfigKey,
  assertSupportedConfigKey,
  assertWritableNonSecretConfigKey,
  classifyConfigKey,
  configKeyToString,
  flattenUserConfig,
  getConfigValue,
  isSecretConfigKey,
  maskConfigValue,
  readCredentialsConfigFile,
  readUserConfigFile,
  serializeCredentialsConfigFile,
  serializeUserConfigFile,
  setUserConfigValue,
  unsetUserConfigValue,
  writeCredentialsConfigFile,
  writeUserConfigFile,
  type ConfigKeyMetadata,
} from "../config/userConfig.js";
import type { Io } from "../runtime/io.js";
import { sanitizeUrlForDisplay } from "../runtime/sanitizeUrl.js";
import { failEnvelope, okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import { planConfigLocationMigration } from "../config/locationMigration.js";
import { acceptAlwaysJsonFlag } from "./alwaysJson.js";

interface RawOption {
  raw?: boolean;
}

interface PathOption {
  all?: boolean;
}

interface ApplyOption {
  apply?: boolean;
}

interface CredentialSetOption {
  stdin?: boolean;
  fromEnv?: string;
}

interface ConfigEntryPayload {
  key: string;
  value: unknown;
  masked: boolean;
}

interface ConfigImportEnvPayload {
  source: string;
  sourceDigest: string;
  planDigest: string;
  operationId?: string;
  applied: boolean;
  imported: Array<ConfigEntryPayload & {
    env: string;
    line: number;
    target: "config" | "credentials";
    path: string;
  }>;
  skippedShellEnv: Array<{ env: string; key: string; line: number }>;
  ignored: Array<{ env: string; line: number; key?: string; reason: string }>;
}

type ConfigEnvelope<T = unknown> = ResultEnvelope<T>;

function emit<T>(io: Io, envelope: ConfigEnvelope<T>): void {
  io.writeJson(envelope);
}

function success<T>(
  tool: string,
  data: T,
  provenancePaths: string | string[] = [],
  planned?: boolean,
): ConfigEnvelope<T> {
  const paths = Array.isArray(provenancePaths) ? provenancePaths : [provenancePaths];
  return okEnvelope({
    capability: "operate",
    tool,
    data,
    ...(planned === undefined ? {} : { planned }),
    ...(paths.length > 0 ? { provenance: { configPaths: paths } } : {}),
  });
}

function failure(tool: string, error: unknown): ConfigEnvelope<null> {
  return failEnvelope({
    capability: "operate",
    tool,
    errors: [error instanceof Error ? error.message : String(error)],
  });
}

async function runConfigAction<T>(
  io: Io,
  tool: string,
  action: () => Promise<ConfigEnvelope<T>> | ConfigEnvelope<T>,
): Promise<void> {
  try {
    emit(io, await action());
  } catch (error) {
    emit(io, failure(tool, error));
  }
}

function explicitConfigPath(program: Command): string | undefined {
  return program.opts<{ config?: string }>().config;
}

async function installedConfigMetadata(program: Command): Promise<ConfigKeyMetadata> {
  return (await installedConfigContext(program)).metadata;
}

async function installedConfigContext(program: Command): Promise<{
  resolved: Awaited<ReturnType<typeof loadConfig>>;
  metadata: ConfigKeyMetadata;
}> {
  const resolved = await loadConfig({ explicitConfigPath: explicitConfigPath(program) });
  return {
    resolved,
    metadata: await loadInstalledProviderConfigMetadata(resolved.providers.installDir),
  };
}

async function canonicalizeSearchDefinitionValue(
  resolved: Awaited<ReturnType<typeof loadConfig>>,
  pathSegments: readonly string[],
  value: unknown,
): Promise<unknown> {
  const isClassificationSources =
    pathSegments[0] === "search" &&
    pathSegments[1] === "classifications" &&
    pathSegments[3] === "sources";
  const isPresetSelectors =
    pathSegments[0] === "search" &&
    pathSegments[1] === "presets" &&
    (pathSegments[3] === "include" || pathSegments[3] === "exclude");
  if ((!isClassificationSources && !isPresetSelectors) || !Array.isArray(value)) return value;

  const { candidates } = await listProviderSelectionCandidates(resolved);
  const canonicalized: unknown[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      canonicalized.push(item);
      continue;
    }
    const requestedId = isClassificationSources
      ? item
      : item.startsWith("source:")
        ? item.slice("source:".length)
        : null;
    if (requestedId === null || requestedId.length === 0) {
      canonicalized.push(item);
      continue;
    }
    const provider = resolveExplicitProvider(candidates, requestedId);
    const normalized = provider
      ? isClassificationSources
        ? provider.id
        : `source:${provider.id}`
      : item;
    if (!canonicalized.includes(normalized)) canonicalized.push(normalized);
  }
  return canonicalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function registerConfigCommands(program: Command, io: Io): void {
  const config = program
    .command("config")
    .description("Manage strict split configuration with secret-safe JSON envelopes.");

  acceptAlwaysJsonFlag(config
    .command("path")
    .description("Return the user config path, or every conventional config-bundle path."))
    .option("--all", "include the config root and all conventional files")
    .action(async (options: PathOption) =>
      runConfigAction(io, "config_path", async () => {
        const paths = resolveConfigBundlePaths();
        const configLocationMigration = await planConfigLocationMigration();
        return success(
          "config_path",
          options.all
            ? {
                configRoot: paths.root,
                config: paths.config,
                configFragments: resolveConfigFragmentDirectory(paths.config),
                subscriptions: paths.subscriptions,
                credentials: paths.credentials,
                externalSearch: paths.externalSearch,
                configLocationMigration,
              }
            : { path: paths.config, migrationStatus: configLocationMigration.status },
          options.all ? [paths.config, paths.subscriptions, paths.credentials, paths.externalSearch] : paths.config,
        );
      }),
    );

  acceptAlwaysJsonFlag(config
    .command("validate")
    .description("Validate conventional, project, and explicit config files against their owning schemas."))
    .action(async () =>
      runConfigAction(io, "config_validate", async () => {
        const files = await validateConfigFiles({ explicitConfigPath: explicitConfigPath(program) });
        return success(
          "config_validate",
          { valid: true, files },
          files.filter((file) => file.exists).map((file) => file.path),
        );
      }),
    );

  acceptAlwaysJsonFlag(config
    .command("explain <key>")
    .description("Explain the resolved value and winning origin for one supported key."))
    .action(async (key: string) =>
      runConfigAction(io, "config_explain", async () => {
        const pathSegments = assertSupportedConfigKey(key);
        const canonicalKey = configKeyToString(pathSegments);
        const resolved = await loadConfig({ explicitConfigPath: explicitConfigPath(program) });
        const value = getConfigValue(resolved, pathSegments);
        const masked = maskConfigValue(value, canonicalKey);
        const displayValue = canonicalKey === "providers.registryUrl" && typeof masked.value === "string"
          ? sanitizeUrlForDisplay(masked.value)
          : masked.value;
        return success(
          "config_explain",
          {
            key: canonicalKey,
            value: value === undefined ? null : displayValue,
            masked: value === undefined ? false : masked.masked,
            origin: resolved.meta.origins?.[canonicalKey] ?? null,
          },
          resolved.meta.loadedFiles,
        );
      }),
    );

  acceptAlwaysJsonFlag(config
    .command("keys")
    .description("List supported user-config keys and dynamic key patterns."))
    .action(async () =>
      runConfigAction(io, "config_keys", () => {
        const configPath = resolveConfigBundlePaths().config;
        return success(
          "config_keys",
          {
            keys: [...CONFIGURABLE_FIXED_KEYS],
            dynamic: [...CONFIGURABLE_DYNAMIC_KEY_PATTERNS],
          },
          configPath,
        );
      }),
    );

  acceptAlwaysJsonFlag(config
    .command("list")
    .description("List values stored in config.toml. Legacy secret-like keys are masked by default."))
    .option("--raw", "include unmasked legacy secret-like values")
    .action(async (options: RawOption) =>
      runConfigAction(io, "config_list", async () => {
        const configFile = await readUserConfigFile();
        const entries = flattenUserConfig(configFile.data).map((entry) => {
          const masked = maskConfigValue(entry.value, entry.key, options.raw);
          return { key: entry.key, value: masked.value, masked: masked.masked };
        });
        return success(
          "config_list",
          {
            path: configFile.path,
            exists: configFile.exists,
            legacy: configFile.legacy,
            entries,
          },
          configFile.path,
        );
      }),
    );

  acceptAlwaysJsonFlag(config
    .command("get <key>")
    .description("Read one config.toml key. Legacy secret-like keys are masked by default."))
    .option("--raw", "include an unmasked legacy secret-like value")
    .action(async (key: string, options: RawOption) =>
      runConfigAction(io, "config_get", async () => {
        const pathSegments = assertSupportedConfigKey(key);
        const canonicalKey = configKeyToString(pathSegments);
        const configFile = await readUserConfigFile();
        const value = getConfigValue(configFile.data, pathSegments);
        const masked = maskConfigValue(value, canonicalKey, options.raw);
        return success(
          "config_get",
          {
            path: configFile.path,
            key: canonicalKey,
            exists: value !== undefined,
            value: value === undefined ? null : masked.value,
            masked: value === undefined ? false : masked.masked,
          },
          configFile.path,
        );
      }),
    );

  acceptAlwaysJsonFlag(config
    .command("set <key> <value>")
    .description("Set one known non-secret key in config.toml."))
    .action(async (key: string, value: string) =>
      runConfigAction(io, "config_set", async () => {
        const { resolved, metadata } = await installedConfigContext(program);
        const pathSegments = assertWritableNonSecretConfigKey(key, metadata);
        const canonicalKey = configKeyToString(pathSegments);
        const parsedValue = await canonicalizeSearchDefinitionValue(
          resolved,
          pathSegments,
          parseConfigScalar(value),
        );
        const configFile = await readUserConfigFile();
        const next = setUserConfigValue(configFile.data, pathSegments, parsedValue);
        await writeUserConfigFile(next, configFile.path, { expectedDigest: configFile.digest, metadata });
        return success(
          "config_set",
          { path: configFile.path, key: canonicalKey, value: parsedValue, masked: false },
          configFile.path,
        );
      }),
    );

  acceptAlwaysJsonFlag(config
    .command("unset <key>")
    .description("Remove one known non-secret key from config.toml."))
    .action(async (key: string) =>
      runConfigAction(io, "config_unset", async () => {
        const metadata = await installedConfigMetadata(program);
        const pathSegments = assertWritableNonSecretConfigKey(key, metadata);
        const canonicalKey = configKeyToString(pathSegments);
        const configFile = await readUserConfigFile();
        const result = unsetUserConfigValue(configFile.data, pathSegments);
        await writeUserConfigFile(result.data, configFile.path, { expectedDigest: configFile.digest, metadata });
        return success(
          "config_unset",
          { path: configFile.path, key: canonicalKey, removed: result.removed },
          configFile.path,
        );
      }),
    );

  const credentials = config
    .command("credentials")
    .description("Manage ACL-restricted plaintext credentials in credentials.toml.");

  acceptAlwaysJsonFlag(credentials
    .command("set <key>")
    .description("Set a credential from a hidden TTY prompt, stdin, or a named environment variable."))
    .option("--stdin", "read the credential from stdin")
    .option("--from-env <name>", "read the credential from the named environment variable")
    .action(async (key: string, options: CredentialSetOption) =>
      runConfigAction(io, "config_credentials_set", async () => {
        const metadata = await installedConfigMetadata(program);
        const pathSegments = assertCredentialConfigKey(key, metadata);
        const canonicalKey = configKeyToString(pathSegments);
        const value = await readCredentialInput(options);
        const file = await readCredentialsConfigFile(undefined, metadata);
        const next = setUserConfigValue(file.data, pathSegments, value);
        const permissions = await writeCredentialsConfigFile(next, file.path, { expectedDigest: file.digest, metadata });
        return success(
          "config_credentials_set",
          { path: file.path, key: canonicalKey, value: "********", masked: true, permissions },
          file.path,
        );
      }),
    );

  acceptAlwaysJsonFlag(credentials
    .command("get <key>")
    .description("Read a credential masked by default."))
    .action(async (key: string) =>
      runConfigAction(io, "config_credentials_get", async () => {
        const metadata = await installedConfigMetadata(program);
        const pathSegments = assertCredentialConfigKey(key, metadata);
        const canonicalKey = configKeyToString(pathSegments);
        const file = await readCredentialsConfigFile(undefined, metadata);
        const value = getConfigValue(file.data, pathSegments);
        return success(
          "config_credentials_get",
          {
            path: file.path,
            key: canonicalKey,
            exists: value !== undefined,
            value: value === undefined ? null : "********",
            masked: value !== undefined,
          },
          file.path,
        );
      }),
    );

  acceptAlwaysJsonFlag(credentials
    .command("unset <key>")
    .description("Remove a credential from credentials.toml."))
    .action(async (key: string) =>
      runConfigAction(io, "config_credentials_unset", async () => {
        const metadata = await installedConfigMetadata(program);
        const pathSegments = assertCredentialConfigKey(key, metadata);
        const canonicalKey = configKeyToString(pathSegments);
        const file = await readCredentialsConfigFile(undefined, metadata);
        const result = unsetUserConfigValue(file.data, pathSegments);
        await writeCredentialsConfigFile(result.data, file.path, { expectedDigest: file.digest, metadata });
        return success(
          "config_credentials_unset",
          { path: file.path, key: canonicalKey, removed: result.removed },
          file.path,
        );
      }),
    );

  acceptAlwaysJsonFlag(config
    .command("import-env <env-path>")
    .alias("import")
    .description("Plan importing PAPER_SEARCH_* entries; --apply writes each value to its owning file."))
    .option("--apply", "apply the displayed import plan")
    .action(async (envPath: string, options: ApplyOption) =>
      runConfigAction(io, "config_import_env", async () => {
        const content = await readFile(envPath, "utf8");
        const sourceDigest = sha256(content);
        const entries = parseEnvFile(content);
        const metadata = await installedConfigMetadata(program);
        const configFile = await readUserConfigFile();
        const credentialsFile = await readCredentialsConfigFile(undefined, metadata);
        let nextConfig = configFile.data;
        let nextCredentials = credentialsFile.data;
        const imported: ConfigImportEnvPayload["imported"] = [];
        const skippedShellEnv: ConfigImportEnvPayload["skippedShellEnv"] = [];
        const ignored: ConfigImportEnvPayload["ignored"] = [];

        for (const entry of entries) {
          const pathSegments = envNameToConfigPath(entry.name);
          if (!pathSegments) {
            ignored.push({ env: entry.name, line: entry.line, reason: "unsupported env name" });
            continue;
          }
          const key = configKeyToString(pathSegments);
          if (typeof process.env[entry.name] === "string") {
            skippedShellEnv.push({ env: entry.name, key, line: entry.line });
            continue;
          }
          const classification = classifyConfigKey(pathSegments, metadata);
          if (classification === "owned") {
            ignored.push({ env: entry.name, key, line: entry.line, reason: "owned by lifecycle commands" });
            continue;
          }
          if (classification === "ambiguous") {
            ignored.push({ env: entry.name, key, line: entry.line, reason: "ambiguous secret classification" });
            continue;
          }

          const parsedValue = parseConfigScalar(entry.value);
          const target = classification === "secret" ? "credentials" : "config";
          const targetPath = target === "credentials" ? credentialsFile.path : configFile.path;
          if (target === "credentials") {
            nextCredentials = setUserConfigValue(nextCredentials, pathSegments, parsedValue);
          } else {
            nextConfig = setUserConfigValue(nextConfig, pathSegments, parsedValue);
          }
          imported.push({
            env: entry.name,
            key,
            line: entry.line,
            target,
            path: targetPath,
            value: classification === "secret" ? "********" : parsedValue,
            masked: classification === "secret",
          });
        }

        const planBase = {
          schemaVersion: 1,
          source: envPath,
          sourceDigest,
          inputs: [
            { path: configFile.path, digest: configFile.digest },
            { path: credentialsFile.path, digest: credentialsFile.digest },
          ],
          entries: imported.map(({ env, key, line, target, path: targetPath }) => ({
            env, key, line, target, path: targetPath,
          })),
          skippedShellEnv,
          ignored,
        };
        const planDigest = sha256(JSON.stringify(planBase));
        let operationId: string | undefined;
        if (options.apply && imported.length > 0) {
          const currentSourceDigest = sha256(await readFile(envPath, "utf8"));
          if (currentSourceDigest !== sourceDigest) throw new Error(`Environment import source changed: ${envPath}`);
          const changes = [];
          if (imported.some((entry) => entry.target === "config")) {
            changes.push({
              path: configFile.path,
              expectedDigest: configFile.digest,
              content: serializeUserConfigFile(nextConfig),
            });
          }
          if (imported.some((entry) => entry.target === "credentials")) {
            changes.push({
              path: credentialsFile.path,
              expectedDigest: credentialsFile.digest,
              content: serializeCredentialsConfigFile(nextCredentials, metadata),
              mode: 0o600,
            });
          }
          const transaction = await applyConfigTransaction({
            command: "config import-env",
            planDigest,
            changes,
          });
          operationId = transaction.operationId;
        }

        const payload: ConfigImportEnvPayload = {
          source: envPath,
          sourceDigest,
          planDigest,
          ...(operationId ? { operationId } : {}),
          applied: Boolean(options.apply),
          imported,
          skippedShellEnv,
          ignored,
        };
        return success(
          "config_import_env",
          payload,
          [...new Set(imported.map((entry) => entry.path))],
          !options.apply,
        );
      }),
    );
}

export function isSecretConfigPath(key: string): boolean {
  return isSecretConfigKey(key);
}
