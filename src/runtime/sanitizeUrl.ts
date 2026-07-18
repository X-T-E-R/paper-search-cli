const SECRET_KEY_RE = /(?:api[-_]?key|token|secret|password|credential)/iu;
const URL_USERINFO_RE = /(^[a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]+@/iu;

function maskUserinfo(value: string): string {
  return value.replace(URL_USERINFO_RE, "$1<masked>@");
}

function maskQueryValue(match: string, prefix: string, rawKey: string): string {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    // Match the undecoded key when malformed percent escapes prevent decoding.
  }
  return SECRET_KEY_RE.test(key) ? `${prefix}${rawKey}=<masked>` : match;
}

export function sanitizeUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "<masked>";
    if (url.password) url.password = "<masked>";
    for (const [key] of url.searchParams) {
      if (SECRET_KEY_RE.test(key)) url.searchParams.set(key, "<masked>");
    }
    // WHATWG URL intentionally does not expose username/password for every
    // Git-supported transport (notably file:// authorities). Apply a final
    // scheme-level userinfo mask so public plans cannot leak those forms.
    return maskUserinfo(url.toString());
  } catch {
    return maskUserinfo(value).replace(
      /([?&])([^=&#]+)=[^&#]*/gu,
      maskQueryValue,
    );
  }
}

/**
 * Durable and user-visible URL form. Query keys are useful provenance, but
 * query values and fragments may carry short-lived credentials and are never
 * retained.
 */
export function sanitizeUrlForPersistence(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return sanitizeUrlForDisplay(value);
    }
    if (url.username) url.username = "<masked>";
    if (url.password) url.password = "<masked>";
    const keys = [...url.searchParams.keys()];
    url.search = "";
    for (const key of keys) url.searchParams.append(key, "<redacted>");
    url.hash = "";
    return url.toString();
  } catch {
    return sanitizeUrlForDisplay(value)
      .replace(/([?&])([^=&#]+)=[^&#]*/gu, "$1$2=<redacted>")
      .replace(/#.*$/u, "");
  }
}

const HTTP_URL_IN_TEXT_RE = /https?:\/\/[^\s<>"']+/giu;

export function sanitizeUrlsForPersistenceInText(value: string): string {
  return value.replace(HTTP_URL_IN_TEXT_RE, (candidate) => {
    const trailing = candidate.match(/[),.;:!?]+$/u)?.[0] ?? "";
    const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
    return `${sanitizeUrlForPersistence(url)}${trailing}`;
  });
}

export function sanitizeForPersistence<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeUrlsForPersistenceInText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForPersistence(entry)) as T;
  }
  if (value && typeof value === "object") {
    // Provider values can originate in a Node vm realm, where the realm's
    // Object.prototype is not reference-equal to the host Object.prototype.
    // The intrinsic tag still distinguishes record-like values from URL,
    // Date, Buffer, Error, and other objects that should remain opaque here.
    if (Object.prototype.toString.call(value) !== "[object Object]") return value;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = sanitizeForPersistence(entry);
    }
    return result as T;
  }
  return value;
}
