import { UserConfigSchema, type UserConfig } from "./schema.js";

export interface EnvConfigMapping {
  env: string;
  path: readonly string[];
}

export interface EnvOverrideResult {
  applied: string[];
  patch: UserConfig;
}

export interface ParsedEnvEntry {
  name: string;
  value: string;
  line: number;
}

export const KNOWN_ENV_MAPPINGS: readonly EnvConfigMapping[] = [
  { env: "PAPER_SEARCH_PROVIDERS_REGISTRY_URL", path: ["providers", "registryUrl"] },
  { env: "PAPER_SEARCH_PROVIDERS_INSTALL_DIR", path: ["providers", "installDir"] },
  { env: "PAPER_SEARCH_PROVIDERS_AUTO_UPDATE", path: ["providers", "autoUpdate"] },
  { env: "PAPER_SEARCH_PROVIDERS_ALLOW_RELEASE_FALLBACK", path: ["providers", "allowReleaseFallback"] },
  { env: "PAPER_SEARCH_WORKSPACE_ROOT", path: ["workspace", "root"] },
  { env: "PAPER_SEARCH_WORKSPACE_DEFAULT_SINK", path: ["workspace", "defaultSink"] },
  { env: "PAPER_SEARCH_WORKSPACE_DEFAULT_COLLECTION", path: ["workspace", "defaultCollection"] },
  { env: "PAPER_SEARCH_SERVER_ENABLED", path: ["server", "enabled"] },
  { env: "PAPER_SEARCH_SERVER_TRANSPORT", path: ["server", "transport"] },
  { env: "PAPER_SEARCH_SERVER_HOST", path: ["server", "host"] },
  { env: "PAPER_SEARCH_SERVER_PORT", path: ["server", "port"] },
  { env: "PAPER_SEARCH_DEFAULTS_TIMEOUT_MS", path: ["defaults", "timeoutMs"] },
  { env: "PAPER_SEARCH_DEFAULTS_MAX_RESULTS", path: ["defaults", "maxResults"] },
  { env: "PAPER_SEARCH_OUTPUT_FORMAT", path: ["output", "format"] },
  { env: "PAPER_SEARCH_OUTPUT_LOCALE", path: ["output", "locale"] },
  { env: "PAPER_SEARCH_OUTPUT_PRETTY_JSON", path: ["output", "prettyJson"] },
  { env: "PAPER_SEARCH_SMOKE_ENABLED", path: ["smoke", "enabled"] },
  { env: "PAPER_SEARCH_SMOKE_ENV_VAR", path: ["smoke", "envVar"] },
];

export function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function upperSnakeToCamel(value: string): string {
  return value
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_, part: string) => part.toUpperCase());
}

export function parseConfigScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === "true";
  }
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function setNestedValue(
  target: Record<string, unknown>,
  pathSegments: readonly string[],
  value: unknown,
): void {
  let cursor = target;
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const segment = pathSegments[index]!;
    const existing = cursor[segment];
    if (!isPlainConfigObject(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[pathSegments[pathSegments.length - 1]!] = value;
}

export function envNameToConfigPath(name: string): string[] | null {
  const known = KNOWN_ENV_MAPPINGS.find((mapping) => mapping.env === name);
  if (known) return [...known.path];

  if (name.startsWith("PAPER_SEARCH_PLATFORM__")) {
    const rest = name.slice("PAPER_SEARCH_PLATFORM__".length);
    const segments = rest.split("__").filter(Boolean);
    if (segments.length >= 2) {
      return ["platform", segments[0]!.toLowerCase(), ...segments.slice(1).map(upperSnakeToCamel)];
    }
  }

  if (name.startsWith("PAPER_SEARCH_API__")) {
    const rest = name.slice("PAPER_SEARCH_API__".length);
    const segments = rest.split("__").filter(Boolean);
    if (segments.length >= 2) {
      return ["api", segments[0]!.toLowerCase(), ...segments.slice(1).map(upperSnakeToCamel)];
    }
  }

  return null;
}

export function collectEnvOverrides(env: NodeJS.ProcessEnv): EnvOverrideResult {
  const patch: Record<string, unknown> = {};
  const applied: string[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const pathSegments = envNameToConfigPath(name);
    if (!pathSegments) continue;
    setNestedValue(patch, pathSegments, parseConfigScalar(value));
    applied.push(name);
  }

  return {
    applied: applied.sort((left, right) => left.localeCompare(right)),
    patch: UserConfigSchema.parse(patch),
  };
}

function parseQuotedValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== "\"" && quote !== "'") || trimmed[trimmed.length - 1] !== quote) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  if (quote === "'") return inner;
  return inner.replace(/\\([nrt"\\])/g, (_, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });
}

function stripUnquotedInlineComment(raw: string): string {
  return raw.replace(/\s+#.*$/, "").trim();
}

export function parseEnvFile(content: string): ParsedEnvEntry[] {
  const entries: ParsedEnvEntry[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let line = lines[index]!.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trimStart();
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;
    const name = line.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;

    const rawValue = line.slice(equalsIndex + 1).trim();
    const quoted =
      (rawValue.startsWith("\"") && rawValue.endsWith("\"")) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"));
    entries.push({
      name,
      value: quoted ? parseQuotedValue(rawValue) : stripUnquotedInlineComment(rawValue),
      line: lineNumber,
    });
  }

  return entries;
}
