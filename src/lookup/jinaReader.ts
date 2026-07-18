import type { MaterialExtractionProviderProbeData } from "../material/extract.js";
import { safeExternalHttpsRequest } from "../runtime/safeExternalHttps.js";

const JINA_READER_ORIGIN = "https://r.jina.ai";
const JINA_READER_TIMEOUT_MS = 60_000;
const CHALLENGE_MARKERS = [
  "title: just a moment",
  "checking if the site connection is secure",
  "attention required! | cloudflare",
  "enable javascript and cookies to continue",
];

function assertJinaReaderEndpoint(value: string): void {
  const candidate = new URL(value);
  if (candidate.origin !== JINA_READER_ORIGIN) {
    throw new Error(`Jina Reader fallback rejected unexpected provider origin ${candidate.origin}`);
  }
}

function assertUsefulMarkdown(markdown: string): void {
  const normalized = markdown.trim().toLowerCase();
  if (!normalized) throw new Error("Jina Reader returned empty content");
  const marker = CHALLENGE_MARKERS.find((candidate) => normalized.includes(candidate));
  if (marker) throw new Error(`Jina Reader returned a challenge page (${marker})`);
}

function assertExactReportedSource(markdown: string, requestedUrl: string): void {
  const sourceLine = markdown
    .split(/\r?\n/u)
    .slice(0, 40)
    .find((line) => /^URL Source\s*:\s*\S/iu.test(line.trim()));
  const reported = sourceLine?.trim().replace(/^URL Source\s*:\s*/iu, "");
  if (!reported) throw new Error("Jina Reader did not report the fetched source URL");
  let normalizedReported: string;
  try {
    normalizedReported = new URL(reported).toString();
  } catch {
    throw new Error("Jina Reader reported an invalid source URL");
  }
  if (normalizedReported !== requestedUrl) {
    throw new Error(`Jina Reader source identity mismatch: expected ${requestedUrl}, received ${normalizedReported}`);
  }
}

/**
 * Exact-URL reader fallback adapted from the shared Smart Search Jina Reader
 * provider. It is deliberately read-only and does not use provider caches.
 */
export async function runJinaReaderUrlProbe(
  url: string,
  policy: string,
): Promise<MaterialExtractionProviderProbeData> {
  const normalizedUrl = new URL(url).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JINA_READER_TIMEOUT_MS);
  try {
    const endpoint = `${JINA_READER_ORIGIN}/${normalizedUrl}`;
    const { response, finalUrl } = await safeExternalHttpsRequest({
      url: endpoint,
      init: {
        method: "GET",
        headers: {
          Accept: "text/plain, text/markdown, */*",
          "X-Return-Format": "markdown",
        },
        signal: controller.signal,
      },
      assertAllowed: assertJinaReaderEndpoint,
    });
    if (!response.ok) {
      throw new Error(`Jina Reader returned HTTP ${response.status} ${response.statusText}`.trim());
    }
    const markdown = (await response.text()).trim();
    assertUsefulMarkdown(markdown);
    assertExactReportedSource(markdown, normalizedUrl);
    return {
      source: { kind: "url", url: normalizedUrl },
      markdown,
      metadata: {
        endpoint: JINA_READER_ORIGIN,
        finalProviderUrl: finalUrl,
        contentType: response.headers.get("content-type") ?? undefined,
      },
      cacheHit: false,
      message: "Jina Reader fetched and verified the exact requested URL.",
      provider: {
        id: "jina-reader",
        name: "Jina Reader",
        version: "reader-api-v1",
        packagePath: "builtin:lookup/jina-reader",
      },
      policy,
    };
  } finally {
    clearTimeout(timeout);
  }
}
