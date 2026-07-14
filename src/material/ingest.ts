import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig } from "../config/schema.js";
import {
  ARTIFACT_RECORDS_DIR,
  createArtifactRecord,
} from "./artifactStore.js";
import {
  planArtifactDownload,
  runArtifactDownload,
  type ArtifactDownloadInputSummary,
} from "./artifactDownload.js";
import {
  EXTRACTION_RECORDS_DIR,
} from "./extractionStore.js";
import {
  planMaterialExtractionForInputKind,
  runMaterialExtraction,
} from "./extract.js";
import {
  createPlanEnvelope,
  type PlannedOperationData,
  type PlannedOperationStep,
  type PlannedProviderSelection,
} from "../surface/plan.js";
import { okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import type { WorkspaceItemRecord } from "../workspace/store.js";
import type { ArtifactKind, ArtifactRecord, ExtractionRecord, ExtractionSource } from "./records.js";
import type { MaterialInputKind } from "./types.js";
import { tryParseDoiIdentifier } from "./resolverResult.js";

export interface MaterialIngestPlanOptions {
  config: ResolvedConfig;
  input: string;
  attachTo?: string;
  artifactProviderId?: string;
  extractProviderId?: string;
  policy?: string;
}

export interface MaterialIngestResourcePlan {
  kind: "path" | "url" | "workspace_item" | "identifier";
  input: string;
  targetPaths: string[];
  path?: string;
  url?: string;
  itemId?: string;
  title?: string;
  identifier?: { scheme: "doi"; value: string };
}

export interface MaterialIngestProviderPlan {
  id: string;
  kind: "material" | "builtin";
  capabilities: string[];
  packagePath?: string;
}

export interface MaterialIngestArtifactPlan {
  mode: "download" | "record_local";
  plannedArtifactId: string;
  source: {
    kind: "url" | "path" | "workspace_item";
    url?: string;
    path?: string;
    itemId?: string;
  };
  provider: MaterialIngestProviderPlan | null;
  recordTargetPath: string;
  fileTargetPath?: string;
  input?: ArtifactDownloadInputSummary;
}

export interface MaterialIngestExtractionPlan {
  plannedExtractionId: string;
  source: {
    kind: "artifact" | "path" | "url";
    artifactId?: string;
    path?: string;
    url?: string;
  };
  materialInputKind: MaterialInputKind;
  provider: MaterialIngestProviderPlan;
  recordTargetPath: string;
  outputTargetPath: string;
  markdownPath: string;
  jsonPath: string;
}

export interface MaterialIngestPolicyPlan {
  name: string;
  attachTo: string | null;
}

export interface MaterialIngestOutputPlan {
  artifactRecordPath: string;
  extractionRecordPath: string;
  extractionOutputPath: string;
  markdownPath: string;
  jsonPath: string;
  artifactFilePath?: string;
}

export interface MaterialIngestProvidersPlan {
  artifact: MaterialIngestProviderPlan | null;
  extraction: MaterialIngestProviderPlan;
  selected: MaterialIngestProviderPlan[];
}

export interface MaterialIngestPlanData extends PlannedOperationData {
  resource: MaterialIngestResourcePlan;
  artifact: MaterialIngestArtifactPlan;
  extraction: MaterialIngestExtractionPlan;
  policy: MaterialIngestPolicyPlan;
  providers: MaterialIngestProvidersPlan;
  outputs: MaterialIngestOutputPlan;
}

export interface MaterialIngestExecutedStep extends PlannedOperationStep {
  status: "completed";
}

export interface MaterialIngestArtifactExecution {
  mode: "download" | "record_local";
  artifactId: string;
  source: MaterialIngestArtifactPlan["source"];
  provider: MaterialIngestProviderPlan | null;
  recordTargetPath: string;
  fileTargetPath?: string;
  input?: ArtifactDownloadInputSummary;
  record: ArtifactRecord;
}

export interface MaterialIngestExtractionExecution {
  extractionId: string;
  source: ExtractionSource;
  materialInputKind: MaterialInputKind;
  provider: MaterialIngestProviderPlan;
  recordTargetPath: string;
  outputTargetPath: string;
  markdownPath: string;
  jsonPath: string;
  record: ExtractionRecord;
  markdown: string;
}

export interface MaterialIngestExecutionData extends Omit<PlannedOperationData, "intendedSteps"> {
  executedSteps: MaterialIngestExecutedStep[];
  resource: MaterialIngestResourcePlan;
  artifact: MaterialIngestArtifactExecution;
  extraction: MaterialIngestExtractionExecution;
  policy: MaterialIngestPolicyPlan;
  providers: MaterialIngestProvidersPlan;
  outputs: MaterialIngestOutputPlan;
}

interface ResolvedMaterialIngestInput {
  resource: MaterialIngestResourcePlan;
  attachTo: string | null;
  artifactInput: string | null;
  extractionInput: string;
  extractionInputKind: MaterialInputKind;
}

export class MaterialIngestPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialIngestPlanError";
  }
}

