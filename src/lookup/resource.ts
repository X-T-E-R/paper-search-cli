import type { ResolvedConfig } from "../config/schema.js";
import type { Creator, ResourceItem } from "../providers/sdk/types.js";
import { normalizeDoi, normalizeExactIdentifier } from "../identifiers/paper.js";
import { loadInstalledProviderRuntime } from "../search/runtime.js";
import type {
  AssessmentIdentityEvidence,
  AssessmentObservation,
  PostPublicationEventType,
} from "../assessment/types.js";
import {
  runMaterialExtractionProviderProbe,
  type MaterialExtractionProviderProbeData,
} from "../material/extract.js";
import { runJinaReaderUrlProbe } from "./jinaReader.js";

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
    publicationDateSource?: string;
    provider?: string;
    formats?: string[];
    detectedDoi?: string;
    fallback?: UrlLookupFallbackProvenance;
  };
  postPublication?: PostPublicationAssessment;
}

export type PostPublicationStatus = "clear" | "retracted" | "corrected" | "unknown";

/**
 * A source-scoped convenience projection over assessment-schema evidence.
 * `clear` means the named provider query completed and returned no registered
 * update record; it is not a universal assertion that no later event exists.
 */
export interface PostPublicationAssessment {
  status: PostPublicationStatus;
  scope: "crossref-registered-updates";
  observedAt: string;
  provider: {
    id: "crossref";
    version: "rest-v1";
    queryUrl: string;
    query: {
      filter: "updates";
      targetDoi: string;
      rows: 100;
    };
    resultCount?: number;
  };
  identityEvidence: AssessmentIdentityEvidence[];
  observations: AssessmentObservation[];
  caveats: string[];
}

export interface LookupDeps {
  fetch: typeof fetch;
  now?: () => Date;
  extractUrl?: (config: ResolvedConfig, url: string) => Promise<MaterialExtractionProviderProbeData>;
  searchArxiv?: (
    config: ResolvedConfig,
    identifier: string,
  ) => Promise<ArxivProviderSearchResult>;
}

export interface ArxivProviderSearchResult {
  providerId: string;
  items: ResourceItem[];
  error?: string;
}

export interface UrlLookupFallbackProvenance {
  sourceUrl: string;
  provider: {
    id: string;
    name: string;
    version: string;
  };
  policy: string;
  primaryFailure: {
    status: number;
    statusText: string;
  };
  providerMetadata?: unknown;
  message?: string;
  attempts?: Array<{
    provider: string;
    status: "failed" | "succeeded";
    error?: string;
  }>;
}

class LookupHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} ${statusText}`);
    this.name = "LookupHttpError";
  }
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

interface CrossrefUpdateRelation {
  DOI?: string;
  type?: string;
  label?: string;
  updated?: { "date-time"?: string };
}

interface CrossrefUpdateWork {
  DOI?: string;
  URL?: string;
  title?: string[];
  type?: string;
  "update-to"?: CrossrefUpdateRelation[];
  created?: { "date-time"?: string };
  updated?: { "date-time"?: string };
}

interface CrossrefUpdateResponse {
  message?: {
    "total-results"?: number;
    items?: CrossrefUpdateWork[];
  };
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

function createWebPageItem(
  url: string,
  title?: string,
  description?: string,
  doi?: string,
  date?: string,
  source = "url-lookup",
): ResourceItem {
  return {
    itemType: "webpage",
    title: trimToUndefined(title) ?? url,
    url,
    DOI: trimToUndefined(doi),
    date: trimToUndefined(date),
    abstractNote: trimToUndefined(description),
    accessDate: new Date().toISOString(),
    source,
  };
}

interface MarkdownPageMetadata {
  title?: string;
  titleSource?: string;
  publicationDate?: string;
  publicationDateSource?: string;
}

function cleanMarkdownInline(value: string): string | undefined {
  const cleaned = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`~]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 1024) : undefined;
}

