import { CAPABILITY_MAP, type CapabilityGroup } from "./capabilities.js";

export interface ToolSchema {
  name: string;
  description: string;
  capability: CapabilityGroup;
  annotations?: {
    capabilityGroup: CapabilityGroup;
    capabilityLayer: "work" | "management";
    [key: string]: unknown;
  };
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

type RawToolSchema = Omit<ToolSchema, "capability" | "annotations"> & {
  annotations?: Omit<NonNullable<ToolSchema["annotations"]>, "capabilityGroup" | "capabilityLayer">;
};

const SEARCH_SELECTION_PROPERTIES: Record<string, unknown> = {
  platform: {
    type: "string",
    description: 'Legacy singular provider id, or literal "all". Omit to use configured defaults.',
  },
  provider: {
    type: "string",
    description: "Legacy alias of platform; participates in the same source union.",
  },
  presets: {
    type: "array",
    items: { type: "string" },
    description: "Named presets to expand and union.",
  },
  sources: {
    type: "array",
    items: { type: "string" },
    description: "Provider ids or aliases to add explicitly.",
  },
  categories: {
    type: "array",
    items: { type: "string" },
    description: "Classification selectors such as domain:biomedicine or content:preprint.",
  },
  excludeSources: {
    type: "array",
    items: { type: "string" },
    description: "Provider ids or aliases removed after all positive selectors.",
  },
  excludeCategories: {
    type: "array",
    items: { type: "string" },
    description: "Classification selectors removed before exact source inclusion.",
  },
};

const RAW_TOOL_DEFINITIONS: RawToolSchema[] = [
  {
    name: "mcp_help",
    description:
      "Return local paper-search-cli help, including capability-routed tool summaries, config hints, and provider-specific usage notes.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["overview", "tools", "providers", "patents", "web", "lookup", "workspace", "skills"],
          description: "Optional help topic filter",
        },
        tool: {
          type: "string",
          description: "Optional canonical tool name to focus on",
        },
        provider: {
          type: "string",
          description: "Optional provider id to focus on",
        },
        locale: {
          type: "string",
          enum: ["zh", "en"],
          description: "Preferred response locale",
        },
      },
    },
  },
  {
    name: "academic_search",
    description:
      "Search academic resources across installed academic providers through the local provider-compatible runtime.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        ...SEARCH_SELECTION_PROPERTIES,
        maxResults: {
          type: "number",
          description: "Maximum results per provider. 0 uses the global default.",
        },
        page: { type: "number", description: "Page number (default: 1)" },
        year: {
          type: "string",
          description: 'Year or year range filter (for example "2024" or "2020-2024")',
        },
        author: { type: "string", description: "Author name filter" },
        sortBy: {
          type: "string",
          enum: ["relevance", "date", "citations"],
          description: "Sort criteria (per-provider defaults apply when omitted)",
        },
        extra: {
          type: "object",
          description: "Provider-specific extra parameters",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "resource_lookup",
    description:
      "Look up a resource by DOI, PMID, arXiv ID, ISBN, or URL. Returns normalized metadata and URL capture details; full-text extraction is a separate capability.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Academic identifier (DOI, PMID, arXiv ID, ISBN)",
        },
        identifierType: {
          type: "string",
          enum: ["doi", "pmid", "arxiv", "isbn"],
          description: "Identifier type (auto-detected when omitted)",
        },
        url: {
          type: "string",
          description: "URL to capture and normalize as a local resource item",
        },
        formats: {
          type: "array",
          items: { type: "string" },
          description:
            "Advisory URL extraction formats. The lookup surface accepts the hint but returns normalized metadata only; full-text extraction is a separate capability.",
        },
        provider: {
          type: "string",
          enum: ["auto"],
          description:
            "URL metadata backend hint. The lookup surface uses direct HTTP metadata capture.",
        },
      },
    },
  },
  {
    name: "patent_search",
    description:
      "Search patent resources across installed patent providers through the local provider-compatible runtime.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Patent search query string" },
        ...SEARCH_SELECTION_PROPERTIES,
        maxResults: {
          type: "number",
          description: "Maximum results per provider. 0 uses the global default, -1 uses the source maximum.",
        },
        page: { type: "number", description: "Page number (default: 1)" },
        sortBy: {
          type: "string",
          enum: ["relevance", "date"],
          description: "Patent search sort criteria",
        },
        patentType: {
          type: "string",
          enum: ["all", "invention", "utility_model", "design"],
          description: "Patent type filter",
        },
        legalStatus: {
          type: "string",
          enum: ["all", "valid", "invalid", "pending"],
          description: "Legal status filter",
        },
        database: {
          type: "string",
          enum: ["CN", "WD"],
          description: "PatentStar database: China patents or world patents",
        },
        sortField: {
          type: "string",
          enum: ["applicationDate", "publicationDate"],
          description: "Sort field override",
        },
        sortOrder: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort direction override",
        },
        queryMode: {
          type: "string",
          enum: ["simple", "expert"],
          description: "Treat query as normal keywords or provider-native expert syntax",
        },
        rawQuery: {
          type: "string",
          description: "Provider-native expert query string",
        },
        extra: {
          type: "object",
          description: "Patent-provider-specific extra parameters",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "patent_detail",
    description:
      "Fetch detailed patent data by provider-native patent id. Returns a normalized patent item plus structured detail blocks.",
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          description: "Patent provider id",
        },
        sourceId: {
          type: "string",
          description: "Provider-native patent id, such as PatentStar ANE",
        },
        include: {
          type: "array",
          items: {
            type: "string",
            enum: ["core", "legalStatus", "claims", "description", "pdf", "images"],
          },
          description: "Detail sections to include",
        },
      },
      required: ["platform", "sourceId"],
    },
  },
  {
    name: "web_search",
    description:
      'Unified web search over configured web backends. Auto-routes to Tavily, Firecrawl, Exa, xAI, or MySearch based on query intent. Supports modes like "web", "news", "social", "docs", "research", "github", and "pdf".',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        mode: {
          type: "string",
          enum: ["auto", "web", "news", "social", "docs", "research", "github", "pdf"],
          description: "Search mode (default: auto)",
        },
        intent: {
          type: "string",
          enum: ["auto", "factual", "status", "comparison", "tutorial", "exploratory", "news", "resource"],
          description: "Query intent hint (default: auto)",
        },
        strategy: {
          type: "string",
          enum: ["auto", "fast", "balanced", "verify", "deep"],
          description: "Search strategy (default: auto)",
        },
        provider: {
          type: "string",
          enum: ["auto", "tavily", "firecrawl", "exa", "xai", "mysearch"],
          description: "Force a specific configured provider (default: auto)",
        },
        sources: {
          type: "array",
          items: { type: "string", enum: ["web", "x"] },
          description: 'Search sources, e.g. ["web"], ["x"], or ["web","x"]',
        },
        max_results: {
          type: "number",
          description: "Maximum results. 0 = global/default backend value, -1 = configured backend default.",
        },
        include_content: {
          type: "boolean",
          description: "Include page full text where supported (default: false)",
        },
        include_answer: {
          type: "boolean",
          description: "Include provider-generated answer (default: true)",
        },
        include_domains: {
          type: "array",
          items: { type: "string" },
          description: "Only search these domains",
        },
        exclude_domains: {
          type: "array",
          items: { type: "string" },
          description: "Exclude these domains",
        },
        from_date: { type: "string", description: "Start date filter (YYYY-MM-DD)" },
        to_date: { type: "string", description: "End date filter (YYYY-MM-DD)" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_research",
    description:
      "Multi-step web research workflow: web search plus top-N page extraction and optional X/social search. Returns evidence with citations and extraction status.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Research question" },
        web_max_results: { type: "number", description: "Web search result count (default: 5)" },
        social_max_results: { type: "number", description: "Social search result count (default: 5)" },
        scrape_top_n: { type: "number", description: "How many top URLs to extract (default: 3)" },
        include_social: { type: "boolean", description: "Include X/social search when configured (default: true)" },
        mode: {
          type: "string",
          enum: ["auto", "web", "news", "social", "docs", "research", "github", "pdf"],
          description: "Search mode (default: auto)",
        },
        include_domains: {
          type: "array",
          items: { type: "string" },
          description: "Only search these domains",
        },
        exclude_domains: {
          type: "array",
          items: { type: "string" },
          description: "Exclude these domains",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "resource_add",
    description:
      "Add a normalized resource item or URL into the local workspace sink.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "object", description: "Normalized ResourceItem payload" },
        detail: {
          type: "object",
          description:
            "Optional detail payload stored alongside the item record. Patent detail output can be passed here before resource_add writes to the workspace sink.",
        },
        url: { type: "string", description: "URL-only capture input" },
        collectionKey: {
          type: "string",
          description: "Existing local workspace collection key",
        },
        collectionPath: {
          type: "string",
          description: 'Collection path using "/" separators (for example "Research/Inbox")',
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags to store with the item",
        },
        fetchPDF: {
          type: "boolean",
          description:
            "Record that a PDF fetch was requested. This stores intent only; downloading bytes is a separate action.",
        },
      },
    },
  },
  {
    name: "collection_list",
    description:
      "List local workspace collections and sub-collections. Returns either a tree or a flat path list.",
    inputSchema: {
      type: "object",
      properties: {
        flat: {
          type: "boolean",
          description: "Return a flat list with full paths instead of a tree",
        },
      },
    },
  },
  {
    name: "workspace_export",
    description:
      "Export local workspace items as JSON, JSONL, CSV, or BibTeX. This is a portable local export sink.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["json", "jsonl", "csv", "bibtex"],
          description: "Export format (default: json)",
        },
        collectionKey: {
          type: "string",
          description: "Export only one local collection key",
        },
        collectionPath: {
          type: "string",
          description: 'Export only one local collection path such as "Research/Inbox"',
        },
        includeChildren: {
          type: "boolean",
          description: "Include child collection paths when filtering by collectionPath",
        },
      },
    },
  },
  {
    name: "resource_pdf",
    description:
      "Fetch or record a PDF attachment for an existing local workspace item. Uses the workspace item id as itemKey and stores files under the local attachment sink.",
    inputSchema: {
      type: "object",
      properties: {
        itemKey: {
          type: "string",
          description: "Local workspace item id returned by resource_add",
        },
        url: {
          type: "string",
          description: "Optional explicit PDF URL. When omitted, the CLI looks for PDF URLs in item/detail metadata.",
        },
        filename: {
          type: "string",
          description: "Optional preferred local filename",
        },
        download: {
          type: "boolean",
          description: "Download the PDF into the local attachment sink. Set false to record a request only.",
        },
      },
      required: ["itemKey"],
    },
  },
  {
    name: "artifact_download",
    description:
      "Fetch or record an artifact through an installed material downloader provider, preserving provenance and attempt history.",
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description:
            "Workspace item id, artifact URL, or DOI to acquire. DOI inputs are resolved to candidate URLs through an installed artifact_resolver provider.",
        },
        attachTo: {
          type: "string",
          description: "Optional local workspace item id to attach the artifact record to.",
        },
        attach_to: {
          type: "string",
          description: "Snake-case alias for attachTo.",
        },
        providerId: {
          type: "string",
          description: "Material artifact downloader provider id.",
        },
        provider_id: {
          type: "string",
          description: "Snake-case alias for providerId.",
        },
        provider: {
          type: "string",
          description: "Alias for providerId.",
        },
        resolverId: {
          type: "string",
          description: "Material artifact_resolver provider id used for DOI inputs.",
        },
        resolver_id: {
          type: "string",
          description: "Snake-case alias for resolverId.",
        },
        policy: {
          type: "string",
          description: "Policy label recorded on the acquisition run.",
        },
        download: {
          type: "boolean",
          description: "When false, create a request record without fetching bytes.",
        },
        dryRun: {
          type: "boolean",
          description: "Return the shared acquisition plan without writing files or records.",
        },
        dry_run: {
          type: "boolean",
          description: "Snake-case alias for dryRun.",
        },
      },
      required: ["input"],
    },
  },
  {
    name: "artifact_list",
    description:
      "List artifact records from the local workspace, optionally filtered by attached workspace item.",
    inputSchema: {
      type: "object",
      properties: {
        item: {
          type: "string",
          description: "Only return artifacts attached to this workspace item id.",
        },
        itemId: {
          type: "string",
          description: "Alias for item.",
        },
        item_id: {
          type: "string",
          description: "Snake-case alias for item.",
        },
        standalone: {
          type: "boolean",
          description: "Only return artifacts that are not attached to a workspace item.",
        },
      },
    },
  },
  {
    name: "artifact_show",
    description: "Show one artifact record by artifact id.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: {
          type: "string",
          description: "Artifact record id.",
        },
        artifact_id: {
          type: "string",
          description: "Snake-case alias for artifactId.",
        },
        id: {
          type: "string",
          description: "Alias for artifactId.",
        },
      },
    },
  },
  {
    name: "extract",
    description:
      "Extract Markdown and structured outputs from an artifact id, local file path, or URL through a material extractor provider.",
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "Artifact id, local file path, or URL to extract.",
        },
        attachTo: {
          type: "string",
          description: "Optional local workspace item id to attach the extraction record to.",
        },
        attach_to: {
          type: "string",
          description: "Snake-case alias for attachTo.",
        },
        providerId: {
          type: "string",
          description: "Material extractor provider id.",
        },
        provider_id: {
          type: "string",
          description: "Snake-case alias for providerId.",
        },
        provider: {
          type: "string",
          description: "Alias for providerId.",
        },
        policy: {
          type: "string",
          description: "Policy label recorded on the extraction run.",
        },
        dryRun: {
          type: "boolean",
          description: "Return the shared extraction plan without writing outputs or records.",
        },
        dry_run: {
          type: "boolean",
          description: "Snake-case alias for dryRun.",
        },
      },
      required: ["input"],
    },
  },
  {
    name: "material_ingest",
    description:
      "Run or plan the material workflow from a file, URL, or workspace item through artifact and extraction primitives.",
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "File path, URL, or workspace item id to ingest.",
        },
        attachTo: {
          type: "string",
          description: "Optional local workspace item id to attach material records to.",
        },
        attach_to: {
          type: "string",
          description: "Snake-case alias for attachTo.",
        },
        artifactProviderId: {
          type: "string",
          description: "Material artifact downloader provider id.",
        },
        artifact_provider_id: {
          type: "string",
          description: "Snake-case alias for artifactProviderId.",
        },
        artifactProvider: {
          type: "string",
          description: "Alias for artifactProviderId.",
        },
        artifact_provider: {
          type: "string",
          description: "Snake-case alias for artifactProviderId.",
        },
        extractProviderId: {
          type: "string",
          description: "Material extractor provider id.",
        },
        extract_provider_id: {
          type: "string",
          description: "Snake-case alias for extractProviderId.",
        },
        extractProvider: {
          type: "string",
          description: "Alias for extractProviderId.",
        },
        extract_provider: {
          type: "string",
          description: "Snake-case alias for extractProviderId.",
        },
        provider: {
          type: "string",
          description: "Alias for extractProviderId.",
        },
        policy: {
          type: "string",
          description: "Policy label recorded on artifact and extraction steps.",
        },
        dryRun: {
          type: "boolean",
          description: "Return the shared material ingest plan without writing files or records.",
        },
        dry_run: {
          type: "boolean",
          description: "Snake-case alias for dryRun.",
        },
      },
      required: ["input"],
    },
  },
  {
    name: "material_status",
    description:
      "Report artifact and extracted-output status for a workspace item, artifact, or extraction.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Workspace item id, artifact id, or extraction id.",
        },
        targetId: {
          type: "string",
          description: "Alias for target.",
        },
        target_id: {
          type: "string",
          description: "Snake-case alias for target.",
        },
        input: {
          type: "string",
          description: "Alias for target.",
        },
      },
    },
  },
  {
    name: "material_provider_list_installed",
    description:
      "List installed material-provider packages using the durable providers --kind material management shape.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["material"],
          description: "Provider runtime kind. Defaults to material and mirrors providers --kind material.",
        },
      },
    },
  },
  {
    name: "platform_status",
    description:
      "Show installed provider health, config readiness, and current tool availability by source type.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

const TOOL_CAPABILITIES: Record<string, CapabilityGroup> = {
  mcp_help: "operate",
  academic_search: "discover",
  resource_lookup: "identify",
  patent_search: "discover",
  patent_detail: "identify",
  web_search: "discover",
  web_research: "discover",
  resource_add: "organize",
  collection_list: "organize",
  workspace_export: "organize",
  resource_pdf: "acquire",
  artifact_download: "acquire",
  artifact_list: "acquire",
  artifact_show: "acquire",
  extract: "extract",
  material_ingest: "orchestrate",
  material_status: "orchestrate",
  material_provider_list_installed: "operate",
  platform_status: "operate",
};

const TOOL_DEFINITIONS: ToolSchema[] = RAW_TOOL_DEFINITIONS.map((tool) => {
  const capability = TOOL_CAPABILITIES[tool.name];
  if (!capability) {
    throw new Error(`Missing capability group for canonical tool: ${tool.name}`);
  }
  return {
    ...tool,
    capability,
    annotations: {
      ...tool.annotations,
      capabilityGroup: capability,
      capabilityLayer: CAPABILITY_MAP[capability].layer,
    },
  };
});

export function cloneToolSchemas(): ToolSchema[] {
  return JSON.parse(JSON.stringify(TOOL_DEFINITIONS)) as ToolSchema[];
}

export function getCanonicalToolCapability(name: string): CapabilityGroup | undefined {
  return TOOL_CAPABILITIES[name];
}

export function getCanonicalToolNames(): string[] {
  return TOOL_DEFINITIONS.map((tool) => tool.name);
}