const WORKSPACE_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKSPACE_ITEMS_DIR = "items";
const PLANNED_ARTIFACT_ID = "<new-artifact-id>";
const PLANNED_EXTRACTION_ID = "<new-extraction-id>";
const LOCAL_ARTIFACT_PROVIDER: MaterialIngestProviderPlan = {
  id: "builtin-local-artifact",
  kind: "builtin",
  capabilities: ["acquire"],
};

function fail(message: string): never {
  throw new MaterialIngestPlanError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function assertWorkspaceItemId(itemId: string): string {
  if (!WORKSPACE_ITEM_ID_RE.test(itemId) || itemId === "." || itemId === "..") {
    fail(`Invalid workspace item id: ${itemId}`);
  }
  return itemId;
}

function normalizePolicy(value: string | undefined): string {
  if (value === undefined) return "default";
  const trimmed = value.trim();
  if (!trimmed) fail("--policy must be a non-empty policy name");
  return trimmed;
}

function normalizeAttachTo(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) fail("--attach-to must be a non-empty workspace item id");
  return assertWorkspaceItemId(trimmed);
}

function workspaceItemPath(workspaceRoot: string, itemId: string): string {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_ITEMS_DIR, `${assertWorkspaceItemId(itemId)}.json`);
}

async function readWorkspaceItem(
  workspaceRoot: string,
  itemId: string,
): Promise<WorkspaceItemRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(workspaceItemPath(workspaceRoot, itemId), "utf8")) as WorkspaceItemRecord;
    if (parsed.id !== itemId) {
      fail(`Workspace item id mismatch in record: ${itemId}`);
    }
    return parsed;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function resolvePathInput(cwd: string, input: string): Promise<string | null> {
  const candidate = path.isAbsolute(input) ? input : path.resolve(cwd, input);
  try {
    const candidateStat = await stat(candidate);
    if (!candidateStat.isFile()) {
      fail(`Path input must be a file: ${candidate}`);
    }
    return candidate;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function extractFirstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFirstString(item);
      if (found) return found;
    }
  }
  return undefined;
}

function firstHttpUrl(values: unknown[]): string | undefined {
  for (const value of values) {
    const found = extractFirstString(value);
    if (found && isHttpUrl(found)) return found;
  }
  return undefined;
}

function sourceUrlFromWorkspaceItem(record: WorkspaceItemRecord): string | undefined {
  const looseItem = record.item as unknown as Record<string, unknown>;
  const detailPdf = isPlainObject(record.detail) ? record.detail.pdf : undefined;
  const detailPdfUrls = isPlainObject(detailPdf) ? detailPdf.urls : undefined;
  return firstHttpUrl([
    record.url,
    record.item.url,
    looseItem.URL,
    looseItem.sourceUrl,
    detailPdfUrls,
  ]);
}

function titleFromWorkspaceItem(record: WorkspaceItemRecord): string | undefined {
  const title = record.item.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  return undefined;
}

function doiFromWorkspaceItem(record: WorkspaceItemRecord): string | undefined {
  const looseItem = record.item as unknown as Record<string, unknown>;
  const doi = extractFirstString([record.item.DOI, looseItem.DOI]);
  if (!doi) return undefined;
  return tryParseDoiIdentifier(doi)?.value;
}