function normalizeEstablishedDate(value: string): string | undefined {
  const trimmed = value.trim().replace(/[.,;]$/u, "");
  const timestamp = trimmed.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u);
  if (timestamp?.[1]) return normalizeEstablishedDate(timestamp[1]);
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (iso) {
    const date = new Date(`${trimmed}T00:00:00.000Z`);
    return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== trimmed ? undefined : trimmed;
  }
  if (!/^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}$/iu.test(trimmed)) {
    return undefined;
  }
  const parsed = new Date(`${trimmed} 00:00:00 UTC`);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString().slice(0, 10);
}

function extractMarkdownPageMetadata(markdown: string): MarkdownPageMetadata {
  const lines = markdown.replace(/^\uFEFF/u, "").split(/\r?\n/u).slice(0, 120);
  let title: string | undefined;
  let titleSource: string | undefined;
  let publicationDate: string | undefined;
  let publicationDateSource: string | undefined;

  if (lines[0]?.trim() === "---") {
    const end = lines.slice(1, 40).findIndex((line) => line.trim() === "---");
    if (end >= 0) {
      for (const line of lines.slice(1, end + 1)) {
        const titleMatch = line.match(/^title\s*:\s*(.+)$/iu);
        if (!title && titleMatch?.[1]) {
          title = cleanMarkdownInline(titleMatch[1].replace(/^['"]|['"]$/gu, ""));
          titleSource = title ? "provider-markdown-frontmatter" : undefined;
        }
        const dateMatch = line.match(/^(?:date|published|publication_date)\s*:\s*(.+)$/iu);
        if (!publicationDate && dateMatch?.[1]) {
          publicationDate = normalizeEstablishedDate(dateMatch[1].replace(/^['"]|['"]$/gu, ""));
          publicationDateSource = publicationDate ? "provider-markdown-frontmatter" : undefined;
        }
      }
    }
  }

  const significant = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line.length > 0);
  if (!title) {
    const labeledTitle = significant.slice(0, 20).find(({ line }) => /^title\s*:\s*\S/iu.test(line));
    if (labeledTitle) {
      title = cleanMarkdownInline(labeledTitle.line.replace(/^title\s*:\s*/iu, ""));
      titleSource = title ? "provider-markdown-labeled-title" : undefined;
    }
  }
  if (!title) {
    const heading = significant.find(({ line }) => /^#\s+\S/u.test(line));
    if (heading) {
      title = cleanMarkdownInline(heading.line.replace(/^#\s+/u, ""));
      titleSource = title ? "provider-markdown-h1" : undefined;
    }
  }
  if (!publicationDate) {
    const nearTop = significant.slice(0, 20);
    for (const { line } of nearTop) {
      const labeled = line.match(/^(?:published(?: time)?|publication date|date)\s*:?\s*(.+)$/iu);
      const candidate = labeled?.[1] ?? line;
      const normalized = normalizeEstablishedDate(cleanMarkdownInline(candidate) ?? "");
      if (normalized) {
        publicationDate = normalized;
        publicationDateSource = labeled ? "provider-markdown-labeled-date" : "provider-markdown-top-date";
        break;
      }
    }
  }

  return { title, titleSource, publicationDate, publicationDateSource };
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
      throw new LookupHttpError(response.status, response.statusText, url);
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
      throw new LookupHttpError(response.status, response.statusText, url);
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
  const observedAt = (deps.now?.() ?? new Date()).toISOString();
  let postPublication: PostPublicationAssessment;
  const warnings: string[] = [];
  try {
    postPublication = await lookupCrossrefPostPublication(deps, timeoutMs, normalized, observedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Crossref post-publication update lookup failed; status remains unknown: ${message}`);
    postPublication = unavailableCrossrefPostPublication(normalized, observedAt, message);
  }
  return {
    kind: "identifier",
    identifier: normalized,
    identifierType: "doi",
    resolvedBy: "crossref",
    item: toCrossrefItem(message, "doi-lookup"),
    warnings,
    postPublication,
  };
}

function crossrefWorkUrl(doi: string): string {
  return `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
}

function crossrefUpdatesUrl(doi: string): string {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("filter", `updates:${doi}`);
  url.searchParams.set("rows", "100");
  return url.toString();
}

function crossrefSource(sourceUrl: string, sourceRecordId?: string) {
  return {
    providerId: "crossref" as const,
    providerVersion: "rest-v1" as const,
    ...(sourceRecordId ? { sourceRecordId } : {}),
    sourceUrl,
    sourceKind: "provider-api" as const,
  };
}

function postPublicationSubject(doi: string) {
  return {
    kind: "work" as const,
    canonicalId: `doi:${doi}`,
    identifiers: { doi },
  };
}

function classifyCrossrefUpdate(relation: CrossrefUpdateRelation): PostPublicationEventType {
  const type = relation.type?.trim().toLowerCase() ?? "";
  if (type.includes("retract")) return "retraction";
  if (type.includes("correct") || type.includes("corrig") || type.includes("errat")) return "correction";
  if (type.includes("expression") && type.includes("concern")) return "expression_of_concern";
  if (type.includes("reinstate")) return "reinstatement";
  return "other";
}

function compactDescription(...values: Array<string | undefined>): string | undefined {
  const parts = values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return parts.length > 0 ? [...new Set(parts)].join("; ") : undefined;
}

function missingEventObservation(
  doi: string,
  observedAt: string,
  queryUrl: string,
  eventType: "retraction" | "correction",
): AssessmentObservation {
  return {
    observationId: `crossref-${eventType}-not-found`,
    subject: postPublicationSubject(doi),
    signal: { kind: "post_publication_event", eventType },
    status: "not_found",
    observedAt,
    source: crossrefSource(queryUrl, doi),
    scope: "Crossref works whose registered update relationship targets the exact DOI",
    caveats: ["Provider-scoped absence is not proof that no event exists outside Crossref."],
  };
}

function unavailableCrossrefPostPublication(
  doi: string,
  observedAt: string,
  diagnostic: string,
): PostPublicationAssessment {
  const queryUrl = crossrefUpdatesUrl(doi);
  const subject = postPublicationSubject(doi);
  const source = crossrefSource(queryUrl, doi);
  const observations: AssessmentObservation[] = (["retraction", "correction"] as const).map((eventType) => ({
    observationId: `crossref-${eventType}-unavailable`,
    subject,
    signal: { kind: "post_publication_event", eventType },
    status: "unavailable",
    observedAt,
    source,
    scope: "Crossref works whose registered update relationship targets the exact DOI",
    diagnostics: { code: "provider_query_failed", message: diagnostic.slice(0, 2048) },
  }));
  return {
    status: "unknown",
    scope: "crossref-registered-updates",
    observedAt,
    provider: {
      id: "crossref",
      version: "rest-v1",
      queryUrl,
      query: { filter: "updates", targetDoi: doi, rows: 100 },
    },
    identityEvidence: [],
    observations,
    caveats: ["The Crossref update query did not complete; no clear status is asserted."],
  };
}

async function lookupCrossrefPostPublication(
  deps: LookupDeps,
  timeoutMs: number,
  doi: string,
  observedAt: string,
): Promise<PostPublicationAssessment> {
  const queryUrl = crossrefUpdatesUrl(doi);
  const payload = await fetchJson<CrossrefUpdateResponse>(deps, queryUrl, timeoutMs);
  const totalResults = payload.message?.["total-results"];
  const items = payload.message?.items;
  if (!Number.isSafeInteger(totalResults) || !Array.isArray(items)) {
    throw new Error("Crossref update lookup returned no countable works result");
  }

  const subject = postPublicationSubject(doi);
  const observations: AssessmentObservation[] = [];
  for (const [itemIndex, item] of items.entries()) {
    const matchingRelations = (item["update-to"] ?? []).filter((relation) => {
      const target = relation.DOI ? normalizeDoi(relation.DOI) : undefined;
      return target === undefined || target === doi;
    });
    for (const [relationIndex, relation] of matchingRelations.entries()) {
      const eventType = classifyCrossrefUpdate(relation);
      const noticeDoi = relation.DOI && normalizeDoi(relation.DOI) !== doi
        ? normalizeDoi(relation.DOI)
        : item.DOI
          ? normalizeDoi(item.DOI)
          : undefined;
      const description = compactDescription(relation.label, relation.type, item.title?.[0]);
      observations.push({
        observationId: `crossref-update-${itemIndex + 1}-${relationIndex + 1}`,
        subject,
        signal: { kind: "post_publication_event", eventType },
        status: "found",
        value: {
          originalId: `doi:${doi}`,
          ...(noticeDoi ? { noticeId: `doi:${noticeDoi}` } : {}),
          ...(relation.type ? { relation: relation.type } : {}),
          ...(description ? { description } : {}),
        },
        observedAt,
        ...(relation.updated?.["date-time"] ?? item.updated?.["date-time"] ?? item.created?.["date-time"]
          ? { effectiveAt: relation.updated?.["date-time"] ?? item.updated?.["date-time"] ?? item.created?.["date-time"] }
          : {}),
        source: crossrefSource(queryUrl, item.DOI ? normalizeDoi(item.DOI) : undefined),
        scope: "Crossref registered update relationship targeting the exact DOI",
      });
    }
  }

  const eventTypes = new Set(
    observations
      .filter((observation) => observation.status === "found" && observation.signal.kind === "post_publication_event")
      .map((observation) => observation.signal.kind === "post_publication_event" ? observation.signal.eventType : "other"),
  );
  if (!eventTypes.has("retraction")) observations.push(missingEventObservation(doi, observedAt, queryUrl, "retraction"));
  if (!eventTypes.has("correction")) observations.push(missingEventObservation(doi, observedAt, queryUrl, "correction"));

  let status: PostPublicationStatus;
  if (eventTypes.has("reinstatement") || eventTypes.has("expression_of_concern") || eventTypes.has("other")) {
    status = "unknown";
  } else if (eventTypes.has("retraction")) {
    status = "retracted";
  } else if (eventTypes.has("correction")) {
    status = "corrected";
  } else if (totalResults === 0) {
    status = "clear";
  } else {
    status = "unknown";
  }

  const identitySource = crossrefSource(crossrefWorkUrl(doi), doi);
  return {
    status,
    scope: "crossref-registered-updates",
    observedAt,
    provider: {
      id: "crossref",
      version: "rest-v1",
      queryUrl,
      query: { filter: "updates", targetDoi: doi, rows: 100 },
      resultCount: totalResults,
    },
    identityEvidence: [{
      evidenceId: "crossref-doi-exact",
      status: "found",
      inputIdentifiers: { doi },
      matchedSubject: subject,
      matchedIdentifiers: { doi },
      matchMethod: "exact_identifier",
      observedAt,
      source: identitySource,
    }],
    observations,
    caveats: status === "clear"
      ? ["Clear is scoped to a completed Crossref registered-update query at observedAt; it is not a universal absence claim."]
      : ["Status reflects Crossref registered update relationships for the exact DOI at observedAt."],
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
  config: ResolvedConfig,
  deps: LookupDeps,
  arxiv: string,
  identity?: Pick<ResourceLookupResult, "identifier" | "identifierType">,
): Promise<ResourceLookupResult> {
  const normalized = normalizeExactIdentifier("arxiv", arxiv);
  const search = deps.searchArxiv ?? searchInstalledArxiv;
  const providerResult = await search(config, normalized);
  if (providerResult.error) {
    throw new Error(`arXiv provider ${providerResult.providerId} failed: ${providerResult.error}`);
  }
  const item = providerResult.items.find((candidate) => itemMatchesArxiv(candidate, normalized));
  if (!item) {
    throw new Error(
      `arXiv provider ${providerResult.providerId} returned no exact record for arXiv:${normalized}`,
    );
  }
  return {
    kind: "identifier",
    identifier: identity?.identifier ?? normalized,
    identifierType: identity?.identifierType ?? "arxiv",
    resolvedBy: providerResult.providerId,
    item: {
      ...item,
      source: item.source ?? providerResult.providerId,
    },
    warnings: [],
  };
}

async function searchInstalledArxiv(
  config: ResolvedConfig,
  identifier: string,
): Promise<ArxivProviderSearchResult> {
  const { provider, runtime } = await loadInstalledProviderRuntime(config, "arxiv", "academic");
  const result = await runtime.provider.search(identifier, {
    maxResults: 5,
    page: 1,
    sortBy: "relevance",
  });
  return {
    providerId: provider.id,
    items: result.items,
    ...(result.error ? { error: result.error } : {}),
  };
}

function normalizedArxivCandidate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return normalizeExactIdentifier("arxiv", value);
  } catch {
    return undefined;
  }
}

function itemMatchesArxiv(item: ResourceItem, identifier: string): boolean {
  const extraIdentifier = item.extra?.match(/(?:^|\n)arXiv ID:\s*(\S+)/iu)?.[1];
  return [item.sourceId, item.url, extraIdentifier]
    .some((candidate) => normalizedArxivCandidate(candidate) === identifier);
}

function arxivIdentifierFromDoi(identifier: string): string | undefined {
  const normalized = normalizeDoi(identifier);
  const match = normalized.match(/^10\.48550\/arxiv\.(.+)$/u);
  return match?.[1] ? normalizeExactIdentifier("arxiv", match[1]) : undefined;
}

async function lookupUrl(
  config: ResolvedConfig,
  deps: LookupDeps,
  timeoutMs: number,
  request: Required<Pick<ResourceLookupRequest, "url">> & Pick<ResourceLookupRequest, "formats" | "provider">,
): Promise<ResourceLookupResult> {
  const url = new URL(request.url).toString();
  let text: string;
  let contentType: string | null;
  try {
    ({ text, contentType } = await fetchText(deps, url, timeoutMs, {
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      },
    }));
  } catch (error) {
    if (!(error instanceof LookupHttpError) || ![401, 403, 429].includes(error.status)) throw error;
    return lookupUrlWithExtractionProvider(config, deps, request, url, error);
  }
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

async function lookupUrlWithExtractionProvider(
  config: ResolvedConfig,
  deps: LookupDeps,
  request: Required<Pick<ResourceLookupRequest, "url">> & Pick<ResourceLookupRequest, "formats" | "provider">,
  url: string,
  primaryFailure: LookupHttpError,
): Promise<ResourceLookupResult> {
  const policy = "url-metadata-fallback";
  const probes: Array<{
    label: string;
    run: () => Promise<MaterialExtractionProviderProbeData>;
  }> = deps.extractUrl
    ? [{ label: "managed extraction provider", run: () => deps.extractUrl!(config, url) }]
    : [
        {
          label: "managed material extraction provider",
          run: () => runMaterialExtractionProviderProbe({ config, input: url, policy }),
        },
        {
          label: "Jina Reader exact-URL provider",
          run: () => runJinaReaderUrlProbe(url, policy),
        },
      ];
  const attempts: NonNullable<UrlLookupFallbackProvenance["attempts"]> = [];
  let extracted: MaterialExtractionProviderProbeData | undefined;
  let established: MarkdownPageMetadata | undefined;
  for (const probe of probes) {
    try {
      const candidate = await probe.run();
      if (
        candidate.source.kind !== "url" ||
        typeof candidate.source.url !== "string" ||
        new URL(candidate.source.url).toString() !== url
      ) {
        throw new Error("provider did not preserve the exact requested URL identity");
      }
      const candidateMetadata = extractMarkdownPageMetadata(candidate.markdown);
      if (!candidateMetadata.title) {
        throw new Error("provider returned no structured page title; identity remains unverified");
      }
      extracted = candidate;
      established = candidateMetadata;
      attempts.push({ provider: candidate.provider.id, status: "succeeded" });
      break;
    } catch (error) {
      attempts.push({
        provider: probe.label,
        status: "failed",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
      });
    }
  }
  if (!extracted || !established) {
    const fallbackMessage = attempts.map((attempt) => `${attempt.provider}: ${attempt.error ?? attempt.status}`).join("; ");
    throw new Error(
      `Direct URL metadata fetch failed (${primaryFailure.message}); exact-URL extraction fallbacks also failed: ${fallbackMessage}`,
    );
  }

  const warnings = [
    `Direct URL metadata fetch failed (${primaryFailure.message}); used exact-URL extraction provider ${extracted.provider.id}.`,
    "Fallback metadata includes only fields explicitly established from the exact-URL extraction.",
  ];
  if (request.formats && request.formats.length > 0) {
    warnings.push("URL lookup returns normalized metadata only; use the extract capability for retained content extraction.");
  }
  if (request.provider && request.provider !== "auto") {
    warnings.push(`URL lookup provider hint ${request.provider} did not select the managed extraction fallback.`);
  }
  const fallback: UrlLookupFallbackProvenance = {
    sourceUrl: url,
    provider: {
      id: extracted.provider.id,
      name: extracted.provider.name,
      version: extracted.provider.version,
    },
    policy: extracted.policy,
    primaryFailure: {
      status: primaryFailure.status,
      statusText: primaryFailure.statusText,
    },
    ...(extracted.metadata !== undefined ? { providerMetadata: extracted.metadata } : {}),
    ...(extracted.message !== undefined ? { message: extracted.message } : {}),
    attempts,
  };
  return {
    kind: "url",
    url,
    resolvedBy: extracted.provider.id,
    item: createWebPageItem(
      url,
      established.title,
      undefined,
      undefined,
      established.publicationDate,
      `${extracted.provider.id}-url-lookup`,
    ),
    warnings,
    metadata: {
      contentType: "text/markdown",
      titleSource: established.titleSource,
      publicationDateSource: established.publicationDateSource,
      provider: extracted.provider.id,
      formats: request.formats,
      fallback,
    },
  };
}

export function detectIdentifierType(identifier: string): LookupIdentifierType {
  const trimmed = identifier.trim();
  if (/^10\.\d{4,}\//i.test(normalizeDoi(trimmed))) return "doi";
  if (
    /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/iu.test(trimmed) ||
    /^(arxiv:)/i.test(trimmed)
  ) {
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
    return lookupUrl(config, deps, timeoutMs, {
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
    case "doi": {
      const normalizedDoi = normalizeDoi(normalizedIdentifier);
      const arxivIdentifier = arxivIdentifierFromDoi(normalizedDoi);
      if (arxivIdentifier) {
        return lookupArxiv(config, deps, arxivIdentifier, {
          identifier: normalizedDoi,
          identifierType: "doi",
        });
      }
      return lookupDoi(deps, timeoutMs, normalizedIdentifier);
    }
    case "pmid":
      return lookupPmid(deps, timeoutMs, normalizedIdentifier);
    case "isbn":
      return lookupIsbn(deps, timeoutMs, normalizedIdentifier);
    case "arxiv":
      return lookupArxiv(config, deps, normalizedIdentifier);
    default:
      throw new Error(`Unsupported identifier type: ${identifierType satisfies never}`);
  }
}
