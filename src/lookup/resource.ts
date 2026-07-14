import type { ResolvedConfig } from "../config/schema.js";
import type { Creator, ResourceItem } from "../providers/sdk/types.js";
import { normalizeArxiv, normalizeDoi } from "../identifiers/paper.js";

export type LookupIdentifierType = "doi" | "pmid" | "arxiv" | "isbn";

export interface ResourceLookupRequest {
  identifier?: string;
  identifierType?: LookupIdentifierType;
  url?: string;
  formats?: string[];
  provider?: string;
}

export interface ResourceLookupResult {
  kind: "identifier" | "url";
  identifier?: string;
  identifierType?: LookupIdentifierType;
  url?: string;
  resolvedBy: string;
  item: ResourceItem;
  warnings: string[];
  metadata?: {
    contentType?: string;
    titleSource?: string;
    provider?: string;
    formats?: string[];
    detectedDoi?: string;
  };
}

export interface LookupDeps {
  fetch: typeof fetch;
  now?: () => Date;
}

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
}

interface CrossrefMessage {
  title?: string[];
  subtitle?: string[];
  author?: CrossrefAuthor[];
  "container-title"?: string[];
  DOI?: string;
  URL?: string;
  abstract?: string;
  volume?: string;
  issue?: string;
  page?: string;
  language?: string;
  type?: string;
  publisher?: string;
  ISBN?: string[];
  ISSN?: string[];
  issued?: { "date-parts"?: number[][] };
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
}

interface PubMedSummary {
  uid?: string;
  title?: string;
  pubdate?: string;
  fulljournalname?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  authors?: Array<{ name?: string; authtype?: string }>;
  articleids?: Array<{ idtype?: string; value?: string }>;
}

interface OpenLibraryBook {
  title?: string;
  subtitle?: string;
  url?: string;
  publish_date?: string;
  authors?: Array<{ name?: string }>;
  publishers?: Array<{ name?: string }>;
  identifiers?: Record<string, string[]>;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&#39;": "'",
};

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (match) => HTML_ENTITY_MAP[match] ?? match);
}

function stripHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return trimToUndefined(decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " "));
}

function normalizeDateParts(value?: { "date-parts"?: number[][] }): string | undefined {
  const parts = value?.["date-parts"]?.[0];
  if (!parts || parts.length === 0) return undefined;
  const [year, month, day] = parts;
  if (!year) return undefined;
  const rendered = [year, month, day]
    .filter((part) => typeof part === "number" && Number.isFinite(part))
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")));
  return rendered.join("-");
}

function extractCrossrefDate(message: CrossrefMessage): string | undefined {
  return (
    normalizeDateParts(message.issued) ||
    normalizeDateParts(message["published-print"]) ||
    normalizeDateParts(message["published-online"])
  );
}

function mapCrossrefType(type?: string): ResourceItem["itemType"] {
  switch (type) {
    case "journal-article":
      return "journalArticle";
    case "proceedings-article":
      return "conferencePaper";
    case "book":
      return "book";
    case "book-chapter":
      return "bookSection";
    case "posted-content":
      return "report";
    default:
      return "journalArticle";
  }
}

function mapCrossrefAuthors(authors?: CrossrefAuthor[]): Creator[] | undefined {
  if (!authors || authors.length === 0) return undefined;
  return authors.map((author) => ({
    firstName: author.given,
    lastName: trimToUndefined(author.family) ?? trimToUndefined(author.name) ?? "Unknown",
    creatorType: "author",
  }));
}

function normalizeIsbn(identifier: string): string {
  return identifier.replace(/[^0-9Xx]/g, "").toUpperCase();
}

function cleanAbstract(value?: string): string | undefined {
  return stripHtml(value)?.replace(/\s+/g, " ");
}

function createWebPageItem(url: string, title?: string, description?: string, doi?: string): ResourceItem {
  return {
    itemType: "webpage",
    title: trimToUndefined(title) ?? url,
    url,
    DOI: trimToUndefined(doi),
    abstractNote: trimToUndefined(description),
    accessDate: new Date().toISOString(),
    source: "url-lookup",
  };
}

function findMetaContent(html: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const namePatterns = [
      new RegExp(
        `<meta[^>]+(?:name|property)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']+)["'][^>]*>`,
        "i",
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
        "i",
      ),
    ];
    for (const pattern of namePatterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return decodeHtmlEntities(match[1]).trim();
      }
    }
  }
  return undefined;
}

function extractHtmlTitle(html: string): { title?: string; titleSource?: string; description?: string; doi?: string } {
  const citationTitle = findMetaContent(html, ["citation_title", "dc.title", "og:title", "twitter:title"]);
  const description = findMetaContent(html, [
    "description",
    "og:description",
    "twitter:description",
    "dc.description",
  ]);
  const citationDoi = findMetaContent(html, ["citation_doi", "dc.identifier"]);
  if (citationTitle) {
    return { title: citationTitle, titleSource: "meta", description, doi: citationDoi };
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    title: titleMatch?.[1] ? stripHtml(titleMatch[1]) : undefined,
    titleSource: titleMatch?.[1] ? "title" : undefined,
    description,
    doi: citationDoi,
  };
}