async function resolveMaterialIngestInput(options: {
  config: ResolvedConfig;
  input: string;
  attachTo: string | null;
}): Promise<ResolvedMaterialIngestInput> {
  const trimmed = options.input.trim();
  if (!trimmed) fail("material ingest input must be non-empty");

  const doiIdentifier = tryParseDoiIdentifier(trimmed);
  if (doiIdentifier) {
    return {
      resource: {
        kind: "identifier",
        input: trimmed,
        identifier: doiIdentifier,
        targetPaths: [],
      },
      attachTo: options.attachTo,
      artifactInput: trimmed,
      extractionInput: trimmed,
      extractionInputKind: "url",
    };
  }

  if (isHttpUrl(trimmed)) {
    return {
      resource: {
        kind: "url",
        input: trimmed,
        url: trimmed,
        targetPaths: [],
      },
      attachTo: options.attachTo,
      artifactInput: trimmed,
      extractionInput: trimmed,
      extractionInputKind: "url",
    };
  }

  const resolvedPath = await resolvePathInput(options.config.meta.cwd, trimmed);
  if (resolvedPath) {
    return {
      resource: {
        kind: "path",
        input: trimmed,
        path: resolvedPath,
        targetPaths: [resolvedPath],
      },
      attachTo: options.attachTo,
      artifactInput: null,
      extractionInput: resolvedPath,
      extractionInputKind: "local_file",
    };
  }

  if (WORKSPACE_ITEM_ID_RE.test(trimmed)) {
    const item = await readWorkspaceItem(options.config.workspace.root, trimmed);
    if (item) {
      const url = sourceUrlFromWorkspaceItem(item);
      if (url) {
        return {
          resource: {
            kind: "workspace_item",
            input: trimmed,
            itemId: item.id,
            url,
            title: titleFromWorkspaceItem(item),
            targetPaths: [workspaceItemPath(options.config.workspace.root, item.id)],
          },
          attachTo: options.attachTo ?? item.id,
          artifactInput: item.id,
          extractionInput: url,
          extractionInputKind: "url",
        };
      }
      const itemDoi = doiFromWorkspaceItem(item);
      if (itemDoi) {
        return {
          resource: {
            kind: "workspace_item",
            input: trimmed,
            itemId: item.id,
            identifier: { scheme: "doi", value: itemDoi },
            title: titleFromWorkspaceItem(item),
            targetPaths: [workspaceItemPath(options.config.workspace.root, item.id)],
          },
          attachTo: options.attachTo ?? item.id,
          artifactInput: item.id,
          extractionInput: item.id,
          extractionInputKind: "url",
        };
      }
      fail(`Workspace item has no http(s) artifact URL or DOI: ${item.id}`);
    }
  }

  fail(`Input is not an http(s) URL, DOI, existing local file, or known workspace item id: ${options.input}`);
}

function pathInsideWorkspace(workspaceRoot: string, relativePath: string): string {
  return path.join(path.resolve(workspaceRoot), relativePath);
}

function plannedExtractionOutputPath(workspaceRoot: string): string {
  return pathInsideWorkspace(
    workspaceRoot,
    path.join(EXTRACTION_RECORDS_DIR, PLANNED_EXTRACTION_ID),
  );
}

function plannedArtifactRecordPath(workspaceRoot: string): string {
  return pathInsideWorkspace(
    workspaceRoot,
    path.join(ARTIFACT_RECORDS_DIR, `${PLANNED_ARTIFACT_ID}.json`),
  );
}

function plannedExtractionRecordPath(workspaceRoot: string): string {
  return pathInsideWorkspace(
    workspaceRoot,
    path.join(EXTRACTION_RECORDS_DIR, `${PLANNED_EXTRACTION_ID}.json`),
  );
}

function plannedMarkdownPath(workspaceRoot: string): string {
  return path.join(plannedExtractionOutputPath(workspaceRoot), "content.md");
}

function plannedJsonPath(workspaceRoot: string): string {
  return path.join(plannedExtractionOutputPath(workspaceRoot), "result.json");
}

function providerPackagePath(
  steps: readonly PlannedOperationStep[],
  providerId: string,
): string | undefined {
  for (const step of steps) {
    if (step.providerId === providerId && step.targetPaths.length > 0) {
      return step.targetPaths[0];
    }
  }
  return undefined;
}

function providerFromSelection(
  selection: PlannedProviderSelection | null,
  steps: readonly PlannedOperationStep[],
): MaterialIngestProviderPlan | null {
  if (!selection) return null;
  return {
    id: selection.id,
    kind: selection.kind === "material" ? "material" : "builtin",
    capabilities: selection.capabilities ?? [],
    ...(selection.kind === "material"
      ? { packagePath: providerPackagePath(steps, selection.id) }
      : {}),
  };
}

function prefixSteps(
  prefix: "artifact" | "extraction",
  steps: readonly PlannedOperationStep[],
): PlannedOperationStep[] {
  return steps.map((step) => ({
    ...step,
    id: `${prefix}.${step.id}`,
  }));
}

function replaceStepTargetPaths(
  steps: readonly PlannedOperationStep[],
  replacements: Readonly<Record<string, readonly string[]>>,
): PlannedOperationStep[] {
  return steps.map((step) => {
    const targetPaths = replacements[step.id];
    return targetPaths ? { ...step, targetPaths: [...targetPaths] } : step;
  });
}

function uniqueProviders(
  providers: readonly (MaterialIngestProviderPlan | null)[],
): MaterialIngestProviderPlan[] {
  const seen = new Set<string>();
  const result: MaterialIngestProviderPlan[] = [];
  for (const provider of providers) {
    if (!provider || seen.has(provider.id)) continue;
    seen.add(provider.id);
    result.push(provider);
  }
  return result;
}

