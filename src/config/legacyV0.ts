import { isPlainConfigObject, setNestedValue } from "./env.js";
import { UserConfigSchema, type UserConfig } from "./schema.js";
import {
  CONFIGURABLE_FIXED_KEYS,
  classifyConfigKey,
  configKeyToString,
  type ConfigKeyMetadata,
} from "./userConfig.js";

export interface LegacyV0Blocker {
  key: string;
  reason: "unknown-key" | "ambiguous-secret" | "invalid-value";
  detail: string;
}

export interface LegacyV0ParseResult {
  schemaVersion: 0;
  recognized: UserConfig;
  blockers: LegacyV0Blocker[];
}

function flattenUnknown(value: unknown): Array<{ path: string[]; value: unknown }> {
  const entries: Array<{ path: string[]; value: unknown }> = [];
  const visit = (candidate: unknown, prefix: string[]) => {
    if (!isPlainConfigObject(candidate)) {
      entries.push({ path: prefix, value: candidate });
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) visit(nested, [...prefix, key]);
  };
  if (isPlainConfigObject(value)) {
    for (const [key, nested] of Object.entries(value)) visit(nested, [key]);
  }
  return entries;
}

/**
 * Dedicated tolerant parser for the pre-schema config. It never promotes
 * unknown data into the runtime shape: every unrecognized or unclassifiable
 * leaf becomes an explicit migration blocker.
 */
export function parseLegacyV0Config(
  value: unknown,
  metadata: ConfigKeyMetadata = {},
): LegacyV0ParseResult {
  if (!isPlainConfigObject(value)) {
    return {
      schemaVersion: 0,
      recognized: {},
      blockers: [{ key: "<document>", reason: "invalid-value", detail: "Legacy config must be a TOML table" }],
    };
  }
  if ("schemaVersion" in value) {
    return {
      schemaVersion: 0,
      recognized: {},
      blockers: [{ key: "schemaVersion", reason: "invalid-value", detail: "Legacy v0 must omit schemaVersion" }],
    };
  }

  const candidate: Record<string, unknown> = {};
  const blockers: LegacyV0Blocker[] = [];
  for (const entry of flattenUnknown(value)) {
    const key = configKeyToString(entry.path);
    const fixed = (CONFIGURABLE_FIXED_KEYS as readonly string[]).includes(key);
    const dynamic = (entry.path[0] === "api" || entry.path[0] === "platform") && entry.path.length >= 3;
    if (!fixed && !dynamic) {
      blockers.push({ key, reason: "unknown-key", detail: `Unknown legacy config key: ${key}` });
      continue;
    }
    const classification = classifyConfigKey(entry.path, metadata);
    if (classification === "ambiguous") {
      blockers.push({
        key,
        reason: "ambiguous-secret",
        detail: `Legacy config key cannot be safely classified as secret or non-secret: ${key}`,
      });
      continue;
    }
    setNestedValue(candidate, entry.path, entry.value);
  }

  const parsed = UserConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "<document>";
      blockers.push({ key, reason: "invalid-value", detail: issue.message });
    }
  }
  return {
    schemaVersion: 0,
    recognized: parsed.success ? parsed.data : {},
    blockers: blockers.sort((left, right) => left.key.localeCompare(right.key)),
  };
}
