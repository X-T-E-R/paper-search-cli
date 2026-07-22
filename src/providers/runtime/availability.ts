import type { ResolvedConfig } from "../../config/schema.js";
import type { ProviderManifest } from "../sdk/types.js";
import type { ResultAction } from "../../surface/resultEnvelope.js";

export type ProviderIntent = "auto" | "enabled" | "disabled";

export interface ProviderConfigurationField {
  default?: unknown;
  required?: boolean;
  placeholder?: string;
  secret?: boolean;
  label?: string;
  type?: string;
}

export interface ProviderAvailability {
  providerConfig: Record<string, unknown>;
  intent: ProviderIntent;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  missingConfigKeys: string[];
}

export function getProviderConfig(
  config: ResolvedConfig,
  providerId: string,
): Record<string, unknown> {
  const value = config.platform[providerId];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function resolveProviderIntent(providerConfig: Record<string, unknown>): ProviderIntent {
  return providerConfig.enabled === true
    ? "enabled"
    : providerConfig.enabled === false
      ? "disabled"
      : "auto";
}

export function hasConfigValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/** A schema placeholder only gates readiness when it is the effective value. */
export function isProviderFieldReady(
  providerConfig: Record<string, unknown>,
  key: string,
  field: ProviderConfigurationField,
): boolean {
  const value = providerConfig[key] ?? field.default;
  if (field.required === true && !hasConfigValue(value)) return false;
  if (typeof field.placeholder === "string" && !hasConfigValue(value)) return false;
  if (
    typeof field.placeholder === "string" &&
    typeof value === "string" &&
    value.trim().toLocaleLowerCase("en-US") === field.placeholder.trim().toLocaleLowerCase("en-US")
  ) return false;
  return true;
}

export function missingProviderConfigKeys(
  providerConfig: Record<string, unknown>,
  schema: Record<string, ProviderConfigurationField> = {},
): string[] {
  return Object.entries(schema)
    .filter(([key, field]) => key !== "enabled" && !isProviderFieldReady(providerConfig, key, field))
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right));
}

export function providerConfigurationAction(options: {
  providerId: string;
  schema?: Record<string, ProviderConfigurationField>;
  missingConfigKeys: readonly string[];
}): ResultAction {
  const schema = options.schema ?? {};
  return {
    id: `configure-provider:${options.providerId}`,
    kind: "configure_provider",
    target: { kind: "provider", id: options.providerId },
    command: `paper-search configure ${options.providerId}`,
    ...(options.missingConfigKeys.length > 0
      ? {
          fields: options.missingConfigKeys.map((key) => {
            const field = schema[key] ?? {};
            return {
              key,
              label: field.label?.trim() || key,
              secret: field.secret === true || field.type === "secret",
              required: field.required === true || typeof field.placeholder === "string",
            };
          }),
        }
      : {}),
  };
}

export function resolveProviderAvailability(
  config: ResolvedConfig,
  manifest: ProviderManifest,
): ProviderAvailability {
  const providerConfig = getProviderConfig(config, manifest.id);
  const configuredEnabled = providerConfig.enabled;
  const intent = resolveProviderIntent(providerConfig);
  const manifestDefault = manifest.configSchema?.enabled?.default;
  const enabled =
    typeof configuredEnabled === "boolean"
      ? configuredEnabled
      : typeof manifestDefault === "boolean"
        ? manifestDefault
        : true;
  const missingConfigKeys = missingProviderConfigKeys(providerConfig, manifest.configSchema);
  const configured = missingConfigKeys.length === 0;
  return {
    providerConfig,
    intent,
    enabled,
    configured,
    available: enabled && configured,
    missingConfigKeys,
  };
}