function providerIds(providers: readonly MaterialIngestProviderPlan[]): string[] {
  return providers
    .filter((provider) => provider.kind === "material")
    .map((provider) => provider.id);
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function orchestratorSelection(
  selectedProviders: readonly MaterialIngestProviderPlan[],
): PlannedProviderSelection | null {
  const materialProviders = selectedProviders.filter((provider) => provider.kind === "material");
  if (materialProviders.length === 0) return null;
  if (materialProviders.length === 1) {
    return {
      id: materialProviders[0]!.id,
      kind: "material",
      capabilities: materialProviders[0]!.capabilities as ("acquire" | "extract")[],
    };
  }
  return null;
}

function resourceStep(resource: MaterialIngestResourcePlan): PlannedOperationStep {
  if (resource.kind === "identifier") {
    return {
      id: "resource.resolve-identifier",
      action: "compute",
      description: "Resolve the DOI identifier as the material resource.",
      targetPaths: [],
    };
  }
  if (resource.kind === "url") {
    return {
      id: "resource.resolve-url",
      action: "compute",
      description: "Resolve the input URL as the material resource.",
      targetPaths: [],
    };
  }
  if (resource.kind === "path") {
    return {
      id: "resource.resolve-path",
      action: "read",
      description: "Resolve the local file path as the material resource.",
      targetPaths: resource.path ? [resource.path] : [],
    };
  }
  return {
    id: "resource.resolve-workspace-item",
    action: "read",
    description: `Read workspace item ${resource.itemId} to resolve the material resource URL.`,
    targetPaths: resource.targetPaths,
  };
}

function localArtifactSteps(options: {
  resource: MaterialIngestResourcePlan;
  recordTargetPath: string;
  policy: string;
}): PlannedOperationStep[] {
  return [
    {
      id: "artifact.resolve-local-file",
      action: "read",
      description: "Use the local file as a user-supplied artifact source.",
      targetPaths: options.resource.path ? [options.resource.path] : [],
      providerId: LOCAL_ARTIFACT_PROVIDER.id,
      policy: options.policy,
    },
    {
      id: "artifact.record-local-artifact",
      action: "record",
      description: "Record the local file as a workspace artifact without copying bytes during the plan.",
      targetPaths: [options.recordTargetPath],
      providerId: LOCAL_ARTIFACT_PROVIDER.id,
      policy: options.policy,
    },
  ];
}

function artifactPlanFromLocalResource(options: {
  resource: MaterialIngestResourcePlan;
  recordTargetPath: string;
}): MaterialIngestArtifactPlan {
  return {
    mode: "record_local",
    plannedArtifactId: PLANNED_ARTIFACT_ID,
    source: {
      kind: "path",
      ...(options.resource.path ? { path: options.resource.path } : {}),
    },
    provider: LOCAL_ARTIFACT_PROVIDER,
    recordTargetPath: options.recordTargetPath,
  };
}

function artifactPlanFromDownload(options: {
  resource: MaterialIngestResourcePlan;
  artifactProvider: MaterialIngestProviderPlan | null;
  artifactData: PlannedOperationData;
  recordTargetPath: string;
}): MaterialIngestArtifactPlan {
  const source =
    options.resource.kind === "workspace_item"
      ? {
          kind: "workspace_item" as const,
          itemId: options.resource.itemId,
          ...(options.resource.url ? { url: options.resource.url } : {}),
        }
      : options.resource.kind === "identifier"
        ? {
            kind: "url" as const,
            url: options.resource.identifier?.value,
          }
        : {
            kind: "url" as const,
            url: options.resource.url,
          };
  return {
    mode: "download",
    plannedArtifactId: PLANNED_ARTIFACT_ID,
    source,
    provider: options.artifactProvider,
    recordTargetPath: options.recordTargetPath,
  };
}

function plannedExtractionInputKind(resolved: ResolvedMaterialIngestInput): MaterialInputKind {
  return resolved.artifactInput ? "artifact" : resolved.extractionInputKind;
}

function extractionPlanFromSubplan(options: {
  resource: MaterialIngestResourcePlan;
  extractionProvider: MaterialIngestProviderPlan;
  materialInputKind: MaterialInputKind;
  recordTargetPath: string;
  outputTargetPath: string;
  workspaceRoot: string;
}): MaterialIngestExtractionPlan {
  const source = options.resource.kind === "path"
    ? {
        kind: "path" as const,
        path: options.resource.path,
      }
    : {
        kind: "artifact" as const,
        artifactId: PLANNED_ARTIFACT_ID,
        ...(options.resource.url ? { url: options.resource.url } : {}),
      };

  return {
    plannedExtractionId: PLANNED_EXTRACTION_ID,
    source,
    materialInputKind: options.materialInputKind,
    provider: options.extractionProvider,
    recordTargetPath: options.recordTargetPath,
    outputTargetPath: options.outputTargetPath,
    markdownPath: plannedMarkdownPath(options.workspaceRoot),
    jsonPath: plannedJsonPath(options.workspaceRoot),
  };
}

function providerFromArtifactExecution(
  provider: {
    id: string;
    packagePath: string;
  },
): MaterialIngestProviderPlan {
  return {
    id: provider.id,
    kind: "material",
    capabilities: ["acquire"],
    packagePath: provider.packagePath,
  };
}

function providerFromExtractionExecution(
  provider: {
    id: string;
    packagePath: string;
  },
): MaterialIngestProviderPlan {
  return {
    id: provider.id,
    kind: "material",
    capabilities: ["extract"],
    packagePath: provider.packagePath,
  };
}

function absoluteWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`Material ingest output path escapes workspace root: ${relativePath}`);
  }
  return target;
}

