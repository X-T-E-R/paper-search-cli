import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { parseConfigScalar } from "../config/env.js";
import { loadConfig } from "../config/load.js";
import { loadInstalledProviderConfigMetadata } from "../config/providerDescriptors.js";
import {
  readCredentialsConfigFile,
  readUserConfigFile,
  setUserConfigValue,
  writeCredentialsConfigFile,
  writeUserConfigFile,
} from "../config/userConfig.js";
import { readHiddenCredential } from "../config/credentialInput.js";
import { listInstalledMaterialProviders } from "../material/registry/plan.js";
import { resolveMaterialProviderAvailability } from "../material/availability.js";
import { listInstalledProviders } from "../providers/registry/sync.js";
import {
  providerConfigurationAction,
  resolveProviderAvailability,
  type ProviderConfigurationField,
  type ProviderIntent,
} from "../providers/runtime/availability.js";
import type { Io } from "../runtime/io.js";
import { okEnvelope, type ResultAction } from "../surface/resultEnvelope.js";

interface ConfigureOptions {
  provider?: string;
  json?: boolean;
}

export interface ProviderSetupDescriptor {
  id: string;
  name: string;
  kind: "search" | "material";
  intent: ProviderIntent;
  enabled: boolean;
  configured: boolean;
  missingConfigKeys: string[];
  schema: Record<string, ProviderConfigurationField>;
  action?: ResultAction;
}

export interface ConfigurePrompt {
  choose(provider: ProviderSetupDescriptor): Promise<"now" | "later" | "disable">;
  visible(label: string, placeholder?: string): Promise<string>;
  hidden(label: string): Promise<string>;
}

function explicitConfigPath(program: Command): string | undefined {
  return program.optsWithGlobals<{ config?: string }>().config;
}

export async function listProviderSetup(
  config: Awaited<ReturnType<typeof loadConfig>>,
  providerId?: string,
): Promise<ProviderSetupDescriptor[]> {
  const [search, material] = await Promise.all([
    listInstalledProviders(config.providers.installDir),
    listInstalledMaterialProviders(config.providers.installDir),
  ]);
  const descriptors: ProviderSetupDescriptor[] = [];
  for (const entry of search) {
    if (!entry.valid || !entry.manifest) continue;
    const availability = resolveProviderAvailability(config, entry.manifest);
    if (availability.intent === "disabled" && !providerId) continue;
    const schema = entry.manifest.configSchema ?? {};
    const needsAction = !availability.enabled || !availability.configured;
    descriptors.push({
      id: entry.id,
      name: entry.manifest.name,
      kind: "search",
      intent: availability.intent,
      enabled: availability.enabled,
      configured: availability.configured,
      missingConfigKeys: availability.missingConfigKeys,
      schema,
      ...(needsAction && (providerId || availability.missingConfigKeys.length > 0)
        ? { action: providerConfigurationAction({ providerId: entry.id, schema, missingConfigKeys: availability.missingConfigKeys }) }
        : {}),
    });
  }
  for (const entry of material) {
    if (!entry.valid || !entry.manifest) continue;
    const availability = resolveMaterialProviderAvailability(config, entry.manifest);
    if (availability.intent === "disabled" && !providerId) continue;
    const schema = entry.manifest.configSchema ?? {};
    const needsAction = !availability.enabled || !availability.configured;
    descriptors.push({
      id: entry.id,
      name: entry.manifest.name,
      kind: "material",
      intent: availability.intent,
      enabled: availability.enabled,
      configured: availability.configured,
      missingConfigKeys: availability.missingConfigKeys,
      schema,
      ...(needsAction && (providerId || availability.missingConfigKeys.length > 0)
        ? { action: providerConfigurationAction({ providerId: entry.id, schema, missingConfigKeys: availability.missingConfigKeys }) }
        : {}),
    });
  }
  const matching = providerId
    ? descriptors.filter((entry) => entry.id === providerId)
    : descriptors.filter((entry) => Boolean(entry.action));
  return matching.sort((left, right) => left.id.localeCompare(right.id));
}

function defaultPrompt(): ConfigurePrompt {
  return {
    async choose(provider) {
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = (await readline.question(
          `${provider.name}: configure now, later, or disable? [now/later/disable] `,
        )).trim().toLowerCase();
        if (answer === "now" || answer === "disable") return answer;
        return "later";
      } finally {
        readline.close();
      }
    },
    async visible(label, placeholder) {
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const suffix = placeholder ? ` (example: ${placeholder})` : "";
        const answer = (await readline.question(`${label}${suffix}: `)).trim();
        return answer;
      } finally {
        readline.close();
      }
    },
    async hidden(label) {
      return readHiddenCredential(process.stdin, process.stderr, label);
    },
  };
}

