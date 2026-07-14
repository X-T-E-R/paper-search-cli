import type { ResolvedConfig } from "../config/schema.js";
import {
  listArtifactRecords,
  readArtifactRecord,
  type ArtifactRecord,
} from "../material/artifactStore.js";
import {
  planArtifactDownload,
  runArtifactDownload,
} from "../material/artifactDownload.js";
import {
  planMaterialExtraction,
  runMaterialExtraction,
} from "../material/extract.js";
import {
  planMaterialIngest,
  runMaterialIngest,
} from "../material/ingest.js";
import { listInstalledMaterialProviders } from "../material/registry/plan.js";
import { runMaterialStatus } from "../material/status.js";
import { runResourceLookup, type LookupIdentifierType } from "../lookup/resource.js";
import type { ResourceLookupRequest } from "../lookup/resource.js";
import { listInstalledProviders } from "../providers/registry/sync.js";
import { runAcademicSearch } from "../search/academic.js";
import type { AcademicSearchRequest } from "../search/academic.js";
import { runPatentDetail, runPatentSearch } from "../search/patent.js";
import type { PatentDetailRequest, PatentSearchRequest } from "../search/patent.js";
import { createHelpSnapshot } from "./help.js";
import { createPlatformStatusSnapshot } from "./status.js";
import type { CapabilityGroup } from "./capabilities.js";
import {
  failEnvelope,
  isResultEnvelope,
  okEnvelope,
  type ResultDiagnostics,
  type ResultEnvelope,
  type ResultProvenance,
} from "./resultEnvelope.js";
import { getTools } from "./tools.js";
import {
  assertToolArgumentsMatchSchema,
  type ToolArguments,
} from "./toolArguments.js";
import {
  getCanonicalToolCapability,
  type ToolSchema,
} from "./toolCatalog.js";
import { runWebResearch, runWebSearch } from "../web/router.js";
import type { WebResearchRequest, WebSearchRequest } from "../web/types.js";
import {
  addResourceToWorkspace,
  exportWorkspaceItems,
  fetchPdfForWorkspaceItem,
  listWorkspaceCollections,
  type WorkspaceDetailPayload,
} from "../workspace/store.js";
import type { ResourceItem } from "../providers/sdk/types.js";
import type { PatentDetailResult } from "../providers/sdk/types.js";
import type { PlatformStatusSnapshot } from "./status.js";
import type { ResourceLookupResult } from "../lookup/resource.js";
import type { WebResearchResponse, WebSearchResponse } from "../web/types.js";
import { buildSearchEnvelope } from "./searchEnvelope.js";

export type { ToolArguments } from "./toolArguments.js";

interface ArtifactListData {
  records: ArtifactRecord[];
  count: number;
  itemId?: string;
  standalone?: boolean;
}

interface ArtifactShowData {
  record: ArtifactRecord;
}

type ValidationResult<T> =
  | { ok: true; value: T | undefined }
  | { ok: false; message: string };

