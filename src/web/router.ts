import type { ResolvedConfig } from "../config/schema.js";
import type {
  ConcreteWebProviderName,
  ResolvedSearchIntent,
  ResolvedSearchStrategy,
  RouteDecision,
  SearchIntent,
  SearchMode,
  SearchStrategy,
  WebDeps,
  WebExtractResponse,
  WebProviderHealth,
  WebResearchRequest,
  WebResearchResponse,
  WebSearchRequest,
  WebSearchResponse,
} from "./types.js";

const WEB_PROVIDER_NAMES: ConcreteWebProviderName[] = [
  "tavily",
  "firecrawl",
  "exa",
  "xai",
  "mysearch",
];

interface BackendDescriptor {
  id: ConcreteWebProviderName;
  name: string;
  capabilities: string[];
  requiredKeys: string[];
  defaultBaseUrl: string;
  defaultAuthMode: string;
  summary: string;
}

const BACKENDS: Record<ConcreteWebProviderName, BackendDescriptor> = {
  tavily: {
    id: "tavily",
    name: "Tavily",
    capabilities: ["search", "extract"],
    requiredKeys: ["apiKey"],
    defaultBaseUrl: "https://api.tavily.com",
    defaultAuthMode: "body",
    summary: "AI web search and page extraction.",
  },
  firecrawl: {
    id: "firecrawl",
    name: "Firecrawl",
    capabilities: ["search", "extract"],
    requiredKeys: ["apiKey"],
    defaultBaseUrl: "https://api.firecrawl.dev",
    defaultAuthMode: "bearer",
    summary: "Web search and page scraping.",
  },
  exa: {
    id: "exa",
    name: "Exa",
    capabilities: ["search"],
    requiredKeys: ["apiKey"],
    defaultBaseUrl: "https://api.exa.ai",
    defaultAuthMode: "x-api-key",
    summary: "Neural web search.",
  },
  xai: {
    id: "xai",
    name: "xAI",
    capabilities: ["search"],
    requiredKeys: ["apiKey"],
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultAuthMode: "bearer",
    summary: "Web and X search through Grok-compatible APIs.",
  },
  mysearch: {
    id: "mysearch",
    name: "MySearch Proxy",
    capabilities: ["search", "extract", "research"],
    requiredKeys: ["baseUrl"],
    defaultBaseUrl: "",
    defaultAuthMode: "bearer",
    summary: "Unified local or remote gateway for web search, extraction, and research.",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getApiSection(config: ResolvedConfig, provider: ConcreteWebProviderName): Record<string, unknown> {
  const value = config.api[provider];
  return isRecord(value) ? value : {};
}

function stringValue(config: ResolvedConfig, provider: ConcreteWebProviderName, key: string, fallback = ""): string {
  const value = getApiSection(config, provider)[key];
  return typeof value === "string" ? value : fallback;
}

function numberValue(
  config: ResolvedConfig,
  provider: ConcreteWebProviderName,
  key: string,
  fallback: number,
): number {
  const value = getApiSection(config, provider)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(
  config: ResolvedConfig,
  provider: ConcreteWebProviderName,
  key: string,
  fallback: boolean,
): boolean {
  const value = getApiSection(config, provider)[key];
  return typeof value === "boolean" ? value : fallback;
}

function arrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map((item) => String(item).trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function configuredMaxResults(
  config: ResolvedConfig,
  provider: ConcreteWebProviderName,
  requested: number | undefined,
): number {
  const configured = numberValue(config, provider, "maxResults", 0);
  const fallback = configured > 0 ? configured : config.defaults.maxResults;
  if (requested === -1) return fallback;
  if (!requested || requested <= 0) return fallback;
  return requested;
}

function hasValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== undefined && value !== null;
}

export function isWebBackendEnabled(config: ResolvedConfig, provider: ConcreteWebProviderName): boolean {
  return booleanValue(config, provider, "enabled", true);
}

export function isWebBackendConfigured(config: ResolvedConfig, provider: ConcreteWebProviderName): boolean {
  const descriptor = BACKENDS[provider];
  const apiConfig = getApiSection(config, provider);
  return isWebBackendEnabled(config, provider) && descriptor.requiredKeys.every((key) => hasValue(apiConfig[key]));
}

export function getWebProviderHealth(config: ResolvedConfig): WebProviderHealth[] {
  return WEB_PROVIDER_NAMES.map((id) => {
    const descriptor = BACKENDS[id];
    const apiConfig = getApiSection(config, id);
    const missingConfigKeys = descriptor.requiredKeys.filter((key) => !hasValue(apiConfig[key]));
    const enabled = isWebBackendEnabled(config, id);
    const configured = missingConfigKeys.length === 0;
    return {
      id,
      name: descriptor.name,
      sourceType: "web",
      enabled,
      configured,
      available: enabled && configured,
      capabilities: descriptor.capabilities,
      missingConfigKeys,
      baseUrl: stringValue(config, id, "baseUrl", descriptor.defaultBaseUrl),
      authMode: stringValue(config, id, "authMode", descriptor.defaultAuthMode),
      summary: descriptor.summary,
    };
  });
}

export function getWebProviderNames(): ConcreteWebProviderName[] {
  return [...WEB_PROVIDER_NAMES];
}

export function resolveWebIntent(
  query: string,
  mode: SearchMode = "auto",
  intent: SearchIntent = "auto",
  sources: string[] = ["web"],
): ResolvedSearchIntent {
  if (intent !== "auto") return intent as ResolvedSearchIntent;
  const q = query.toLowerCase();
  if (mode === "news") return "news";
  if (mode === "docs" || mode === "github" || mode === "pdf") return "resource";
  if (mode === "research") return "exploratory";
  if (sources.length === 1 && sources[0] === "x") return "status";

  const patterns: Array<[ResolvedSearchIntent, string[]]> = [
    ["news", ["latest", "breaking", "news", "today", "this week", "刚刚", "最新", "新闻", "动态"]],
    ["comparison", [" vs ", "versus", "compare", "comparison", "pros and cons", "对比", "比较", "区别", "哪个好"]],
    ["tutorial", ["how to", "guide", "tutorial", "walkthrough", "教程", "怎么", "如何", "入门"]],
    ["resource", ["docs", "documentation", "api reference", "changelog", "pricing", "readme", "github", "文档", "接口"]],
    ["status", ["status", "incident", "outage", "release", "roadmap", "version", "版本", "发布", "进展", "现状"]],
    ["exploratory", ["why", "impact", "analysis", "trend", "ecosystem", "研究", "原因", "影响", "趋势", "生态"]],
  ];
  for (const [resolvedIntent, keywords] of patterns) {
    if (keywords.some((keyword) => q.includes(keyword))) return resolvedIntent;
  }
  return "factual";
}

export function resolveWebStrategy(
  mode: SearchMode = "auto",
  intent: ResolvedSearchIntent,
  strategy: SearchStrategy = "auto",
  sources: string[] = ["web"],
  includeContent = false,
): ResolvedSearchStrategy {
  if (strategy !== "auto") return strategy as ResolvedSearchStrategy;
  if (sources.includes("web") && sources.includes("x")) return "balanced";
  if (mode === "research") return "deep";
  if (intent === "comparison" || intent === "exploratory") return "verify";
  if (
    includeContent ||
    mode === "docs" ||
    mode === "github" ||
    mode === "pdf" ||
    intent === "resource" ||
    intent === "tutorial"
  ) {
    return "balanced";
  }
  return "fast";
}

function firecrawlCategories(mode: SearchMode, intent: ResolvedSearchIntent): string[] {
  if (mode === "github") return ["github"];
  if (mode === "pdf") return ["pdf"];
  if (mode === "docs" || mode === "research" || intent === "resource" || intent === "tutorial") {
    return ["research"];
  }
  return [];
}

export function routeWebSearch(config: ResolvedConfig, request: WebSearchRequest): RouteDecision {
  const mode = request.mode ?? "auto";
  const sources = request.sources ?? ["web"];
  const intent = resolveWebIntent(request.query, mode, request.intent ?? "auto", sources);
  const provider = request.provider ?? "auto";

  if (provider !== "auto") {
    if (!WEB_PROVIDER_NAMES.includes(provider)) {
      throw new Error(`Unsupported web search provider: ${provider}`);
    }
    if (!isWebBackendConfigured(config, provider)) {
      throw new Error(`Web provider is not configured: ${provider}`);
    }
    if (provider === "tavily") {
      return { provider, reason: "Explicit Tavily", tavilyTopic: mode === "news" ? "news" : "general" };
    }
    if (provider === "firecrawl") {
      return { provider, reason: "Explicit Firecrawl", firecrawlCategories: firecrawlCategories(mode, intent) };
    }
    if (provider === "xai") {
      return { provider, reason: "Explicit xAI", sources };
    }
    return { provider, reason: `Explicit ${BACKENDS[provider].name}` };
  }

  if (booleanValue(config, "mysearch", "proxyFirst", false) && isWebBackendConfigured(config, "mysearch")) {
    return { provider: "mysearch", reason: "MySearch proxyFirst enabled" };
  }

  if (mode === "social" || sources.includes("x")) {
    if (!isWebBackendConfigured(config, "xai") && isWebBackendConfigured(config, "tavily")) {
      return { provider: "tavily", reason: "xAI not configured, fallback to Tavily", tavilyTopic: "general" };
    }
    if (isWebBackendConfigured(config, "xai")) {
      return { provider: "xai", reason: "Social / X search uses xAI", sources: ["x"] };
    }
  }

  if (mode === "docs" || mode === "github" || mode === "pdf") {
    if (isWebBackendConfigured(config, "firecrawl")) {
      return { provider: "firecrawl", reason: "Docs/GitHub/PDF uses Firecrawl", firecrawlCategories: firecrawlCategories(mode, intent) };
    }
    if (isWebBackendConfigured(config, "exa")) return { provider: "exa", reason: "Firecrawl unavailable, docs fallback to Exa" };
  }

  if (request.includeContent) {
    if (isWebBackendConfigured(config, "firecrawl")) {
      return { provider: "firecrawl", reason: "Content requested, Firecrawl preferred", firecrawlCategories: firecrawlCategories(mode, intent) };
    }
    if (isWebBackendConfigured(config, "exa")) return { provider: "exa", reason: "Firecrawl unavailable, content fallback to Exa" };
  }

  if (intent === "news" || intent === "status" || mode === "news") {
    if (isWebBackendConfigured(config, "tavily")) return { provider: "tavily", reason: "News/status uses Tavily", tavilyTopic: "news" };
    if (isWebBackendConfigured(config, "exa")) return { provider: "exa", reason: "Tavily unavailable, news fallback to Exa" };
  }

  if (intent === "resource") {
    if (isWebBackendConfigured(config, "firecrawl")) {
      return { provider: "firecrawl", reason: "Resource query uses Firecrawl", firecrawlCategories: firecrawlCategories("docs", intent) };
    }
    if (isWebBackendConfigured(config, "exa")) return { provider: "exa", reason: "Firecrawl unavailable, resource fallback to Exa" };
  }

  if (isWebBackendConfigured(config, "tavily")) return { provider: "tavily", reason: "Default web search uses Tavily", tavilyTopic: "general" };
  if (isWebBackendConfigured(config, "exa")) return { provider: "exa", reason: "Tavily unavailable, default fallback to Exa" };
  if (isWebBackendConfigured(config, "firecrawl")) return { provider: "firecrawl", reason: "Default fallback to Firecrawl" };
  if (isWebBackendConfigured(config, "mysearch")) return { provider: "mysearch", reason: "Only MySearch proxy is configured" };

  throw new Error("No web search provider is configured");
}

function joinUrl(baseUrl: string, requestPath: string): string {
  if (!baseUrl) {
    throw new Error("Web provider baseUrl is empty");
  }
  return `${baseUrl.replace(/\/+$/u, "")}/${requestPath.replace(/^\/+/u, "")}`;
}

async function postJson(
  config: ResolvedConfig,
  provider: ConcreteWebProviderName,
  requestPath: string,
  payload: unknown,
  headers: Record<string, string>,
  deps: WebDeps,
): Promise<unknown> {
  const baseUrl = stringValue(config, provider, "baseUrl", BACKENDS[provider].defaultBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.defaults.timeoutMs);
  try {
    const response = await deps.fetch(joinUrl(baseUrl, requestPath), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

function citationsFromResults(results: Array<{ title: string; url: string }>): Array<{ title: string; url: string }> {
  return results.filter((item) => item.url).map((item) => ({ title: item.title, url: item.url }));
}

function normalizeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getField(record: unknown, key: string): unknown {
  return isRecord(record) ? record[key] : undefined;
}

async function searchTavily(config: ResolvedConfig, request: WebSearchRequest, decision: RouteDecision, deps: WebDeps): Promise<WebSearchResponse> {
  const apiKey = stringValue(config, "tavily", "apiKey");
  const authMode = stringValue(config, "tavily", "authMode", "body");
  const payload: Record<string, unknown> = {
    query: request.query,
    max_results: configuredMaxResults(config, "tavily", request.maxResults),
    search_depth: request.includeContent ? "advanced" : "basic",
    topic: decision.tavilyTopic ?? "general",
    include_answer: request.includeAnswer ?? true,
    include_raw_content: request.includeContent ?? false,
  };
  if (authMode === "body") payload.api_key = apiKey;
  if (request.includeDomains?.length) payload.include_domains = request.includeDomains;
  if (request.excludeDomains?.length) payload.exclude_domains = request.excludeDomains;
  const headers: Record<string, string> =
    authMode === "bearer" && apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const raw = await postJson(config, "tavily", stringValue(config, "tavily", "searchPath", "/search"), payload, headers, deps);
  const rawResults = normalizeArray(getField(raw, "results"));
  const results = rawResults.map((item) => ({
    provider: "tavily",
    source: "web",
    title: String(getField(item, "title") ?? ""),
    url: String(getField(item, "url") ?? ""),
    snippet: String(getField(item, "content") ?? ""),
    content: request.includeContent ? String(getField(item, "raw_content") ?? "") : "",
    score: typeof getField(item, "score") === "number" ? getField(item, "score") as number : undefined,
  }));
  return {
    provider: "tavily",
    query: String(getField(raw, "query") ?? request.query),
    answer: String(getField(raw, "answer") ?? ""),
    results,
    citations: citationsFromResults(results),
  };
}

async function searchFirecrawl(config: ResolvedConfig, request: WebSearchRequest, decision: RouteDecision, deps: WebDeps): Promise<WebSearchResponse> {
  const apiKey = stringValue(config, "firecrawl", "apiKey");
  const payload: Record<string, unknown> = {
    query: request.query,
    limit: configuredMaxResults(config, "firecrawl", request.maxResults),
  };
  if (decision.firecrawlCategories?.length) {
    payload.categories = decision.firecrawlCategories.map((category) => ({ type: category }));
  }
  if (request.includeContent) {
    payload.scrapeOptions = { formats: ["markdown"], onlyMainContent: true };
  }
  const raw = await postJson(
    config,
    "firecrawl",
    stringValue(config, "firecrawl", "searchPath", "/v2/search"),
    payload,
    apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    deps,
  );
  const data = getField(raw, "data");
  const rawResults = [...normalizeArray(getField(data, "web")), ...normalizeArray(getField(data, "news"))];
  const results = rawResults.map((item) => ({
    provider: "firecrawl",
    source: String(getField(item, "source") ?? "web"),
    title: String(getField(item, "title") ?? ""),
    url: String(getField(item, "url") ?? ""),
    snippet: String(getField(item, "description") ?? getField(item, "markdown") ?? ""),
    content: request.includeContent ? String(getField(item, "markdown") ?? "") : "",
  }));
  return {
    provider: "firecrawl",
    query: request.query,
    answer: "",
    results,
    citations: citationsFromResults(results),
  };
}

async function searchExa(config: ResolvedConfig, request: WebSearchRequest, deps: WebDeps): Promise<WebSearchResponse> {
  const apiKey = stringValue(config, "exa", "apiKey");
  const payload: Record<string, unknown> = {
    query: request.query,
    numResults: configuredMaxResults(config, "exa", request.maxResults),
  };
  if (request.includeContent) payload.text = true;
  if (request.includeDomains?.length) payload.includeDomains = request.includeDomains;
  if (request.excludeDomains?.length) payload.excludeDomains = request.excludeDomains;
  const raw = await postJson(
    config,
    "exa",
    stringValue(config, "exa", "searchPath", "/search"),
    payload,
    apiKey ? { "x-api-key": apiKey } : {},
    deps,
  );
  const rawResults = normalizeArray(getField(raw, "results") ?? getField(raw, "data"));
  const results = rawResults.map((item) => ({
    provider: "exa",
    source: "web",
    title: String(getField(item, "title") ?? ""),
    url: String(getField(item, "url") ?? ""),
    snippet: String(getField(item, "snippet") ?? getField(item, "text") ?? getField(item, "summary") ?? getField(item, "highlight") ?? ""),
    content: request.includeContent ? String(getField(item, "text") ?? "") : "",
    score: typeof getField(item, "score") === "number" ? getField(item, "score") as number : undefined,
    published_date: typeof getField(item, "publishedDate") === "string" ? getField(item, "publishedDate") as string : undefined,
  }));
  return {
    provider: "exa",
    query: request.query,
    answer: String(getField(raw, "answer") ?? ""),
    results,
    citations: citationsFromResults(results),
  };
}

function extractXaiOutputText(payload: unknown): string {
  if (typeof getField(payload, "output_text") === "string") return getField(payload, "output_text") as string;
  const parts: string[] = [];
  for (const item of normalizeArray(getField(payload, "output"))) {
    const content = getField(item, "content");
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    for (const part of normalizeArray(content)) {
      const text = getField(part, "text");
      if (typeof text === "string") parts.push(text);
      else if (isRecord(text) && typeof text.value === "string") parts.push(text.value);
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}

function normalizeCitation(item: unknown): { title: string; url: string } | null {
  if (!isRecord(item)) return null;
  const url = item.url ?? item.target_url ?? item.link ?? item.source_url ?? "";
  const title = item.title ?? item.source_title ?? item.display_text ?? item.text ?? "";
  if (!url && !title) return null;
  return { title: String(title), url: String(url) };
}

function extractXaiCitations(payload: unknown): Array<{ title: string; url: string }> {
  const normalized: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const add = (candidate: unknown) => {
    const citation = normalizeCitation(candidate);
    if (!citation) return;
    if (citation.url && seen.has(citation.url)) return;
    if (citation.url) seen.add(citation.url);
    normalized.push(citation);
  };
  for (const item of normalizeArray(getField(payload, "citations"))) add(item);
  if (normalized.length) return normalized;
  for (const outputItem of normalizeArray(getField(payload, "output"))) {
    for (const contentItem of normalizeArray(getField(outputItem, "content"))) {
      for (const annotation of normalizeArray(getField(contentItem, "annotations"))) {
        add(annotation);
      }
    }
  }
  return normalized;
}

function normalizeXaiCompatibleResponse(raw: unknown, request: WebSearchRequest): WebSearchResponse {
  const rawResults = normalizeArray(getField(raw, "results") ?? getField(raw, "items") ?? getField(raw, "posts") ?? getField(raw, "data"));
  const results = rawResults.map((item) => ({
    provider: "xai",
    source: "x",
    title: String(getField(item, "title") ?? getField(item, "author") ?? getField(item, "handle") ?? getField(item, "username") ?? ""),
    url: String(getField(item, "url") ?? getField(item, "link") ?? ""),
    snippet: String(getField(item, "snippet") ?? getField(item, "summary") ?? getField(item, "content") ?? getField(item, "full_text") ?? getField(item, "text") ?? ""),
    content: String(getField(item, "content") ?? getField(item, "full_text") ?? getField(item, "text") ?? ""),
    author: typeof getField(item, "author") === "string" ? getField(item, "author") as string : undefined,
    created_at: typeof getField(item, "created_at") === "string" ? getField(item, "created_at") as string : undefined,
  }));
  return {
    provider: "xai",
    query: String(getField(raw, "query") ?? request.query),
    answer: String(getField(raw, "answer") ?? getField(raw, "summary") ?? getField(raw, "content") ?? ""),
    results,
    citations: citationsFromResults(results),
  };
}

async function searchXai(config: ResolvedConfig, request: WebSearchRequest, decision: RouteDecision, deps: WebDeps): Promise<WebSearchResponse> {
  const apiKey = stringValue(config, "xai", "apiKey");
  const searchMode = stringValue(config, "xai", "searchMode", "official");
  if (searchMode === "compatible") {
    const payload: Record<string, unknown> = {
      query: request.query,
      source: "x",
      max_results: configuredMaxResults(config, "xai", request.maxResults),
    };
    if (request.allowedXHandles?.length) payload.allowed_x_handles = request.allowedXHandles;
    if (request.excludedXHandles?.length) payload.excluded_x_handles = request.excludedXHandles;
    if (request.fromDate) payload.from_date = request.fromDate;
    if (request.toDate) payload.to_date = request.toDate;
    const raw = await postJson(
      config,
      "xai",
      stringValue(config, "xai", "socialSearchPath", "/social/search"),
      payload,
      apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      deps,
    );
    return normalizeXaiCompatibleResponse(raw, request);
  }

  const sources = decision.sources ?? request.sources ?? ["web"];
  const tools: unknown[] = [];
  if (sources.includes("web")) {
    const webTool: Record<string, unknown> = { type: "web_search" };
    const filters: Record<string, unknown> = {};
    if (request.includeDomains?.length) filters.allowed_domains = request.includeDomains;
    if (request.excludeDomains?.length) filters.excluded_domains = request.excludeDomains;
    if (Object.keys(filters).length) webTool.filters = filters;
    tools.push(webTool);
  }
  if (sources.includes("x")) {
    const xTool: Record<string, unknown> = { type: "x_search" };
    if (request.allowedXHandles?.length) xTool.allowed_x_handles = request.allowedXHandles;
    if (request.excludedXHandles?.length) xTool.excluded_x_handles = request.excludedXHandles;
    if (request.fromDate) xTool.from_date = request.fromDate;
    if (request.toDate) xTool.to_date = request.toDate;
    tools.push(xTool);
  }
  const payload = {
    model: stringValue(config, "xai", "model", "grok-4.20-beta-latest-non-reasoning"),
    input: [
      {
        role: "user",
        content: `${request.query}\n\nReturn up to ${configuredMaxResults(config, "xai", request.maxResults)} relevant results with concise sourcing.`,
      },
    ],
    tools,
    store: false,
  };
  const raw = await postJson(
    config,
    "xai",
    stringValue(config, "xai", "responsesPath", "/responses"),
    payload,
    apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    deps,
  );
  const citations = extractXaiCitations(raw);
  return {
    provider: "xai",
    query: request.query,
    answer: extractXaiOutputText(raw),
    results: citations.map((citation) => ({
      provider: "xai",
      source: sources.includes("x") ? "x" : "web",
      title: citation.title,
      url: citation.url,
      snippet: "",
      content: "",
    })),
    citations,
  };
}

function extractMcpResult(rpcResponse: unknown): unknown {
  const result = getField(rpcResponse, "result");
  const content = getField(result, "content");
  if (Array.isArray(content)) {
    const textContent = content.find((item) => isRecord(item) && item.type === "text");
    if (isRecord(textContent) && typeof textContent.text === "string") {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return { content: textContent.text };
      }
    }
  }
  if (result !== undefined) return result;
  const error = getField(rpcResponse, "error");
  if (isRecord(error)) throw new Error(String(error.message ?? "MCP call failed"));
  return rpcResponse;
}

async function callMySearchTool(
  config: ResolvedConfig,
  toolName: string,
  args: Record<string, unknown>,
  deps: WebDeps,
): Promise<unknown> {
  const apiKey = stringValue(config, "mysearch", "apiKey");
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };
  const raw = await postJson(
    config,
    "mysearch",
    stringValue(config, "mysearch", "mcpPath", "/mcp"),
    payload,
    apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    deps,
  );
  return extractMcpResult(raw);
}

function normalizeSearchResponse(raw: unknown, fallbackProvider: string, query: string): WebSearchResponse {
  const rawResults = normalizeArray(getField(raw, "results"));
  const results = rawResults.map((item) => ({
    provider: String(getField(item, "provider") ?? fallbackProvider),
    source: String(getField(item, "source") ?? "web"),
    title: String(getField(item, "title") ?? ""),
    url: String(getField(item, "url") ?? ""),
    snippet: String(getField(item, "snippet") ?? getField(item, "content") ?? ""),
    content: String(getField(item, "content") ?? ""),
    score: typeof getField(item, "score") === "number" ? getField(item, "score") as number : undefined,
  }));
  const rawCitations = normalizeArray(getField(raw, "citations"))
    .map(normalizeCitation)
    .filter((item): item is { title: string; url: string } => Boolean(item));
  return {
    provider: String(getField(raw, "provider") ?? fallbackProvider),
    query: String(getField(raw, "query") ?? query),
    answer: String(getField(raw, "answer") ?? ""),
    results,
    citations: rawCitations.length > 0 ? rawCitations : citationsFromResults(results),
    intent: typeof getField(raw, "intent") === "string" ? getField(raw, "intent") as string : undefined,
    strategy: typeof getField(raw, "strategy") === "string" ? getField(raw, "strategy") as string : undefined,
    route: isRecord(getField(raw, "route")) ? getField(raw, "route") as { selected: string; reason: string } : undefined,
  };
}

async function searchMySearch(config: ResolvedConfig, request: WebSearchRequest, deps: WebDeps): Promise<WebSearchResponse> {
  const args: Record<string, unknown> = {
    query: request.query,
    mode: request.mode ?? "auto",
    intent: request.intent ?? "auto",
    strategy: request.strategy ?? "auto",
    provider: request.provider ?? "auto",
    max_results: configuredMaxResults(config, "mysearch", request.maxResults),
    include_content: request.includeContent ?? false,
    include_answer: request.includeAnswer ?? true,
  };
  if (request.sources?.length) args.sources = request.sources;
  if (request.includeDomains?.length) args.include_domains = request.includeDomains;
  if (request.excludeDomains?.length) args.exclude_domains = request.excludeDomains;
  if (request.allowedXHandles?.length) args.allowed_x_handles = request.allowedXHandles;
  if (request.excludedXHandles?.length) args.excluded_x_handles = request.excludedXHandles;
  if (request.fromDate) args.from_date = request.fromDate;
  if (request.toDate) args.to_date = request.toDate;
  return normalizeSearchResponse(await callMySearchTool(config, "search", args, deps), "mysearch", request.query);
}

export async function runWebSearch(
  config: ResolvedConfig,
  request: WebSearchRequest,
  deps: WebDeps = { fetch },
): Promise<WebSearchResponse> {
  if (!request.query || typeof request.query !== "string") {
    throw new Error("query is required and must be a string");
  }
  const sources = request.sources ?? ["web"];
  const intent = resolveWebIntent(request.query, request.mode ?? "auto", request.intent ?? "auto", sources);
  const strategy = resolveWebStrategy(
    request.mode ?? "auto",
    intent,
    request.strategy ?? "auto",
    sources,
    request.includeContent ?? false,
  );
  const decision = routeWebSearch(config, request);

  let result: WebSearchResponse;
  switch (decision.provider) {
    case "tavily":
      result = await searchTavily(config, request, decision, deps);
      break;
    case "firecrawl":
      result = await searchFirecrawl(config, request, decision, deps);
      break;
    case "exa":
      result = await searchExa(config, request, deps);
      break;
    case "xai":
      result = await searchXai(config, request, decision, deps);
      break;
    case "mysearch":
      result = await searchMySearch(config, request, deps);
      break;
    default:
      throw new Error(`Unsupported web search provider: ${(decision as RouteDecision).provider}`);
  }
  return {
    ...result,
    intent,
    strategy,
    route: { selected: decision.provider, reason: decision.reason },
  };
}

async function extractUrl(
  config: ResolvedConfig,
  url: string,
  deps: WebDeps,
): Promise<WebExtractResponse> {
  if (booleanValue(config, "mysearch", "proxyFirst", false) && isWebBackendConfigured(config, "mysearch")) {
    const raw = await callMySearchTool(config, "extract_url", {
      url,
      formats: ["markdown"],
      only_main_content: true,
      provider: "auto",
    }, deps);
    return {
      provider: String(getField(raw, "provider") ?? "mysearch"),
      url: String(getField(raw, "url") ?? url),
      content: String(getField(raw, "content") ?? ""),
      metadata: isRecord(getField(raw, "metadata")) ? getField(raw, "metadata") as Record<string, unknown> : undefined,
    };
  }

  const errors: string[] = [];
  if (isWebBackendConfigured(config, "firecrawl")) {
    try {
      const apiKey = stringValue(config, "firecrawl", "apiKey");
      const raw = await postJson(
        config,
        "firecrawl",
        stringValue(config, "firecrawl", "scrapePath", "/v2/scrape"),
        { url, formats: ["markdown"], onlyMainContent: true },
        apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        deps,
      );
      const data = getField(raw, "data");
      const metadata = isRecord(getField(data, "metadata")) ? getField(data, "metadata") as Record<string, unknown> : {};
      const content = String(getField(data, "markdown") ?? (isRecord(getField(data, "json")) ? JSON.stringify(getField(data, "json"), null, 2) : ""));
      if (content.trim()) {
        return {
          provider: "firecrawl",
          url: String(metadata.sourceURL ?? metadata.url ?? url),
          content,
          metadata,
        };
      }
      errors.push("firecrawl returned empty content");
    } catch (error) {
      errors.push(`firecrawl failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (isWebBackendConfigured(config, "tavily")) {
    const apiKey = stringValue(config, "tavily", "apiKey");
    const authMode = stringValue(config, "tavily", "authMode", "body");
    const payload: Record<string, unknown> = { urls: [url] };
    if (authMode === "body") payload.api_key = apiKey;
    const raw = await postJson(
      config,
      "tavily",
      stringValue(config, "tavily", "extractPath", "/extract"),
      payload,
      authMode === "bearer" && apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      deps,
    );
    const first = normalizeArray(getField(raw, "results"))[0];
    return {
      provider: "tavily",
      url: String(getField(first, "url") ?? url),
      content: String(getField(first, "raw_content") ?? getField(first, "content") ?? ""),
      metadata: {
        request_id: getField(raw, "request_id"),
        response_time: getField(raw, "response_time"),
        failed_results: getField(raw, "failed_results"),
        fallback: errors.length > 0 ? errors.join(" | ") : undefined,
      },
    };
  }

  throw new Error(errors.length ? errors.join(" | ") : "No extraction provider available");
}

export async function runWebResearch(
  config: ResolvedConfig,
  request: WebResearchRequest,
  deps: WebDeps = { fetch },
): Promise<WebResearchResponse> {
  if (!request.query || typeof request.query !== "string") {
    throw new Error("query is required and must be a string");
  }
  if (booleanValue(config, "mysearch", "proxyFirst", false) && isWebBackendConfigured(config, "mysearch")) {
    return callMySearchTool(config, "research", {
      query: request.query,
      web_max_results: request.webMaxResults ?? 5,
      social_max_results: request.socialMaxResults ?? 5,
      scrape_top_n: request.scrapeTopN ?? 3,
      include_social: request.includeSocial ?? true,
      mode: request.mode ?? "auto",
      intent: request.intent ?? "auto",
      strategy: request.strategy ?? "auto",
      include_domains: request.includeDomains,
      exclude_domains: request.excludeDomains,
    }, deps) as Promise<WebResearchResponse>;
  }

  const webSearch = await runWebSearch(config, {
    query: request.query,
    mode: request.mode,
    intent: request.intent,
    strategy: request.strategy,
    sources: ["web"],
    maxResults: request.webMaxResults ?? 5,
    includeAnswer: true,
    includeDomains: request.includeDomains,
    excludeDomains: request.excludeDomains,
  }, deps);

  let socialSearch: WebSearchResponse | null = null;
  let socialError = "";
  if ((request.includeSocial ?? true) && isWebBackendConfigured(config, "xai")) {
    try {
      socialSearch = await runWebSearch(config, {
        query: request.query,
        mode: "social",
        provider: "xai",
        sources: ["x"],
        maxResults: request.socialMaxResults ?? 5,
        allowedXHandles: request.allowedXHandles,
        excludedXHandles: request.excludedXHandles,
        fromDate: request.fromDate,
        toDate: request.toDate,
      }, deps);
    } catch (error) {
      socialError = error instanceof Error ? error.message : String(error);
    }
  }

  const urls: string[] = [];
  for (const result of webSearch.results) {
    if (result.url && !urls.includes(result.url) && urls.length < (request.scrapeTopN ?? 3)) {
      urls.push(result.url);
    }
  }

  const pages: WebResearchResponse["pages"] = [];
  for (const url of urls) {
    try {
      const extracted = await extractUrl(config, url, deps);
      const content = extracted.content ?? "";
      pages.push({
        url: extracted.url,
        content,
        excerpt: content.replace(/\s+/g, " ").trim().slice(0, 600),
        metadata: extracted.metadata,
      });
    } catch (error) {
      pages.push({ url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const citations = [...(webSearch.citations ?? [])];
  for (const citation of socialSearch?.citations ?? []) {
    if (!citations.some((existing) => existing.url === citation.url)) citations.push(citation);
  }
  const providersConsulted = [webSearch.provider];
  if (socialSearch) providersConsulted.push(socialSearch.provider);

  return {
    provider: "hybrid",
    query: request.query,
    intent: webSearch.intent ?? "factual",
    strategy: webSearch.strategy ?? "fast",
    web_search: webSearch,
    pages,
    social_search: socialSearch,
    social_error: socialError,
    citations,
    evidence: {
      providers_consulted: providersConsulted,
      web_result_count: webSearch.results.length,
      page_count: pages.filter((page) => !page.error).length,
      citation_count: citations.length,
      verification: providersConsulted.length > 1 ? "cross-provider" : "single-provider",
    },
  };
}