function artifactRecordFilePath(workspaceRoot: string, artifactId: string): string {
  return pathInsideWorkspace(workspaceRoot, path.join(ARTIFACT_RECORDS_DIR, `${artifactId}.json`));
}

function extractionRecordFilePath(workspaceRoot: string, extractionId: string): string {
  return pathInsideWorkspace(workspaceRoot, path.join(EXTRACTION_RECORDS_DIR, `${extractionId}.json`));
}

function extractionOutputDirectoryPath(workspaceRoot: string, extractionId: string): string {
  return pathInsideWorkspace(workspaceRoot, path.join(EXTRACTION_RECORDS_DIR, extractionId));
}

function inferLocalArtifactKind(filePath: string): ArtifactKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (extension === ".html" || extension === ".htm") return "html";
  if ([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"].includes(extension)) return "office";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".tif", ".tiff"].includes(extension)) return "image";
  return "bytes";
}

function contentTypeFromLocalPath(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".txt" || extension === ".md") return "text/plain";
  if (extension === ".json") return "application/json";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  return undefined;
}

async function createLocalArtifactRecord(options: {
  workspaceRoot: string;
  localPath: string;
  attachTo: string | null;
  policy: string;
}): Promise<ArtifactRecord> {
  const localStat = await stat(options.localPath);
  if (!localStat.isFile()) {
    fail(`Path input must be a file: ${options.localPath}`);
  }
  const createdAt = new Date().toISOString();
  const filename = path.basename(options.localPath) || "artifact.bin";
  const contentType = contentTypeFromLocalPath(options.localPath);
  return createArtifactRecord(options.workspaceRoot, {
    kind: inferLocalArtifactKind(options.localPath),
    status: "recorded",
    ...(options.attachTo ? { itemId: options.attachTo } : {}),
    filename,
    ...(contentType ? { contentType } : {}),
    sizeBytes: localStat.size,
    provenance: {
      origin: "user_supplied",
      providerId: LOCAL_ARTIFACT_PROVIDER.id,
      policy: options.policy,
    },
    attempts: [
      {
        tier: "material-ingest-local-artifact",
        source: options.localPath,
        providerId: LOCAL_ARTIFACT_PROVIDER.id,
        ok: true,
        message: "Local file recorded as a user-supplied artifact",
        at: createdAt,
      },
    ],
    message: "Local file recorded as a user-supplied artifact",
    createdAt,
  });
}

function requireLocalResourcePath(resource: MaterialIngestResourcePlan): string {
  if (resource.kind !== "path" || !resource.path) {
    fail("Local artifact recording requires a resolved path resource");
  }
  return resource.path;
}

function requireExtractionOutputPath(
  record: ExtractionRecord,
  key: "markdownPath" | "jsonPath",
): string {
  const value = record.outputs[key];
  if (!value) {
    fail(`Material extraction record did not include outputs.${key}`);
  }
  return value;
}

function buildArtifactExecutionFromDownload(options: {
  plan: MaterialIngestPlanData;
  data: NonNullable<Awaited<ReturnType<typeof runArtifactDownload>>["data"]>;
  workspaceRoot: string;
}): MaterialIngestArtifactExecution {
  const artifactFilePath = options.data.artifactPath
    ? absoluteWorkspacePath(options.workspaceRoot, options.data.artifactPath)
    : undefined;
  return {
    mode: "download",
    artifactId: options.data.record.id,
    source: options.plan.artifact.source,
    provider: providerFromArtifactExecution(options.data.provider),
    recordTargetPath: artifactRecordFilePath(options.workspaceRoot, options.data.record.id),
    ...(artifactFilePath ? { fileTargetPath: artifactFilePath } : {}),
    input: options.data.input,
    record: options.data.record,
  };
}