async function fetchJson<T>(
  deps: LookupDeps,
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await deps.fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(
  deps: LookupDeps,
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<{ text: string; contentType: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await deps.fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return {
      text: await response.text(),
      contentType: response.headers.get("content-type"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function toCrossrefItem(message: CrossrefMessage, source: string): ResourceItem {
  return {
    itemType: mapCrossrefType(message.type),
    title:
      trimToUndefined(message.title?.[0]) ??
      trimToUndefined(message.subtitle?.[0]) ??
      "Untitled",
    creators: mapCrossrefAuthors(message.author),
    date: extractCrossrefDate(message),
    DOI: trimToUndefined(message.DOI),
    url: trimToUndefined(message.URL),
    abstractNote: cleanAbstract(message.abstract),
    publicationTitle: trimToUndefined(message["container-title"]?.[0]),
    volume: trimToUndefined(message.volume),
    issue: trimToUndefined(message.issue),
    pages: trimToUndefined(message.page),
    ISSN: trimToUndefined(message.ISSN?.[0]),
    ISBN: trimToUndefined(message.ISBN?.[0]),
    language: trimToUndefined(message.language),
    extra: trimToUndefined(message.publisher),
    source,
  };
}

async function lookupDoi(
  deps: LookupDeps,
  timeoutMs: number,
  doi: string,
): Promise<ResourceLookupResult> {
  const normalized = normalizeDoi(doi);
  const payload = await fetchJson<{ message?: CrossrefMessage }>(
    deps,
    `https://api.crossref.org/works/${encodeURIComponent(normalized)}`,
    timeoutMs,
  );
  const message = payload.message;
  if (!message) {
    throw new Error(`Crossref lookup returned no message for DOI ${normalized}`);
  }
  return {
    kind: "identifier",
    identifier: normalized,
    identifierType: "doi",
    resolvedBy: "crossref",
    item: toCrossrefItem(message, "doi-lookup"),
    warnings: [],
  };
}

async function lookupPmid(
  deps: LookupDeps,
  timeoutMs: number,
  pmid: string,
): Promise<ResourceLookupResult> {
  const payload = await fetchJson<{
    result?: { uids?: string[] } & Record<string, PubMedSummary | string[] | undefined>;
  }>(
    deps,
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${encodeURIComponent(pmid)}`,
    timeoutMs,
  );
  const summary = payload.result?.[pmid] as PubMedSummary | undefined;
  if (!summary) {
    throw new Error(`PubMed lookup returned no summary for PMID ${pmid}`);
  }
  const doi = summary.articleids?.find((entry) => entry.idtype === "doi")?.value;
  return {
    kind: "identifier",
    identifier: pmid,
    identifierType: "pmid",
    resolvedBy: "pubmed-esummary",
    item: {
      itemType: "journalArticle",
      title: trimToUndefined(summary.title) ?? "Untitled",
      creators:
        summary.authors?.map((author) => ({
          lastName: trimToUndefined(author.name) ?? "Unknown",
          creatorType: author.authtype || "author",
        })) ?? [],
      date: trimToUndefined(summary.pubdate),
      DOI: trimToUndefined(doi),
      publicationTitle: trimToUndefined(summary.fulljournalname),
      volume: trimToUndefined(summary.volume),
      issue: trimToUndefined(summary.issue),
      pages: trimToUndefined(summary.pages),
      extra: `PMID: ${pmid}`,
      source: "pmid-lookup",
    },
    warnings: [],
  };
}

async function lookupIsbn(
  deps: LookupDeps,
  timeoutMs: number,
  isbn: string,
): Promise<ResourceLookupResult> {
  const normalized = normalizeIsbn(isbn);
  const payload = await fetchJson<Record<string, OpenLibraryBook>>(
    deps,
    `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(normalized)}&format=json&jscmd=data`,
    timeoutMs,
  );
  const book = payload[`ISBN:${normalized}`];
  if (!book) {
    throw new Error(`OpenLibrary lookup returned no record for ISBN ${normalized}`);
  }
  return {
    kind: "identifier",
    identifier: normalized,
    identifierType: "isbn",
    resolvedBy: "openlibrary",
    item: {
      itemType: "book",
      title:
        trimToUndefined(book.title) ??
        trimToUndefined(book.subtitle) ??
        "Untitled",
      creators:
        book.authors?.map((author) => ({
          lastName: trimToUndefined(author.name) ?? "Unknown",
          creatorType: "author",
        })) ?? [],
      date: trimToUndefined(book.publish_date),
      ISBN: trimToUndefined(book.identifiers?.isbn_13?.[0]) ?? normalized,
      url: trimToUndefined(book.url),
      extra: trimToUndefined(book.publishers?.map((entry) => entry.name).filter(Boolean).join("; ")),
      source: "isbn-lookup",
    },
    warnings: [],
  };
}

async function lookupArxiv(
  deps: LookupDeps,
  timeoutMs: number,
  arxiv: string,
): Promise<ResourceLookupResult> {
  const normalized = normalizeArxiv(arxiv);
  const doiResult = await lookupDoi(deps, timeoutMs, `10.48550/arXiv.${normalized}`);
  return {
    ...doiResult,
    identifier: normalized,
    identifierType: "arxiv",
    item: {
      ...doiResult.item,
      source: "arxiv-lookup",
    },
  };
}

async function lookupUrl(
  deps: LookupDeps,
  timeoutMs: number,
  request: Required<Pick<ResourceLookupRequest, "url">> & Pick<ResourceLookupRequest, "formats" | "provider">,
): Promise<ResourceLookupResult> {
  const url = new URL(request.url).toString();
  const { text, contentType } = await fetchText(deps, url, timeoutMs, {
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    },
  });
  const warnings: string[] = [];
  if (request.formats && request.formats.length > 0) {
    warnings.push("URL lookup returns normalized metadata only; use the extract capability for content extraction.");
  }
  if (request.provider && request.provider !== "auto") {
    warnings.push(`URL lookup ignores provider=${request.provider} and uses direct HTTP metadata capture.`);
  }
  const metadata = extractHtmlTitle(text);
  if (metadata.doi) {
    try {
      const doiResult = await lookupDoi(deps, timeoutMs, metadata.doi);
      return {
        kind: "url",
        url,
        resolvedBy: "url+crossref",
        item: {
          ...doiResult.item,
          url,
          source: "url-lookup",
        },
        warnings,
        metadata: {
          contentType: contentType ?? undefined,
          titleSource: metadata.titleSource,
          provider: request.provider,
          formats: request.formats,
          detectedDoi: metadata.doi,
        },
      };
    } catch (error) {
      warnings.push(
        `Detected DOI ${metadata.doi} in page metadata, but DOI enrichment failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    kind: "url",
    url,
    resolvedBy: "direct-html",
    item: createWebPageItem(url, metadata.title, metadata.description, metadata.doi),
    warnings,
    metadata: {
      contentType: contentType ?? undefined,
      titleSource: metadata.titleSource,
      provider: request.provider,
      formats: request.formats,
      detectedDoi: metadata.doi,
    },
  };
}

export function detectIdentifierType(identifier: string): LookupIdentifierType {
  const trimmed = identifier.trim();
  if (/^10\.\d{4,}\//i.test(normalizeDoi(trimmed))) return "doi";
  if (/^(arxiv:)?\d{4}\.\d{4,}(v\d+)?$/i.test(trimmed) || /^(arxiv:)/i.test(trimmed)) {
    return "arxiv";
  }
  if (/^\d+$/.test(trimmed) && trimmed.length >= 4 && trimmed.length <= 12) return "pmid";
  if (/^(97[89])?\d{9}[\dXx]$/.test(normalizeIsbn(trimmed))) return "isbn";
  return "doi";
}

function isUrlLike(value: string | undefined): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

export async function runResourceLookup(
  config: ResolvedConfig,
  request: ResourceLookupRequest,
  deps: LookupDeps = { fetch: globalThis.fetch, now: () => new Date() },
): Promise<ResourceLookupResult> {
  const timeoutMs = config.defaults.timeoutMs;
  const normalizedUrl = trimToUndefined(request.url);
  const normalizedIdentifier = trimToUndefined(request.identifier);
  if (!deps.fetch) {
    throw new Error("Global fetch is not available");
  }

  if (normalizedUrl || isUrlLike(normalizedIdentifier)) {
    return lookupUrl(deps, timeoutMs, {
      url: normalizedUrl ?? normalizedIdentifier!,
      formats: request.formats,
      provider: request.provider,
    });
  }

  if (!normalizedIdentifier) {
    throw new Error("Provide an identifier or URL");
  }

  const identifierType = request.identifierType ?? detectIdentifierType(normalizedIdentifier);
  switch (identifierType) {
    case "doi":
      return lookupDoi(deps, timeoutMs, normalizedIdentifier);
    case "pmid":
      return lookupPmid(deps, timeoutMs, normalizedIdentifier);
    case "isbn":
      return lookupIsbn(deps, timeoutMs, normalizedIdentifier);
    case "arxiv":
      return lookupArxiv(deps, timeoutMs, normalizedIdentifier);
    default:
      throw new Error(`Unsupported identifier type: ${identifierType satisfies never}`);
  }
}
