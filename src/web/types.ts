export type SearchMode =
  | "auto"
  | "web"
  | "news"
  | "social"
  | "docs"
  | "research"
  | "github"
  | "pdf";

export type SearchIntent =
  | "auto"
  | "factual"
  | "status"
  | "comparison"
  | "tutorial"
  | "exploratory"
  | "news"
  | "resource";

export type ResolvedSearchIntent = Exclude<SearchIntent, "auto">;
export type SearchStrategy = "auto" | "fast" | "balanced" | "verify" | "deep";
export type ResolvedSearchStrategy = Exclude<SearchStrategy, "auto">;
export type WebProviderName = "auto" | "tavily" | "firecrawl" | "exa" | "xai" | "mysearch";
export type ConcreteWebProviderName = Exclude<WebProviderName, "auto">;

export interface WebSearchRequest {
  query: string;
  mode?: SearchMode;
  intent?: SearchIntent;
  strategy?: SearchStrategy;
  provider?: WebProviderName;
  sources?: string[];
  maxResults?: number;
  includeContent?: boolean;
  includeAnswer?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  allowedXHandles?: string[];
  excludedXHandles?: string[];
  fromDate?: string;
  toDate?: string;
}

export interface WebResearchRequest {
  query: string;
  webMaxResults?: number;
  socialMaxResults?: number;
  scrapeTopN?: number;
  includeSocial?: boolean;
  mode?: SearchMode;
  intent?: SearchIntent;
  strategy?: SearchStrategy;
  includeDomains?: string[];
  excludeDomains?: string[];
  allowedXHandles?: string[];
  excludedXHandles?: string[];
  fromDate?: string;
  toDate?: string;
}

export interface WebSearchResult {
  provider: string;
  source: string;
  title: string;
  url: string;
  snippet: string;
  content: string;
  score?: number;
  published_date?: string;
  author?: string;
  created_at?: string;
  matched_providers?: string[];
}

export interface WebSearchResponse {
  provider: string;
  query: string;
  answer: string;
  results: WebSearchResult[];
  citations: Array<{ title: string; url: string }>;
  intent?: string;
  strategy?: string;
  route?: { selected: string; reason: string };
  error?: string;
}

export interface WebExtractResponse {
  provider: string;
  url: string;
  content: string;
  metadata?: Record<string, unknown>;
  warning?: string;
  fallback?: { from: string; reason: string };
}

export interface WebResearchResponse {
  provider: string;
  query: string;
  intent: string;
  strategy: string;
  web_search: WebSearchResponse;
  pages: Array<{
    url: string;
    content?: string;
    excerpt?: string;
    metadata?: Record<string, unknown>;
    error?: string;
  }>;
  social_search: WebSearchResponse | null;
  social_error: string;
  citations: Array<{ title: string; url: string }>;
  evidence: {
    providers_consulted: string[];
    web_result_count: number;
    page_count: number;
    citation_count: number;
    verification: string;
  };
}

export interface RouteDecision {
  provider: ConcreteWebProviderName;
  reason: string;
  tavilyTopic?: string;
  firecrawlCategories?: string[];
  sources?: string[];
}

export interface WebProviderHealth {
  id: ConcreteWebProviderName;
  name: string;
  sourceType: "web";
  enabled: boolean;
  configured: boolean;
  available: boolean;
  capabilities: string[];
  missingConfigKeys: string[];
  baseUrl: string;
  authMode: string;
  summary: string;
}

export interface WebDeps {
  fetch: typeof fetch;
}