function buildArtifactExecutionFromLocal(options: {
  plan: MaterialIngestPlanData;
  record: ArtifactRecord;
  workspaceRoot: string;
}): MaterialIngestArtifactExecution {
  return {
    mode: "record_local",
    artifactId: options.record.id,
    source: options.plan.artifact.source,
    provider: LOCAL_ARTIFACT_PROVIDER,
    recordTargetPath: artifactRecordFilePath(options.workspaceRoot, options.record.id),
    record: options.record,
  };
}

function buildExtractionExecution(options: {
  data: NonNullable<Awaited<ReturnType<typeof runMaterialExtraction>>["data"]>;
  workspaceRoot: string;
  materialInputKind: MaterialInputKind;
}): MaterialIngestExtractionExecution {
  const markdownRelativePath = requireExtractionOutputPath(options.data.record, "markdownPath");
  const jsonRelativePath = requireExtractionOutputPath(options.data.record, "jsonPath");
  return {
    extractionId: options.data.record.id,
    source: options.data.record.source,
    materialInputKind: options.materialInputKind,
    provider: providerFromExtractionExecution(options.data.provider),
    recordTargetPath: extractionRecordFilePath(options.workspaceRoot, options.data.record.id),
    outputTargetPath: extractionOutputDirectoryPath(options.workspaceRoot, options.data.record.id),
    markdownPath: absoluteWorkspacePath(options.workspaceRoot, markdownRelativePath),
    jsonPath: absoluteWorkspacePath(options.workspaceRoot, jsonRelativePath),
    record: options.data.record,
    markdown: options.data.markdown,
  };
}

function outputPathsFromExecution(options: {
  artifact: MaterialIngestArtifactExecution;
  extraction: MaterialIngestExtractionExecution;
}): MaterialIngestOutputPlan {
  return {
    artifactRecordPath: options.artifact.recordTargetPath,
    extractionRecordPath: options.extraction.recordTargetPath,
    extractionOutputPath: options.extraction.outputTargetPath,
    markdownPath: options.extraction.markdownPath,
    jsonPath: options.extraction.jsonPath,
    ...(options.artifact.fileTargetPath ? { artifactFilePath: options.artifact.fileTargetPath } : {}),
  };
}

function replacePlanPlaceholders(value: string, artifactId: string, extractionId: string): string {
  return value
    .replaceAll(PLANNED_ARTIFACT_ID, artifactId)
    .replaceAll(PLANNED_EXTRACTION_ID, extractionId);
}

function executedStepTargetPaths(options: {
  step: PlannedOperationStep;
  plan: MaterialIngestPlanData;
  artifact: MaterialIngestArtifactExecution;
  extraction: MaterialIngestExtractionExecution;
  outputs: MaterialIngestOutputPlan;
}): string[] {
  switch (options.step.id) {
    case "artifact.write-artifact":
      return options.outputs.artifactFilePath ? [options.outputs.artifactFilePath] : [];
    case "artifact.record-artifact":
    case "artifact.record-local-artifact":
      return [options.outputs.artifactRecordPath];
    case "extraction.write-markdown":
      return [options.outputs.extractionOutputPath, options.outputs.markdownPath, options.outputs.jsonPath];
    case "extraction.record-extraction":
      return [options.outputs.extractionRecordPath];
    default:
      return options.step.targetPaths.map((targetPath) =>
        replacePlanPlaceholders(targetPath, options.artifact.artifactId, options.extraction.extractionId),
      );
  }
}

function executedStepsFromPlan(options: {
  plan: MaterialIngestPlanData;
  artifact: MaterialIngestArtifactExecution;
  extraction: MaterialIngestExtractionExecution;
  outputs: MaterialIngestOutputPlan;
}): MaterialIngestExecutedStep[] {
  return options.plan.intendedSteps.map((step) => ({
    ...step,
    targetPaths: uniqueStrings(executedStepTargetPaths({ ...options, step })),
    status: "completed",
  }));
}

function targetPathsFromExecution(options: {
  plan: MaterialIngestPlanData;
  artifact: MaterialIngestArtifactExecution;
  extraction: MaterialIngestExtractionExecution;
  outputs: MaterialIngestOutputPlan;
  executedSteps: readonly MaterialIngestExecutedStep[];
}): string[] {
  return uniqueStrings([
    ...options.plan.targetPaths.map((targetPath) =>
      replacePlanPlaceholders(targetPath, options.artifact.artifactId, options.extraction.extractionId),
    ),
    ...options.executedSteps.flatMap((step) => step.targetPaths),
    options.outputs.artifactRecordPath,
    options.outputs.extractionRecordPath,
    options.outputs.extractionOutputPath,
    options.outputs.markdownPath,
    options.outputs.jsonPath,
    options.outputs.artifactFilePath,
  ]);
}

