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

export const DURABLE_DISCOVERY_TOOL_NAMES = Object.freeze([
  "academic_search",
  "patent_search",
  "resource_lookup",
  "patent_detail",
  "web_search",
] as const);

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

const HISTORY_CONTROL_PROPERTIES: Record<string, unknown> = {
  recordHistory: {
    type: "boolean",
    description:
      "Persist this discovery invocation. Defaults to runs.recordByDefault; false is an explicit per-call opt-out.",
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
        ...HISTORY_CONTROL_PROPERTIES,
        ...SEARCH_SELECTION_PROPERTIES,
        maxResults: {
          type: "number",
          description:
            "Maximum results per provider. 0 uses provider/global config; -1 uses the provider-declared limit.",
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
          description:
            "Per-provider result ordering. date and citations are descending; explicit input overrides platform.<id>.defaultSort and search.defaultAcademicSort.",
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
        ...HISTORY_CONTROL_PROPERTIES,
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
        ...HISTORY_CONTROL_PROPERTIES,
        ...SEARCH_SELECTION_PROPERTIES,
        maxResults: {
          type: "number",
          description: "Maximum results per provider. 0 uses the global default, -1 uses the source maximum.",
        },
        page: { type: "number", description: "Page number (default: 1)" },
        sortBy: {
          type: "string",
          enum: ["relevance", "date"],
          description:
            "Per-provider patent result ordering. date is descending; explicit input overrides platform.<id>.defaultSort and search.defaultPatentSort.",
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
        ...HISTORY_CONTROL_PROPERTIES,
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
      "Generic web search through an explicitly configured External Search v1 process.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        ...HISTORY_CONTROL_PROPERTIES,
        mode: {
          type: "string",
          enum: ["auto", "fast", "deep", "answer"],
          description: "Search mode (default: auto)",
        },
        intent: {
          type: "string",
          enum: ["factual", "status", "comparison", "tutorial", "exploratory", "news", "resource"],
          description: "Optional query intent hint",
        },
        freshness: {
          type: "string",
          enum: ["pd", "pw", "pm", "py"],
          description: "Optional freshness window",
        },
        maxResults: {
          type: "number",
          minimum: 1,
          maximum: 10000,
          description: "Maximum normalized results",
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
      "Export local workspace items as JSON, JSONL, CSV, or BibTeX. The CLI may explicitly write through the managed export root.",
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
      "Compatibility alias that acquires a PDF through installed material providers and projects the resulting artifact onto an existing local workspace item.",
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
          description: "Download through the selected material provider. Set false to record a request only.",
        },
        providerId: {
          type: "string",
          description: "Optional material artifact downloader provider id.",
        },
        resolverProviderId: {
          type: "string",
          description: "Optional material artifact resolver provider id used for DOI inputs.",
        },
        policy: {
          type: "string",
          description: "Policy label recorded on the provider-mediated acquisition run.",
        },
        dryRun: {
          type: "boolean",
          description: "Return the provider-mediated acquisition plan without writing files or records.",
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
      "Run or plan the material workflow from a file, URL, or workspace item through managed artifact and extraction primitives.",
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
    name: "research_run",
    description:
      "Durably invoke one allowlisted, non-destructive discovery tool and persist its sanitized request, selection, diagnostics, provenance, and terminal result.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          enum: [...DURABLE_DISCOVERY_TOOL_NAMES],
          description: "Allowlisted canonical discovery tool to invoke.",
        },
        arguments: {
          type: "object",
          description: "Canonical arguments for the selected discovery tool.",
        },
      },
      required: ["tool", "arguments"],
    },
  },
  {
    name: "run_list",
    description: "List private local durable-run headers, optionally filtered by kind or status.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["tool", "citation", "assessment"],
          description: "Optional durable-run kind.",
        },
        status: {
          type: "string",
          enum: ["running", "completed", "partial", "failed", "interrupted", "corrupt"],
          description: "Optional durable-run status.",
        },
      },
    },
  },
  {
    name: "run_show",
    description: "Read one validated private local durable-run record by its portable run id.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Portable durable-run id." },
      },
      required: ["runId"],
    },
  },
  {
    name: "run_prune_plan",
    description:
      "Plan age-based durable-run pruning without deleting anything. Applying pruning remains an explicit CLI-only operation.",
    inputSchema: {
      type: "object",
      properties: {
        maxAgeDays: {
          type: "number",
          description: "Optional retention override: -1 disables age pruning; positive integers set age in days.",
        },
      },
    },
  },
  {
    name: "citation_expand",
    description:
      "Plan, start, or resume bounded backward/forward citation expansion through installed graph-capable academic providers.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["plan", "run", "resume"],
          description: "Plan is write-free; run and resume use the common durable-run store.",
        },
        runId: {
          type: "string",
          description: "Optional id for run; required for resume. A run id is generated when run omits it.",
        },
        seeds: {
          type: "array",
          items: { type: "object" },
          description: "One or more seeds with exact identifiers and optional normalized item metadata.",
        },
        directions: {
          type: "array",
          items: { type: "string", enum: ["backward", "forward"] },
          description: "Directions to union. Defaults to both supported directions.",
        },
        providers: {
          type: "array",
          items: { type: "string" },
          description: "Optional installed citation-provider ids to union.",
        },
        excludeIdentifiers: {
          type: "array",
          items: { type: "object" },
          description: "Exact identifiers to exclude from traversal results.",
        },
        limits: {
          type: "object",
          description: "Bounded traversal limits: depth, perNode, nodes, edges, providerPages, and concurrency.",
        },
      },
    },
  },
  {
    name: "citation_run_status",
    description: "Read one durable citation-expansion checkpoint and result without provider calls.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Citation durable-run id." },
      },
      required: ["runId"],
    },
  },
  {
    name: "assessment_run",
    description:
      "Plan or persist a transparent assessment from an immutable checksum-bound local observation snapshot and optional explicit policy.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["plan", "run"], description: "Plan is write-free; run persists one durable record." },
        snapshotPath: { type: "string", description: "Local immutable assessment snapshot JSON path." },
        snapshotSha256: { type: "string", description: "Exact SHA-256 digest of the snapshot bytes." },
        policy: { type: "object", description: "Optional transparent assessment policy object." },
      },
      required: ["snapshotPath", "snapshotSha256"],
    },
  },
  {
    name: "assessment_show",
    description:
      "Replay a completed assessment entirely from the durable record, optionally applying a replacement explicit policy.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Completed assessment durable-run id." },
        policy: { type: "object", description: "Optional replacement transparent policy object." },
      },
      required: ["runId"],
    },
  },
  {
    name: "assessment_list",
    description: "List private local durable assessment-run headers.",
    inputSchema: { type: "object", properties: {} },
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
  research_run: "orchestrate",
  run_list: "operate",
  run_show: "operate",
  run_prune_plan: "operate",
  citation_expand: "orchestrate",
  citation_run_status: "orchestrate",
  assessment_run: "assess",
  assessment_show: "assess",
  assessment_list: "assess",
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