const LOOKUP_IDENTIFIER_TYPES = ["doi", "pmid", "arxiv", "isbn"] as const;
const ACADEMIC_SORT_VALUES = ["relevance", "date", "citations"] as const;
const PATENT_SORT_VALUES = ["relevance", "date"] as const;
const PATENT_TYPE_VALUES = ["all", "invention", "utility_model", "design"] as const;
const PATENT_LEGAL_STATUS_VALUES = ["all", "valid", "invalid", "pending"] as const;
const PATENT_DATABASE_VALUES = ["CN", "WD"] as const;
const PATENT_SORT_FIELD_VALUES = ["applicationDate", "publicationDate"] as const;
const PATENT_SORT_ORDER_VALUES = ["asc", "desc"] as const;
const PATENT_QUERY_MODE_VALUES = ["simple", "expert"] as const;
const PATENT_DETAIL_INCLUDE_VALUES = ["core", "legalStatus", "claims", "description", "pdf", "images"] as const;
const WEB_MODE_VALUES = ["auto", "web", "news", "social", "docs", "research", "github", "pdf"] as const;
const WEB_INTENT_VALUES = ["auto", "factual", "status", "comparison", "tutorial", "exploratory", "news", "resource"] as const;
const WEB_STRATEGY_VALUES = ["auto", "fast", "balanced", "verify", "deep"] as const;
const WEB_PROVIDER_VALUES = ["auto", "tavily", "firecrawl", "exa", "xai", "mysearch"] as const;
const WORKSPACE_EXPORT_FORMAT_VALUES = ["json", "jsonl", "csv", "bibtex"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnArg(args: ToolArguments, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function getProvidedArg(args: ToolArguments, keys: readonly string[]): { provided: boolean; value: unknown } {
  for (const key of keys) {
    if (hasOwnArg(args, key)) {
      return { provided: true, value: args[key] };
    }
  }
  return { provided: false, value: undefined };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function validateOptionalEnumValue<const T extends string>(
  args: ToolArguments,
  keys: readonly string[],
  values: readonly T[],
  fieldName: string,
): ValidationResult<T> {
  const { provided, value } = getProvidedArg(args, keys);
  if (!provided || value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, message: `${fieldName} must be one of: ${values.join(", ")}` };
  }
  if (!values.includes(value as T)) {
    return { ok: false, message: `${fieldName} must be one of: ${values.join(", ")}` };
  }
  return { ok: true, value: value as T };
}

function validateOptionalEnumArray<const T extends string>(
  args: ToolArguments,
  keys: readonly string[],
  values: readonly T[],
  fieldName: string,
): ValidationResult<T[]> {
  const { provided, value } = getProvidedArg(args, keys);
  if (!provided || value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: `${fieldName} must be an array containing only: ${values.join(", ")}` };
  }
  const invalidEntries = value.filter((entry) => typeof entry !== "string" || !values.includes(entry as T));
  if (invalidEntries.length > 0) {
    return { ok: false, message: `${fieldName} must contain only: ${values.join(", ")}` };
  }
  return { ok: true, value: value as T[] };
}

function asResourceItem(value: unknown): ResourceItem | undefined {
  return isRecord(value) && typeof value.itemType === "string" && typeof value.title === "string"
    ? value as unknown as ResourceItem
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidArgs(capability: CapabilityGroup, tool: string, message: string): ResultEnvelope<null> {
  return failEnvelope({
    capability,
    tool,
    errors: [message],
    diagnostics: { reason: "invalid_arguments" },
  });
}

function webSearchEnvelope(data: WebSearchResponse): ResultEnvelope<WebSearchResponse> {
  return okEnvelope({
    capability: "discover",
    tool: "web_search",
    data,
    diagnostics: { sourceCounts: { [data.provider]: data.results.length } },
    provenance: { providerIds: [data.provider] },
  });
}

function webResearchEnvelope(data: WebResearchResponse): ResultEnvelope<WebResearchResponse> {
  const failedSources = [
    ...(data.social_error ? ["social"] : []),
    ...data.pages.filter((page) => page.error).map((page) => page.url),
  ];
  return okEnvelope({
    capability: "discover",
    tool: "web_research",
    data,
    diagnostics: {
      sourceCounts: {
        web: data.evidence.web_result_count,
        pages: data.evidence.page_count,
        citations: data.evidence.citation_count,
      },
      ...(failedSources.length > 0 ? { failedSources } : {}),
    },
    provenance: { providerIds: data.evidence.providers_consulted },
  });
}

function lookupEnvelope(data: ResourceLookupResult): ResultEnvelope<ResourceLookupResult> {
  return okEnvelope({
    capability: "identify",
    tool: "resource_lookup",
    data,
    ...(data.warnings.length > 0 ? { warnings: data.warnings } : {}),
    provenance: { providerIds: [data.resolvedBy] },
  });
}

function patentDetailEnvelope(data: PatentDetailResult): ResultEnvelope<PatentDetailResult> {
  return okEnvelope({
    capability: "identify",
    tool: "patent_detail",
    data,
    provenance: {
      providerIds: data.item.source ? [data.item.source] : undefined,
    },
  });
}

function workspaceEnvelope<T>(
  tool: string,
  data: T,
  diagnostics: ResultDiagnostics,
  provenance?: ResultProvenance,
): ResultEnvelope<T> {
  return okEnvelope({
    capability: "organize",
    tool,
    data,
    diagnostics,
    ...(provenance ? { provenance } : {}),
  });
}

function resourcePdfEnvelope(
  data: Awaited<ReturnType<typeof fetchPdfForWorkspaceItem>>,
  workspaceRoot: string,
): ResultEnvelope<typeof data> | ResultEnvelope<null> {
  if (!data.ok) {
    return failEnvelope({
      capability: "acquire",
      tool: "resource_pdf",
      errors: [data.message ?? "PDF attachment failed"],
      diagnostics: { workspaceRoot, rawPayload: data },
    });
  }
  return okEnvelope({
    capability: "acquire",
    tool: "resource_pdf",
    data,
    diagnostics: { workspaceRoot },
    provenance: { providerIds: data.sourceUrl ? [data.sourceUrl] : undefined },
  });
}

function artifactListEnvelope(
  data: ArtifactListData,
  workspaceRoot: string,
): ResultEnvelope<ArtifactListData> {
  return okEnvelope({
    capability: "acquire",
    tool: "artifact_list",
    data,
    diagnostics: {
      workspaceRoot,
      sourceCounts: { artifacts: data.count },
      ...(data.itemId ? { itemId: data.itemId } : {}),
      ...(data.standalone ? { standalone: true } : {}),
    },
  });
}

function artifactShowEnvelope(
  data: ArtifactShowData,
  workspaceRoot: string,
): ResultEnvelope<ArtifactShowData> {
  return okEnvelope({
    capability: "acquire",
    tool: "artifact_show",
    data,
    diagnostics: {
      workspaceRoot,
      artifactId: data.record.id,
    },
    provenance: {
      providerIds: data.record.provenance.providerId ? [data.record.provenance.providerId] : undefined,
      policy: data.record.provenance.policy,
    },
  });
}

async function materialProviderListInstalledEnvelope(
  config: ResolvedConfig,
): Promise<ResultEnvelope<unknown>> {
  const installed = await listInstalledMaterialProviders(config.providers.installDir);
  return okEnvelope({
    capability: "operate",
    tool: "material_provider_list_installed",
    data: {
      kind: "material",
      installDir: config.providers.installDir,
      installed,
    },
    diagnostics: {
      installedCount: installed.length,
      invalidCount: installed.filter((entry) => !entry.valid).length,
    },
    provenance: { providerIds: installed.filter((entry) => entry.valid).map((entry) => entry.id) },
  });
}

function platformStatusEnvelope(data: PlatformStatusSnapshot): ResultEnvelope<PlatformStatusSnapshot> {
  return okEnvelope({
    capability: "operate",
    tool: "platform_status",
    data,
    diagnostics: {
      providerInstallDir: data.providerInstallDir,
      sourceCounts: {
        academic: data.academic.length,
        patent: data.patent.length,
        web: data.web.length,
        invalid: data.invalidProviders.length,
      },
    },
  });
}

async function captureFailure(
  capability: CapabilityGroup,
  tool: string,
  work: () => Promise<ResultEnvelope>,
): Promise<ResultEnvelope> {
  try {
    return await work();
  } catch (error) {
    return failEnvelope({
      capability,
      tool,
      errors: [errorMessage(error)],
    });
  }
}

export interface RunCanonicalToolOptions {
  /** MCP keeps its existing handler-level validation and aliases. */
  validateArguments?: boolean;
  allowLegacyAliases?: boolean;
}

export async function runCanonicalTool(
  config: ResolvedConfig,
  name: string,
  args: ToolArguments = {},
  options: RunCanonicalToolOptions = {},
): Promise<ResultEnvelope> {
  const tools = await loadCanonicalToolSchemas(config);
  const schema = tools.find((tool) => tool.name === name);
  const allowLegacyAlias = options.allowLegacyAliases === true && name === "resource_search";
  if (!schema && !allowLegacyAlias) {
    return unknownToolEnvelope(name, tools.map((tool) => tool.name));
  }

  if (schema && options.validateArguments !== false) {
    try {
      assertToolArgumentsMatchSchema(schema, args);
    } catch (error) {
      return invalidArgs(toolCapability(name), name, errorMessage(error));
    }
  }

  const result = await dispatchToolCall(config, name, args);
  if (isResultEnvelope(result)) {
    return result;
  }

  return failEnvelope({
    capability: toolCapability(name),
    tool: name,
    errors: [`Tool ${name} did not return a ResultEnvelope`],
    diagnostics: { reason: "invalid_tool_result", rawPayload: result },
  });
}

export function toolArgumentFailureEnvelope(tool: string, message: string): ResultEnvelope<null> {
  return invalidArgs(toolCapability(tool), tool, message);
}

async function loadCanonicalToolSchemas(config: ResolvedConfig): Promise<ToolSchema[]> {
  const installed = await listInstalledProviders(config.providers.installDir);
  return getTools(installed);
}

function unknownToolEnvelope(name: string, availableTools: string[]): ResultEnvelope<null> {
  return failEnvelope({
    capability: "operate",
    tool: name,
    errors: [`Unknown canonical tool: ${name}`],
    diagnostics: { reason: "unknown_tool", availableTools },
  });
}

function toolCapability(name: string): CapabilityGroup {
  if (name === "resource_search") return "discover";
  return getCanonicalToolCapability(name) ?? "operate";
}

async function dispatchToolCall(
  config: ResolvedConfig,
  name: string,
  args: ToolArguments,
): Promise<unknown> {
  switch (name) {
    case "mcp_help":
      return captureFailure("operate", "mcp_help", async () =>
        okEnvelope({
          capability: "operate",
          tool: "mcp_help",
          data: await createHelpSnapshot(config, {
            topic: asString(args.topic),
            tool: asString(args.tool),
            provider: asString(args.provider),
            locale: asString(args.locale),
          }),
        }));

    case "academic_search":
      return handleAcademicSearch(config, args);

    case "patent_search":
      return handlePatentSearch(config, args);

    case "patent_detail":
      return handlePatentDetail(config, args);

    case "web_search":
      return handleWebSearch(config, args);

    case "web_research":
      return handleWebResearch(config, args);

    case "resource_lookup":
      return handleResourceLookup(config, args);

    case "resource_add":
      return handleResourceAdd(config, args);

    case "collection_list":
      return handleCollectionList(config, args);

    case "workspace_export":
      return handleWorkspaceExport(config, args);

    case "resource_pdf":
      return handleResourcePdf(config, args);

    case "artifact_download":
      return handleArtifactDownload(config, args);

    case "artifact_list":
      return handleArtifactList(config, args);

    case "artifact_show":
      return handleArtifactShow(config, args);

    case "extract":
      return handleExtract(config, args);

    case "material_ingest":
      return handleMaterialIngest(config, args);

    case "material_status":
      return handleMaterialStatus(config, args);

    case "material_provider_list_installed":
      return handleMaterialProviderListInstalled(config, args);

    case "platform_status":
      return captureFailure("operate", "platform_status", async () =>
        platformStatusEnvelope(await createPlatformStatusSnapshot(config)));

    case "resource_search":
      return handleAcademicSearch(config, args);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function handleAcademicSearch(
  config: ResolvedConfig,
  args: ToolArguments,
): Promise<unknown> {
  const query = asString(args.query);
  if (!query) {
    return invalidArgs("discover", "academic_search", "query is required and must be a string");
  }
  const sortBy = validateOptionalEnumValue(args, ["sortBy"], ACADEMIC_SORT_VALUES, "sortBy");
  if (!sortBy.ok) {
    return invalidArgs("discover", "academic_search", sortBy.message);
  }
  const request: AcademicSearchRequest = {
    query,
    platform: asString(args.platform),
    provider: asString(args.provider),
    presets: asStringArray(args.presets),
    sources: asStringArray(args.sources),
    categories: asStringArray(args.categories),
    excludeSources: asStringArray(args.excludeSources) ?? asStringArray(args.exclude_sources),
    excludeCategories: asStringArray(args.excludeCategories) ?? asStringArray(args.exclude_categories),
    maxResults: asNumber(args.maxResults) ?? asNumber(args.max_results),
    page: asNumber(args.page),
    year: asString(args.year),
    author: asString(args.author),
    sortBy: sortBy.value,
    extra: isRecord(args.extra) ? args.extra : undefined,
  };
  return captureFailure("discover", "academic_search", async () =>
    buildSearchEnvelope("academic_search", await runAcademicSearch(config, request)));
}

async function handlePatentSearch(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const rawQuery = asString(args.rawQuery) ?? asString(args.raw_query);
  const query = rawQuery || asString(args.query);
  if (!query) {
    return invalidArgs("discover", "patent_search", "query or rawQuery is required and must be a string");
  }
  const sortBy = validateOptionalEnumValue(args, ["sortBy"], PATENT_SORT_VALUES, "sortBy");
  if (!sortBy.ok) {
    return invalidArgs("discover", "patent_search", sortBy.message);
  }
  const patentType = validateOptionalEnumValue(
    args,
    ["patentType", "patent_type"],
    PATENT_TYPE_VALUES,
    "patentType",
  );
  if (!patentType.ok) {
    return invalidArgs("discover", "patent_search", patentType.message);
  }
  const legalStatus = validateOptionalEnumValue(
    args,
    ["legalStatus", "legal_status"],
    PATENT_LEGAL_STATUS_VALUES,
    "legalStatus",
  );
  if (!legalStatus.ok) {
    return invalidArgs("discover", "patent_search", legalStatus.message);
  }
  const database = validateOptionalEnumValue(args, ["database"], PATENT_DATABASE_VALUES, "database");
  if (!database.ok) {
    return invalidArgs("discover", "patent_search", database.message);
  }
  const sortField = validateOptionalEnumValue(
    args,
    ["sortField", "sort_field"],
    PATENT_SORT_FIELD_VALUES,
    "sortField",
  );
  if (!sortField.ok) {
    return invalidArgs("discover", "patent_search", sortField.message);
  }
  const sortOrder = validateOptionalEnumValue(
    args,
    ["sortOrder", "sort_order"],
    PATENT_SORT_ORDER_VALUES,
    "sortOrder",
  );
  if (!sortOrder.ok) {
    return invalidArgs("discover", "patent_search", sortOrder.message);
  }
  const queryMode = validateOptionalEnumValue(
    args,
    ["queryMode", "query_mode"],
    PATENT_QUERY_MODE_VALUES,
    "queryMode",
  );
  if (!queryMode.ok) {
    return invalidArgs("discover", "patent_search", queryMode.message);
  }
  const request: PatentSearchRequest = {
    query,
    platform: asString(args.platform),
    provider: asString(args.provider),
    presets: asStringArray(args.presets),
    sources: asStringArray(args.sources),
    categories: asStringArray(args.categories),
    excludeSources: asStringArray(args.excludeSources) ?? asStringArray(args.exclude_sources),
    excludeCategories: asStringArray(args.excludeCategories) ?? asStringArray(args.exclude_categories),
    maxResults: asNumber(args.maxResults) ?? asNumber(args.max_results),
    page: asNumber(args.page),
    sortBy: sortBy.value,
    patentType: patentType.value,
    legalStatus: legalStatus.value,
    database: database.value,
    sortField: sortField.value,
    sortOrder: sortOrder.value,
    queryMode: queryMode.value,
    rawQuery,
    extra: isRecord(args.extra) ? args.extra : undefined,
  };
  return captureFailure("discover", "patent_search", async () =>
    buildSearchEnvelope("patent_search", await runPatentSearch(config, request)));
}

async function handlePatentDetail(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const platform = asString(args.platform);
  const sourceId = asString(args.sourceId) ?? asString(args.source_id);
  if (!platform) {
    return invalidArgs("identify", "patent_detail", "platform is required and must be a string");
  }
  if (!sourceId) {
    return invalidArgs("identify", "patent_detail", "sourceId is required and must be a string");
  }
  const include = validateOptionalEnumArray(
    args,
    ["include"],
    PATENT_DETAIL_INCLUDE_VALUES,
    "include",
  );
  if (!include.ok) {
    return invalidArgs("identify", "patent_detail", include.message);
  }
  const request: PatentDetailRequest = {
    platform,
    sourceId,
    include: include.value,
  };
  return captureFailure("identify", "patent_detail", async () =>
    patentDetailEnvelope(await runPatentDetail(config, request)));
}

async function handleWebSearch(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const query = asString(args.query);
  if (!query) {
    return invalidArgs("discover", "web_search", "query is required and must be a string");
  }
  const mode = validateOptionalEnumValue(args, ["mode"], WEB_MODE_VALUES, "mode");
  if (!mode.ok) {
    return invalidArgs("discover", "web_search", mode.message);
  }
  const intent = validateOptionalEnumValue(args, ["intent"], WEB_INTENT_VALUES, "intent");
  if (!intent.ok) {
    return invalidArgs("discover", "web_search", intent.message);
  }
  const strategy = validateOptionalEnumValue(args, ["strategy"], WEB_STRATEGY_VALUES, "strategy");
  if (!strategy.ok) {
    return invalidArgs("discover", "web_search", strategy.message);
  }
  const provider = validateOptionalEnumValue(args, ["provider"], WEB_PROVIDER_VALUES, "provider");
  if (!provider.ok) {
    return invalidArgs("discover", "web_search", provider.message);
  }
  const request: WebSearchRequest = {
    query,
    mode: mode.value as WebSearchRequest["mode"],
    intent: intent.value as WebSearchRequest["intent"],
    strategy: strategy.value as WebSearchRequest["strategy"],
    provider: provider.value as WebSearchRequest["provider"],
    sources: asStringArray(args.sources),
    maxResults: asNumber(args.maxResults) ?? asNumber(args.max_results),
    includeContent: asBoolean(args.includeContent) ?? asBoolean(args.include_content),
    includeAnswer: asBoolean(args.includeAnswer) ?? asBoolean(args.include_answer),
    includeDomains: asStringArray(args.includeDomains) ?? asStringArray(args.include_domains),
    excludeDomains: asStringArray(args.excludeDomains) ?? asStringArray(args.exclude_domains),
    allowedXHandles: asStringArray(args.allowedXHandles) ?? asStringArray(args.allowed_x_handles),
    excludedXHandles: asStringArray(args.excludedXHandles) ?? asStringArray(args.excluded_x_handles),
    fromDate: asString(args.fromDate) ?? asString(args.from_date),
    toDate: asString(args.toDate) ?? asString(args.to_date),
  };
  return captureFailure("discover", "web_search", async () =>
    webSearchEnvelope(await runWebSearch(config, request)));
}

async function handleWebResearch(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const query = asString(args.query);
  if (!query) {
    return invalidArgs("discover", "web_research", "query is required and must be a string");
  }
  const mode = validateOptionalEnumValue(args, ["mode"], WEB_MODE_VALUES, "mode");
  if (!mode.ok) {
    return invalidArgs("discover", "web_research", mode.message);
  }
  const intent = validateOptionalEnumValue(args, ["intent"], WEB_INTENT_VALUES, "intent");
  if (!intent.ok) {
    return invalidArgs("discover", "web_research", intent.message);
  }
  const strategy = validateOptionalEnumValue(args, ["strategy"], WEB_STRATEGY_VALUES, "strategy");
  if (!strategy.ok) {
    return invalidArgs("discover", "web_research", strategy.message);
  }
  const request: WebResearchRequest = {
    query,
    webMaxResults: asNumber(args.webMaxResults) ?? asNumber(args.web_max_results),
    socialMaxResults: asNumber(args.socialMaxResults) ?? asNumber(args.social_max_results),
    scrapeTopN: asNumber(args.scrapeTopN) ?? asNumber(args.scrape_top_n),
    includeSocial: asBoolean(args.includeSocial) ?? asBoolean(args.include_social),
    mode: mode.value as WebResearchRequest["mode"],
    intent: intent.value as WebResearchRequest["intent"],
    strategy: strategy.value as WebResearchRequest["strategy"],
    includeDomains: asStringArray(args.includeDomains) ?? asStringArray(args.include_domains),
    excludeDomains: asStringArray(args.excludeDomains) ?? asStringArray(args.exclude_domains),
    allowedXHandles: asStringArray(args.allowedXHandles) ?? asStringArray(args.allowed_x_handles),
    excludedXHandles: asStringArray(args.excludedXHandles) ?? asStringArray(args.excluded_x_handles),
    fromDate: asString(args.fromDate) ?? asString(args.from_date),
    toDate: asString(args.toDate) ?? asString(args.to_date),
  };
  return captureFailure("discover", "web_research", async () =>
    webResearchEnvelope(await runWebResearch(config, request)));
}

async function handleResourceLookup(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const identifierType = validateOptionalEnumValue(
    args,
    ["identifierType", "identifier_type"],
    LOOKUP_IDENTIFIER_TYPES,
    "identifierType",
  );
  if (!identifierType.ok) {
    return invalidArgs("identify", "resource_lookup", identifierType.message);
  }
  const request: ResourceLookupRequest = {
    identifier: asString(args.identifier),
    identifierType: identifierType.value as LookupIdentifierType | undefined,
    url: asString(args.url),
    formats: asStringArray(args.formats),
    provider: asString(args.provider),
  };
  if (!request.identifier && !request.url) {
    return invalidArgs("identify", "resource_lookup", "identifier or url is required");
  }
  return captureFailure("identify", "resource_lookup", async () =>
    lookupEnvelope(await runResourceLookup(config, request)));
}

async function handleResourceAdd(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const item = asResourceItem(args.item);
  const url = asString(args.url);
  if (!item && !url) {
    return invalidArgs("organize", "resource_add", "Either item or url must be provided");
  }
  return captureFailure("organize", "resource_add", async () =>
    workspaceEnvelope(
      "resource_add",
      await addResourceToWorkspace(config.workspace.root, {
        item,
        detail: isRecord(args.detail) ? args.detail as WorkspaceDetailPayload : undefined,
        url,
        collectionKey: asString(args.collectionKey) ?? asString(args.collection_key),
        collectionPath: asString(args.collectionPath) ?? asString(args.collection_path),
        tags: asStringArray(args.tags),
        fetchPdf: asBoolean(args.fetchPDF) ?? asBoolean(args.fetchPdf) ?? asBoolean(args.fetch_pdf),
        defaultCollectionPath: config.workspace.defaultCollection,
      }),
      { workspaceRoot: config.workspace.root },
    ));
}

async function handleCollectionList(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  return captureFailure("organize", "collection_list", async () => {
    const collections = await listWorkspaceCollections(config.workspace.root, {
      defaultCollectionPath: config.workspace.defaultCollection,
      flat: args.flat === true,
    });
    const count = args.flat === true
      ? collections.length
      : countCollectionNodes(collections as Array<{ children?: unknown[] }>);
    return workspaceEnvelope(
      "collection_list",
      {
        format: args.flat === true ? "flat" : "tree",
        count,
        collections,
      },
      { workspaceRoot: config.workspace.root, sourceCounts: { collections: count } },
    );
  });
}

async function handleWorkspaceExport(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const format = validateOptionalEnumValue(
    args,
    ["format"],
    WORKSPACE_EXPORT_FORMAT_VALUES,
    "format",
  );
  if (!format.ok) {
    return invalidArgs("organize", "workspace_export", format.message);
  }
  return captureFailure("organize", "workspace_export", async () => {
    const result = await exportWorkspaceItems(config.workspace.root, {
      format: format.value ?? "json",
      collectionKey: asString(args.collectionKey) ?? asString(args.collection_key),
      collectionPath: asString(args.collectionPath) ?? asString(args.collection_path),
      includeChildren: asBoolean(args.includeChildren) ?? asBoolean(args.include_children),
    });
    return workspaceEnvelope("workspace_export", result, {
      workspaceRoot: config.workspace.root,
      sourceCounts: { items: result.count },
    });
  });
}

function countCollectionNodes(nodes: Array<{ children?: unknown[] }>): number {
  return nodes.reduce(
    (total, node) =>
      total + 1 + countCollectionNodes(Array.isArray(node.children) ? node.children as Array<{ children?: unknown[] }> : []),
    0,
  );
}

async function handleResourcePdf(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const itemKey = asString(args.itemKey) ?? asString(args.item_key);
  if (!itemKey) {
    return invalidArgs("acquire", "resource_pdf", "itemKey is required and must be a string");
  }
  return captureFailure("acquire", "resource_pdf", async () =>
    resourcePdfEnvelope(
      await fetchPdfForWorkspaceItem(config.workspace.root, {
        itemKey,
        url: asString(args.url),
        filename: asString(args.filename),
        download: asBoolean(args.download),
      }),
      config.workspace.root,
    ));
}

async function handleArtifactDownload(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const input = asString(args.input);
  if (!input) {
    return invalidArgs("acquire", "artifact_download", "input is required and must be a string");
  }
  const materialOptions = {
    config,
    input,
    attachTo: asString(args.attachTo) ?? asString(args.attach_to),
    providerId: asString(args.providerId) ?? asString(args.provider_id) ?? asString(args.provider),
    resolverProviderId: asString(args.resolverId) ?? asString(args.resolver_id),
    policy: asString(args.policy),
    download: asBoolean(args.download),
  };
  const dryRun = asBoolean(args.dryRun) ?? asBoolean(args.dry_run) ?? false;
  return captureFailure("acquire", "artifact_download", async () =>
    dryRun ? await planArtifactDownload(materialOptions) : await runArtifactDownload(materialOptions));
}

async function handleArtifactList(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const itemId = asString(args.item) ?? asString(args.itemId) ?? asString(args.item_id);
  const standalone = asBoolean(args.standalone);
  return captureFailure("acquire", "artifact_list", async () => {
    const records = await listArtifactRecords(config.workspace.root, {
      ...(itemId ? { itemId } : {}),
      ...(standalone !== undefined ? { standalone } : {}),
    });
    return artifactListEnvelope(
      {
        records,
        count: records.length,
        ...(itemId ? { itemId } : {}),
        ...(standalone ? { standalone: true } : {}),
      },
      config.workspace.root,
    );
  });
}

async function handleArtifactShow(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const artifactId = asString(args.artifactId) ?? asString(args.artifact_id) ?? asString(args.id);
  if (!artifactId) {
    return invalidArgs("acquire", "artifact_show", "artifactId is required and must be a string");
  }
  return captureFailure("acquire", "artifact_show", async () => {
    const record = await readArtifactRecord(config.workspace.root, artifactId);
    if (!record) {
      return failEnvelope({
        capability: "acquire",
        tool: "artifact_show",
        errors: [`Artifact not found: ${artifactId}`],
        diagnostics: { workspaceRoot: config.workspace.root, artifactId },
      });
    }
    return artifactShowEnvelope({ record }, config.workspace.root);
  });
}

async function handleExtract(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const input = asString(args.input);
  if (!input) {
    return invalidArgs("extract", "extract", "input is required and must be a string");
  }
  const materialOptions = {
    config,
    input,
    attachTo: asString(args.attachTo) ?? asString(args.attach_to),
    providerId: asString(args.providerId) ?? asString(args.provider_id) ?? asString(args.provider),
    policy: asString(args.policy),
  };
  const dryRun = asBoolean(args.dryRun) ?? asBoolean(args.dry_run) ?? false;
  return captureFailure("extract", "extract", async () =>
    dryRun ? await planMaterialExtraction(materialOptions) : await runMaterialExtraction(materialOptions));
}

async function handleMaterialIngest(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const input = asString(args.input);
  if (!input) {
    return invalidArgs("orchestrate", "material_ingest", "input is required and must be a string");
  }
  const materialOptions = {
    config,
    input,
    attachTo: asString(args.attachTo) ?? asString(args.attach_to),
    artifactProviderId: asString(args.artifactProviderId) ??
      asString(args.artifactProvider) ??
      asString(args.artifact_provider) ??
      asString(args.artifact_provider_id),
    extractProviderId: asString(args.extractProviderId) ??
      asString(args.extractProvider) ??
      asString(args.extract_provider) ??
      asString(args.extract_provider_id) ??
      asString(args.provider),
    policy: asString(args.policy),
  };
  const dryRun = asBoolean(args.dryRun) ?? asBoolean(args.dry_run) ?? false;
  return captureFailure("orchestrate", "material_ingest", async () =>
    dryRun ? await planMaterialIngest(materialOptions) : await runMaterialIngest(materialOptions));
}

async function handleMaterialStatus(config: ResolvedConfig, args: ToolArguments): Promise<unknown> {
  const input = asString(args.target) ??
    asString(args.targetId) ??
    asString(args.target_id) ??
    asString(args.input);
  if (!input) {
    return invalidArgs("orchestrate", "material_status", "target is required and must be a string");
  }
  return captureFailure("orchestrate", "material_status", async () =>
    runMaterialStatus({ config, input }));
}

async function handleMaterialProviderListInstalled(
  config: ResolvedConfig,
  args: ToolArguments,
): Promise<unknown> {
  const kind = asString(args.kind);
  if (kind && kind !== "material") {
    return invalidArgs(
      "operate",
      "material_provider_list_installed",
      "kind must be material for material_provider_list_installed",
    );
  }
  return captureFailure("operate", "material_provider_list_installed", async () =>
    materialProviderListInstalledEnvelope(config));
}