function parsedFieldValue(value: string, field: ProviderConfigurationField): unknown {
  if (field.type === "string" || field.type === "secret" || field.type === undefined) return value;
  return parseConfigScalar(value);
}

export async function configureProviderInteractive(
  config: Awaited<ReturnType<typeof loadConfig>>,
  provider: ProviderSetupDescriptor,
  prompt: ConfigurePrompt = defaultPrompt(),
): Promise<{ decision: "now" | "later" | "disable"; configured: boolean }> {
  const decision = await prompt.choose(provider);
  if (decision === "later") return { decision, configured: false };

  const metadata = await loadInstalledProviderConfigMetadata(config.providers.installDir);
  const configFile = await readUserConfigFile();
  let nextConfig = setUserConfigValue(configFile.data, ["platform", provider.id, "enabled"], decision !== "disable");
  if (decision === "disable") {
    await writeUserConfigFile(nextConfig, configFile.path, { expectedDigest: configFile.digest, metadata });
    return { decision, configured: false };
  }

  const credentialsFile = await readCredentialsConfigFile(undefined, metadata);
  let nextCredentials = credentialsFile.data;
  let writesCredentials = false;
  for (const key of provider.missingConfigKeys) {
    const field = provider.schema[key] ?? {};
    const label = field.label?.trim() || key;
    const secret = field.secret === true || field.type === "secret";
    const value = secret
      ? await prompt.hidden(label)
      : await prompt.visible(label, typeof field.placeholder === "string" ? field.placeholder : undefined);
    if (!value.trim()) throw new Error(`${label} must not be empty`);
    if (
      typeof field.placeholder === "string" &&
      value.trim().toLocaleLowerCase("en-US") === field.placeholder.trim().toLocaleLowerCase("en-US")
    ) throw new Error(`${label} must replace the placeholder value`);
    if (secret) {
      nextCredentials = setUserConfigValue(nextCredentials, ["platform", provider.id, key], value);
      writesCredentials = true;
    } else {
      nextConfig = setUserConfigValue(nextConfig, ["platform", provider.id, key], parsedFieldValue(value, field));
    }
  }
  await writeUserConfigFile(nextConfig, configFile.path, { expectedDigest: configFile.digest, metadata });
  if (writesCredentials) {
    await writeCredentialsConfigFile(nextCredentials, credentialsFile.path, {
      expectedDigest: credentialsFile.digest,
      metadata,
    });
  }
  return { decision, configured: true };
}

export function registerConfigureCommand(program: Command, io: Io): void {
  program
    .command("configure")
    .description("Report pending provider setup or configure one provider interactively.")
    .argument("[provider]", "installed provider to configure")
    .option("--provider <id>", "compatibility alias for the provider argument")
    .option("--json", "emit a machine-readable envelope without prompting")
    .action(async (providerArgument: string | undefined, options: ConfigureOptions, command: Command) => {
      const providerId = providerArgument ?? options.provider;
      const config = await loadConfig({ explicitConfigPath: explicitConfigPath(command) });
      const providers = await listProviderSetup(config, providerId);
      if (providerId && providers.length === 0) {
        throw new Error(`Installed provider not found: ${providerId}`);
      }
      const actions = providers.flatMap((entry) => entry.action ? [entry.action] : []);
      const envelope = okEnvelope({
        capability: "operate",
        tool: "configure",
        data: {
          providers: providers.map(({ schema: _schema, action: _action, ...entry }) => entry),
          count: providers.length,
        },
        ...(actions.length > 0 ? { actions } : {}),
      });

      const interactive = options.json !== true && process.stdin.isTTY === true && process.stderr.isTTY === true;
      if (!interactive) {
        io.writeJson(envelope);
        return;
      }
      if (!providerId) {
        if (providers.length === 0) io.writeLine("No provider setup is pending.");
        else for (const entry of providers) io.writeLine(`${entry.id}: ${entry.action!.command}`);
        return;
      }
      if (!providers[0]!.action) {
        io.writeLine(`${providers[0]!.id}: ready`);
        return;
      }

      const result = await configureProviderInteractive(config, providers[0]!);
      io.writeLine(`${providers[0]!.id}: ${result.decision === "now" ? "configured" : result.decision}`);
    });
}
