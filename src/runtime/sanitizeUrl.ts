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
