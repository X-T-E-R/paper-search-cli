import { sanitizeUrlForDisplay } from "../runtime/sanitizeUrl.js";

const REDACTED = "[redacted]";
const MAX_DEPTH = 40;
const MAX_STRING_LENGTH = 256 * 1024;
const FORBIDDEN_CONTAINER_KEY_RE = /^(?:env|environment|processenv|config|credentials?|rawconfig|configcontents|adapterstderr|stderr|argv|commandline|rawcommand)$/iu;
const BEARER_RE = /\bbearer\s+[^\s,;]+/giu;
const SECRET_ASSIGNMENT_RE = /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|token|credential|cookie)\b(\s*[:=]\s*)([^\s,;&#]+)/giu;
const SECRET_QUERY_RE = /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|token|credential|cookie)=)[^&#\s]+/giu;
const COOKIE_HEADER_RE = /\b(set-cookie|cookie)(\s*:\s*)[^\r\n]+/giu;
const URL_LIKE_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/giu;

function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function isSecretKey(key: string): boolean {
  const tokens = keyTokens(key);
  const joined = tokens.join("");
  if (["auth", "apikey", "accesstoken", "refreshtoken", "privatekey", "setcookie"].includes(joined)) {
    return true;
  }
  if (tokens.some((token) => ["secret", "password", "passwd", "credential", "authorization", "cookie"].includes(token))) {
    return true;
  }
  return tokens.at(-1) === "token";
}

function sanitizeString(value: string): string {
  const sanitized = value
    .replace(URL_LIKE_RE, (url) => sanitizeUrlForDisplay(url))
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT_RE, "$1$2[redacted]")
    .replace(SECRET_QUERY_RE, "$1[redacted]")
    .replace(COOKIE_HEADER_RE, "$1$2[redacted]");
  return sanitized.length <= MAX_STRING_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (depth >= MAX_DEPTH) return "[omitted:max-depth]";
  if (seen.has(value)) return "[omitted:circular]";
  seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof URL) return sanitizeUrlForDisplay(value.toString());
    if (Buffer.isBuffer(value)) return `[omitted:buffer:${value.byteLength}-bytes]`;
    if (Array.isArray(value)) {
      return value.map((entry) => redactValue(entry, seen, depth + 1) ?? null);
    }

    const result: Record<string, unknown> = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || descriptor.enumerable !== true) continue;
      if (isSecretKey(key) || FORBIDDEN_CONTAINER_KEY_RE.test(key)) {
        result[key] = REDACTED;
        continue;
      }
      const redacted = redactValue(descriptor.value, seen, depth + 1);
      if (redacted !== undefined) result[key] = redacted;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Central recursive baseline used by every durable-run persistence path. */
export function redactForRunPersistence(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>(), 0);
}
