export interface UnusableMaterialContent {
  kind: "challenge" | "error";
  marker: string;
}

const CHALLENGE_MARKERS = [
  "title: just a moment",
  "checking if the site connection is secure",
  "checking your browser before accessing",
  "attention required! | cloudflare",
  "enable javascript and cookies to continue",
  "radware bot manager captcha",
  "please verify you are a human",
  "please verify that you are human",
];

const HTML_ERROR_TITLES = new Set([
  "access denied",
  "bad gateway",
  "forbidden",
  "gateway timeout",
  "internal server error",
  "not found",
  "request blocked",
  "service unavailable",
]);

function normalizedTagText(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * Identify known browser challenges and structurally explicit HTML error pages.
 * This is deliberately semantic rather than length-based: short legitimate
 * Markdown and HTML remain valid material.
 */
export function detectUnusableMaterialContent(content: string): UnusableMaterialContent | undefined {
  const normalized = content.trim().toLowerCase();
  const marker = CHALLENGE_MARKERS.find((candidate) => normalized.includes(candidate));
  if (marker) return { kind: "challenge", marker };

  const firstLine = normalized.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  const challengeHeading = firstLine.match(/^(?:title\s*:\s*|#{1,6}\s*)?(human verification|captcha)(?:\s*$|\s*[-:|])/iu);
  if (challengeHeading?.[1]) {
    return { kind: "challenge", marker: challengeHeading[1].toLowerCase() };
  }

  const challengeTitle = normalized.match(/<(?:title|h1)\b[^>]*>\s*([^<]*(?:captcha|human verification)[^<]*)<\/(?:title|h1)>/iu);
  if (challengeTitle?.[1]) {
    return { kind: "challenge", marker: normalizedTagText(challengeTitle[1]) };
  }

  for (const match of normalized.matchAll(/<(?:title|h1)\b[^>]*>\s*([^<]+?)\s*<\/(?:title|h1)>/giu)) {
    const title = normalizedTagText(match[1]!);
    const withoutStatus = title.replace(/^[45]\d{2}\s*(?:[-:|]\s*)?/u, "");
    if (HTML_ERROR_TITLES.has(title) || HTML_ERROR_TITLES.has(withoutStatus)) {
      return { kind: "error", marker: title };
    }
  }

  return undefined;
}