export async function planMaterialIngest(
  options: MaterialIngestPlanOptions,
): Promise<ResultEnvelope<MaterialIngestPlanData>> {
  const started = Date.now();
  const policy = normalizePolicy(options.policy);
  const explicitAttachTo = normalizeAttachTo(options.attachTo);
  const resolved = await resolveMaterialIngestInput({
    config: options.config,
    input: options.input,
    attachTo: explicitAttachTo,
  });
  const attachTo = resolved.attachTo;
  const artifactRecordsDir = pathInsideWorkspace(options.config.workspace.root, ARTIFACT_RECORDS_DIR);
  const extractionRecordsDir = pathInsideWorkspace(options.config.workspace.root, EXTRACTION_RECORDS_DIR);
  const artifactRecordPath = plannedArtifactRecordPath(options.config.workspace.root);
  const extractionRecordPath = plannedExtractionRecordPath(options.config.workspace.root);
  const extractionOutputPath = plannedExtractionOutputPath(options.config.workspace.root);

  const artifactEnvelope = resolved.artifactInput
    ? await planArtifactDownload({
        config: options.config,
        input: resolved.artifactInput,
        attachTo: attachTo ?? undefined,
        providerId: options.artifactProviderId,
        policy,
        download: true,
      })
    : null;
  const extractionInputKind = plannedExtractionInputKind(resolved);
  const extractionEnvelope = await planMaterialExtractionForInputKind({
    config: options.config,
    inputKind: extractionInputKind,
    sourceKind: resolved.artifactInput ? "artifact" : "path",
    attachTo: attachTo ?? undefined,
    providerId: options.extractProviderId,
    policy,
  });

  if (!extractionEnvelope.data) {
    fail("Extraction plan did not return plan data");
  }
  const artifactData = artifactEnvelope ? artifactEnvelope.data : null;
  if (artifactEnvelope && !artifactData) {
    fail("Artifact plan did not return plan data");
  }

  const artifactProvider = artifactData
    ? providerFromSelection(artifactData.selectedProvider, artifactData.intendedSteps)
    : LOCAL_ARTIFACT_PROVIDER;
  const extractionProvider = providerFromSelection(
    extractionEnvelope.data.selectedProvider,
    extractionEnvelope.data.intendedSteps,
  );
  if (!extractionProvider) {
    fail("Extraction plan did not select a material provider");
  }

  const selectedProviders = uniqueProviders([artifactProvider, extractionProvider]);
  const artifact = artifactData
    ? artifactPlanFromDownload({
        resource: resolved.resource,
        artifactProvider,
        artifactData,
        recordTargetPath: artifactRecordPath,
      })
    : artifactPlanFromLocalResource({
        resource: resolved.resource,
        recordTargetPath: artifactRecordPath,
      });
  const extraction = extractionPlanFromSubplan({
    resource: resolved.resource,
    extractionProvider,
    materialInputKind: extractionInputKind,
    recordTargetPath: extractionRecordPath,
    outputTargetPath: extractionOutputPath,
    workspaceRoot: options.config.workspace.root,
  });
  const outputs: MaterialIngestOutputPlan = {
    artifactRecordPath,
    extractionRecordPath,
    extractionOutputPath,
    markdownPath: extraction.markdownPath,
    jsonPath: extraction.jsonPath,
    ...(artifact.fileTargetPath ? { artifactFilePath: artifact.fileTargetPath } : {}),
  };

  const artifactIntendedSteps = artifactData
    ? replaceStepTargetPaths(prefixSteps("artifact", artifactData.intendedSteps), {
        "artifact.record-artifact": [artifactRecordPath],
      })
    : localArtifactSteps({ resource: resolved.resource, recordTargetPath: artifactRecordPath, policy });
  const extractionIntendedSteps = replaceStepTargetPaths(
    prefixSteps("extraction", extractionEnvelope.data.intendedSteps),
    {
      "extraction.write-markdown": [extractionOutputPath, extraction.markdownPath, extraction.jsonPath],
      "extraction.record-extraction": [extractionRecordPath],
    },
  );
  const intendedSteps: PlannedOperationStep[] = [
    resourceStep(resolved.resource),
    ...artifactIntendedSteps,
    ...extractionIntendedSteps,
  ];

  const baseEnvelope = createPlanEnvelope({
    capability: "orchestrate",
    tool: "material_ingest",
    selectedPolicy: policy,
    selectedProvider: orchestratorSelection(selectedProviders),
    intendedSteps,
    targetPaths: [
      ...resolved.resource.targetPaths,
      ...(artifactData?.targetPaths.filter((targetPath) => targetPath !== artifactRecordsDir) ?? []),
      ...extractionEnvelope.data.targetPaths.filter((targetPath) => targetPath !== extractionRecordsDir),
      artifactRecordPath,
      extractionRecordPath,
      extractionOutputPath,
      extraction.markdownPath,
      extraction.jsonPath,
    ],
    diagnostics: {
      elapsedMs: Date.now() - started,
      inputKind: resolved.resource.kind,
      extractionInputKind,
      workspaceRoot: options.config.workspace.root,
      attachTo,
    },
    provenance: {
      configPaths: options.config.meta.loadedFiles,
      providerIds: providerIds(selectedProviders),
      policy,
    },
  });

  if (!baseEnvelope.data) {
    fail("Material ingest plan did not return plan data");
  }

  return {
    ...baseEnvelope,
    data: {
      ...baseEnvelope.data,
      resource: resolved.resource,
      artifact,
      extraction,
      policy: {
        name: policy,
        attachTo,
      },
      providers: {
        artifact: artifactProvider,
        extraction: extractionProvider,
        selected: selectedProviders,
      },
      outputs,
    },
  };
}

