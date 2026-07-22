import type { ResolvedConfig } from "../config/schema.js";
import {
  missingProviderConfigKeys,
  resolveProviderIntent,
  type ProviderIntent,
} from "../providers/runtime/availability.js";
import type { MaterialProviderManifest } from "./types.js";

export interface MaterialProviderAvailability {
  providerConfig: Record<string, unknown>;
  effectiveConfig: Record<string, unknown>;
  intent: ProviderIntent;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  missingConfigKeys: string[];
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0);
}

export function resolveMaterialProviderAvailability(
  config: ResolvedConfig,
  manifest: MaterialProviderManifest,
  env: NodeJS.ProcessEnv = process.env,
): MaterialProviderAvailability {
  const raw = config.platform[manifest.id];
  const providerConfig = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const effectiveConfig = { ...providerConfig };
  for (const [key, field] of Object.entries(manifest.configSchema ?? {})) {
    if (hasValue(effectiveConfig[key])) continue;
    const envName = (field.env ?? []).find((name) => hasValue(env[name]));
    if (envName) effectiveConfig[key] = env[envName];
  }
  const intent = resolveProviderIntent(providerConfig);
  const enabled = intent !== "disabled";
  const missingConfigKeys = missingProviderConfigKeys(effectiveConfig, manifest.configSchema);
  const configured = missingConfigKeys.length === 0;
  return {
    providerConfig,
    effectiveConfig,
    intent,
    enabled,
    configured,
    available: enabled && configured,
    missingConfigKeys,
  };
}
