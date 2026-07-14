import type { ResolvedConfig } from "../../config/schema.js";
import type { ProviderManifest } from "../sdk/types.js";

export interface ProviderAvailability {
  providerConfig: Record<string, unknown>;
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

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export function resolveProviderAvailability(
  config: ResolvedConfig,
  manifest: ProviderManifest,
): ProviderAvailability {
  const providerConfig = getProviderConfig(config, manifest.id);
  const configuredEnabled = providerConfig.enabled;
  const manifestDefault = manifest.configSchema?.enabled?.default;
  const enabled =
    typeof configuredEnabled === "boolean"
      ? configuredEnabled
      : typeof manifestDefault === "boolean"
        ? manifestDefault
        : true;
  const missingConfigKeys = Object.entries(manifest.configSchema ?? {})
    .filter(([, field]) => field.required === true)
    .filter(([key, field]) => !hasValue(providerConfig[key] ?? field.default))
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right));
  const configured = missingConfigKeys.length === 0;
  return {
    providerConfig,
    enabled,
    configured,
    available: enabled && configured,
    missingConfigKeys,
  };
}