export async function runMaterialIngest(
  options: MaterialIngestPlanOptions,
): Promise<ResultEnvelope<MaterialIngestExecutionData>> {
  const started = Date.now();
  const planEnvelope = await planMaterialIngest(options);
  if (!planEnvelope.data) {
    fail("Material ingest plan did not return plan data");
  }
  const plan = planEnvelope.data;
  const policy = plan.policy.name;
  const attachTo = plan.policy.attachTo;
  const workspaceRoot = options.config.workspace.root;

  let artifact: MaterialIngestArtifactExecution;
  let extractionInput: string;
  let extractionInputKind: MaterialInputKind;

  if (plan.artifact.mode === "download") {
    const artifactEnvelope = await runArtifactDownload({
      config: options.config,
      input: plan.resource.kind === "workspace_item"
        ? plan.resource.input
        : plan.resource.url ?? options.input,
      attachTo: attachTo ?? undefined,
      providerId: options.artifactProviderId,
      policy,
      download: true,
    });
    if (!artifactEnvelope.data) {
      fail("Artifact download did not return execution data");
    }
    artifact = buildArtifactExecutionFromDownload({
      plan,
      data: artifactEnvelope.data,
      workspaceRoot,
    });
    extractionInput = artifact.record.id;
    extractionInputKind = "artifact";
  } else {
    const localPath = requireLocalResourcePath(plan.resource);
    const record = await createLocalArtifactRecord({
      workspaceRoot,
      localPath,
      attachTo,
      policy,
    });
    artifact = buildArtifactExecutionFromLocal({
      plan,
      record,
      workspaceRoot,
    });
    extractionInput = localPath;
    extractionInputKind = "local_file";
  }

  const extractionEnvelope = await runMaterialExtraction({
    config: options.config,
    input: extractionInput,
    attachTo: attachTo ?? undefined,
    providerId: options.extractProviderId,
    policy,
  });
  if (!extractionEnvelope.data) {
    fail("Material extraction did not return execution data");
  }
  const extraction = buildExtractionExecution({
    data: extractionEnvelope.data,
    workspaceRoot,
    materialInputKind: extractionInputKind,
  });
  const providers = {
    artifact: artifact.provider,
    extraction: extraction.provider,
    selected: uniqueProviders([artifact.provider, extraction.provider]),
  };
  const outputs = outputPathsFromExecution({ artifact, extraction });
  const executedSteps = executedStepsFromPlan({
    plan,
    artifact,
    extraction,
    outputs,
  });
  const targetPaths = targetPathsFromExecution({
    plan,
    artifact,
    extraction,
    outputs,
    executedSteps,
  });

  return okEnvelope({
    capability: "orchestrate",
    tool: "material_ingest",
    data: {
      executedSteps,
      selectedPolicy: policy,
      selectedProvider: orchestratorSelection(providers.selected),
      targetPaths,
      resource: plan.resource,
      artifact,
      extraction,
      policy: plan.policy,
      providers,
      outputs,
    },
    diagnostics: {
      elapsedMs: Date.now() - started,
      inputKind: plan.resource.kind,
      extractionInputKind,
      workspaceRoot,
      attachTo,
      artifactId: artifact.artifactId,
      extractionId: extraction.extractionId,
      sourceCounts: {
        artifacts: 1,
        extractions: 1,
      },
    },
    provenance: {
      configPaths: options.config.meta.loadedFiles,
      providerIds: providerIds(providers.selected),
      policy,
    },
  });
}
