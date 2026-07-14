export interface Creator {
  firstName?: string;
  lastName: string;
  creatorType: string;
}

export interface Tag {
  tag: string;
  type?: number;
}

export interface ResourceItem {
  itemType: string;
  title: string;
  creators?: Creator[];
  date?: string;
  DOI?: string;
  url?: string;
  abstractNote?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  ISSN?: string;
  ISBN?: string;
  language?: string;
  accessDate?: string;
  rights?: string;
  extra?: string;
  tags?: Tag[];
  country?: string;
  assignee?: string;
  issuingAuthority?: string;
  patentNumber?: string;
  applicationNumber?: string;
  priorityNumbers?: string;
  filingDate?: string;
  issueDate?: string;
  legalStatus?: string;
  references?: string;
  sourceId?: string;
  source?: string;
  relevanceScore?: number;
  citationCount?: number;
}

export interface PatentDetailSection<T = unknown> {
  available: boolean;
  data?: T;
  text?: string;
  urls?: string[];
  entries?: Array<{ date?: string; status?: string; info?: string; code?: string }>;
}

export interface PatentDetailResult {
  item: ResourceItem;
  detail: {
    legalStatus?: PatentDetailSection<
      Array<{ date?: string; status?: string; info?: string; code?: string }>
    >;
    claims?: PatentDetailSection<string>;
    description?: PatentDetailSection<string>;
    pdf?: PatentDetailSection<string[]>;
    images?: PatentDetailSection<string[]>;
  };
}

export interface SearchOptions {
  maxResults?: number;
  page?: number;
  year?: string;
  author?: string;
  sortBy?: "relevance" | "date" | "citations";
  extra?: Record<string, unknown>;
}

export interface SearchResult {
  platform: string;
  query: string;
  totalResults: number;
  items: ResourceItem[];
  page: number;
  elapsed?: number;
  hasMore?: boolean;
  error?: string;
}

export type SourceType = "web" | "academic" | "patent";

export interface ProviderHttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface ProviderHttpRequestOptions {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeout?: number;
  withCredentials?: boolean;
}

export interface ProviderAPI {
  http: {
    get<T = unknown>(
      url: string,
      options?: ProviderHttpRequestOptions,
    ): Promise<ProviderHttpResponse<T>>;
    post<T = unknown>(
      url: string,
      body?: string | Record<string, unknown>,
      options?: {
        headers?: Record<string, string>;
        timeout?: number;
        withCredentials?: boolean;
      },
    ): Promise<ProviderHttpResponse<T>>;
  };
  xml: {
    parse(xml: string): Document;
    getText(doc: Document | Element, tag: string): string | null;
    getTextAll(doc: Document | Element, tag: string): string[];
    getElements(parent: Document | Element, tag: string): Element[];
    getAttribute(el: Element, name: string): string | null;
    getTextContent(el: Element): string | null;
  };
  dom: {
    parseHTML(html: string): Document;
  };
  config: {
    getString(key: string, defaultValue?: string): string;
    getNumber(key: string, defaultValue?: number): number;
    getBool(key: string, defaultValue?: boolean): boolean;
  };
  getGlobalPref(key: string, defaultValue?: string): string;
  getGlobalPrefNumber(key: string, defaultValue?: number): number;
  getGlobalPrefBool(key: string, defaultValue?: boolean): boolean;
  log: {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
  };
  rateLimit: {
    acquire(): Promise<void>;
  };
}

export interface PluggableProviderImpl {
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
  getDetail?(sourceId: string, options?: Record<string, unknown>): Promise<PatentDetailResult>;
}

export type ProviderFactory = (api: ProviderAPI) => PluggableProviderImpl;

export interface ProviderConfigFieldSchema {
  type: "boolean" | "string" | "number";
  default?: boolean | string | number;
  required?: boolean;
  enum?: string[];
  label?: string;
  labelZh?: string;
  description?: string;
  advanced?: boolean;
  placeholder?: string;
  secret?: boolean;
  min?: number;
  max?: number;
}

export interface ProviderHelpExample {
  title?: string;
  titleZh?: string;
  description?: string;
  descriptionZh?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}

export interface ProviderUsageHelp {
  summary?: string;
  summaryZh?: string;
  notes?: string[];
  notesZh?: string[];
  examples?: ProviderHelpExample[];
}

export interface ProviderManifest {
  id: string;
  name: string;
  version: string;
  sourceType: SourceType;
  description?: string;
  author?: string;
  help?: ProviderUsageHelp;
  minPluginVersion?: string;
  permissions: {
    urls: string[];
  };
  configSchema?: Record<string, ProviderConfigFieldSchema>;
  maxResultsLimit?: number;
  rateLimitPerMinute?: number;
  searchTimeoutMs?: number;
  allowedGlobalPrefs?: string[];
  integrity?: { sha256?: string };
}
