import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig } from "../config/schema.js";
import {
  listArtifactRecords,
  readArtifactRecord,
  type ArtifactRecord,
} from "./artifactStore.js";
import {
  listExtractionRecords,
  readExtractionRecord,
  type ExtractionRecord,
} from "./extractionStore.js";
import { failEnvelope, okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import type { WorkspaceItemRecord } from "../workspace/store.js";

export interface MaterialStatusOptions {
  config: ResolvedConfig;
  input: string;
}

export type MaterialStatusTarget =
  | {
      kind: "workspace_item";
      id: string;
      itemId: string;
    }
  | {
      kind: "artifact";
      id: string;
      artifactId: string;
      itemId?: string;
    }
  | {
      kind: "extraction";
      id: string;
      extractionId: string;
      artifactId?: string;
      itemId?: string;
    };

export interface MaterialExtractionOutputSummary {
  extractionId: string;
  status: ExtractionRecord["status"];
  markdownPath?: string;
  jsonPath?: string;
  assetsDir?: string;
  hasInlineMarkdown: boolean;
}

export interface MaterialStatusData {
  target: MaterialStatusTarget;
  item?: WorkspaceItemRecord;
  hasArtifacts: boolean;
  artifactCount: number;
  artifactIds: string[];
  artifacts: ArtifactRecord[];
  hasExtractedOutputs: boolean;
  extractedOutputCount: number;
  extractedOutputs: MaterialExtractionOutputSummary[];
  extractionCount: number;
  extractionIds: string[];
  extractions: ExtractionRecord[];
  relatedItemIds: string[];
}

type MaterialStatusEnvelope = ResultEnvelope<MaterialStatusData> | ResultEnvelope<null>;

interface ResolvedWorkspaceItemTarget {
  kind: "workspace_item";
  item: WorkspaceItemRecord;
}

interface ResolvedArtifactTarget {
  kind: "artifact";
  artifact: ArtifactRecord;
}

interface ResolvedExtractionTarget {
  kind: "extraction";
  extraction: ExtractionRecord;
}

type ResolvedMaterialStatusTarget =
  | ResolvedWorkspaceItemTarget
  | ResolvedArtifactTarget
  | ResolvedExtractionTarget;

export class MaterialStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialStatusError";
  }
}

const TARGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKSPACE_ITEMS_DIR = "items";

function fail(message: string): never {
  throw new MaterialStatusError(message);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeTargetId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) fail("material status target must be non-empty");
  if (!TARGET_ID_RE.test(trimmed) || trimmed === "." || trimmed === "..") {
    fail(`Invalid material status target id: ${input}`);
  }
  return trimmed;
}

function workspaceItemPath(workspaceRoot: string, itemId: string): string {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_ITEMS_DIR, `${normalizeTargetId(itemId)}.json`);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function parseWorkspaceItemRecord(value: unknown, expectedId: string): WorkspaceItemRecord {
  if (!isPlainObject(value)) fail("workspace item record must be an object");
  const id = assertString(value.id, "workspace item id");
  if (id !== expectedId) fail(`Workspace item id mismatch in record: ${expectedId}`);
  if (!isPlainObject(value.item)) fail("workspace item.item must be an object");
  assertString(value.createdAt, "workspace item createdAt");
  assertString(value.collectionKey, "workspace item collectionKey");
  assertString(value.collectionPath, "workspace item collectionPath");
  if (!Array.isArray(value.tags)) fail("workspace item tags must be an array");
  return value as unknown as WorkspaceItemRecord;
}

async function readWorkspaceItem(
  workspaceRoot: string,
  itemId: string,
): Promise<WorkspaceItemRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(workspaceItemPath(workspaceRoot, itemId), "utf8")) as unknown;
    return parseWorkspaceItemRecord(parsed, itemId);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function resolveMaterialStatusTarget(
  workspaceRoot: string,
  targetId: string,
): Promise<ResolvedMaterialStatusTarget | null> {
  const item = await readWorkspaceItem(workspaceRoot, targetId);
  if (item) return { kind: "workspace_item", item };

  const artifact = await readArtifactRecord(workspaceRoot, targetId);
  if (artifact) return { kind: "artifact", artifact };

  const extraction = await readExtractionRecord(workspaceRoot, targetId);
  if (extraction) return { kind: "extraction", extraction };

  return null;
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasExtractedOutput(record: ExtractionRecord): boolean {
  return (
    isNonEmptyString(record.outputs.markdownPath) ||
    isNonEmptyString(record.outputs.jsonPath) ||
    isNonEmptyString(record.outputs.assetsDir) ||
    isNonEmptyString(record.outputs.markdown)
  );
}

function extractionOutputSummary(record: ExtractionRecord): MaterialExtractionOutputSummary {
  return {
    extractionId: record.id,
    status: record.status,
    ...(record.outputs.markdownPath ? { markdownPath: record.outputs.markdownPath } : {}),
    ...(record.outputs.jsonPath ? { jsonPath: record.outputs.jsonPath } : {}),
    ...(record.outputs.assetsDir ? { assetsDir: record.outputs.assetsDir } : {}),
    hasInlineMarkdown: isNonEmptyString(record.outputs.markdown),
  };
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter(isNonEmptyString))].sort((left, right) => left.localeCompare(right));
}

function extractionIsForArtifacts(record: ExtractionRecord, artifactIds: Set<string>): boolean {
  return (
    record.source.kind === "artifact" &&
    record.source.artifactId !== undefined &&
    artifactIds.has(record.source.artifactId)
  );
}

async function materialStatusForItem(
  workspaceRoot: string,
  item: WorkspaceItemRecord,
): Promise<MaterialStatusData> {
  const artifacts = await listArtifactRecords(workspaceRoot, { itemId: item.id });
  const artifactIds = new Set(artifacts.map((record) => record.id));
  const extractions = (await listExtractionRecords(workspaceRoot)).filter(
    (record) => record.itemId === item.id || extractionIsForArtifacts(record, artifactIds),
  );
  return buildStatusData({
    target: {
      kind: "workspace_item",
      id: item.id,
      itemId: item.id,
    },
    item,
    artifacts,
    extractions,
  });
}

async function materialStatusForArtifact(
  workspaceRoot: string,
  artifact: ArtifactRecord,
): Promise<MaterialStatusData> {
  const extractions = (await listExtractionRecords(workspaceRoot)).filter(
    (record) => record.source.kind === "artifact" && record.source.artifactId === artifact.id,
  );
  return buildStatusData({
    target: {
      kind: "artifact",
      id: artifact.id,
      artifactId: artifact.id,
      ...(artifact.itemId ? { itemId: artifact.itemId } : {}),
    },
    artifacts: [artifact],
    extractions,
  });
}

async function materialStatusForExtraction(
  workspaceRoot: string,
  extraction: ExtractionRecord,
): Promise<MaterialStatusData> {
  const artifact =
    extraction.source.kind === "artifact" && extraction.source.artifactId
      ? await readArtifactRecord(workspaceRoot, extraction.source.artifactId)
      : null;
  return buildStatusData({
    target: {
      kind: "extraction",
      id: extraction.id,
      extractionId: extraction.id,
      ...(extraction.source.kind === "artifact" && extraction.source.artifactId
        ? { artifactId: extraction.source.artifactId }
        : {}),
      ...(extraction.itemId ? { itemId: extraction.itemId } : {}),
    },
    artifacts: artifact ? [artifact] : [],
    extractions: [extraction],
  });
}

function buildStatusData(options: {
  target: MaterialStatusTarget;
  item?: WorkspaceItemRecord;
  artifacts: ArtifactRecord[];
  extractions: ExtractionRecord[];
}): MaterialStatusData {
  const artifactIds = options.artifacts.map((record) => record.id);
  const extractionIds = options.extractions.map((record) => record.id);
  const extractedOutputs = options.extractions.filter(hasExtractedOutput).map(extractionOutputSummary);
  return {
    target: options.target,
    ...(options.item ? { item: options.item } : {}),
    hasArtifacts: options.artifacts.length > 0,
    artifactCount: options.artifacts.length,
    artifactIds,
    artifacts: options.artifacts,
    hasExtractedOutputs: extractedOutputs.length > 0,
    extractedOutputCount: extractedOutputs.length,
    extractedOutputs,
    extractionCount: options.extractions.length,
    extractionIds,
    extractions: options.extractions,
    relatedItemIds: uniqueSorted([
      options.target.itemId,
      ...(options.item ? [options.item.id] : []),
      ...options.artifacts.map((record) => record.itemId),
      ...options.extractions.map((record) => record.itemId),
    ]),
  };
}

async function materialStatusDataForTarget(
  workspaceRoot: string,
  target: ResolvedMaterialStatusTarget,
): Promise<MaterialStatusData> {
  if (target.kind === "workspace_item") return materialStatusForItem(workspaceRoot, target.item);
  if (target.kind === "artifact") return materialStatusForArtifact(workspaceRoot, target.artifact);
  return materialStatusForExtraction(workspaceRoot, target.extraction);
}

function providerIdsForStatus(data: MaterialStatusData): string[] {
  return uniqueSorted([
    ...data.artifacts.map((record) => record.provenance.providerId),
    ...data.extractions.map((record) => record.backend),
  ]);
}

export async function runMaterialStatus(options: MaterialStatusOptions): Promise<MaterialStatusEnvelope> {
  const started = Date.now();
  let targetId: string;
  try {
    targetId = normalizeTargetId(options.input);
  } catch (error) {
    return failEnvelope({
      capability: "orchestrate",
      tool: "material_status",
      errors: [formatError(error)],
      diagnostics: { elapsedMs: Date.now() - started },
    });
  }

  const resolvedTarget = await resolveMaterialStatusTarget(options.config.workspace.root, targetId);
  if (!resolvedTarget) {
    return failEnvelope({
      capability: "orchestrate",
      tool: "material_status",
      errors: [`Material status target not found: ${targetId}`],
      diagnostics: {
        workspaceRoot: options.config.workspace.root,
        targetId,
        elapsedMs: Date.now() - started,
      },
    });
  }

  const data = await materialStatusDataForTarget(options.config.workspace.root, resolvedTarget);
  const providerIds = providerIdsForStatus(data);
  return okEnvelope({
    capability: "orchestrate",
    tool: "material_status",
    data,
    diagnostics: {
      workspaceRoot: options.config.workspace.root,
      targetId,
      targetKind: data.target.kind,
      sourceCounts: {
        artifacts: data.artifactCount,
        extractions: data.extractionCount,
        extractedOutputs: data.extractedOutputCount,
      },
      elapsedMs: Date.now() - started,
    },
    ...(providerIds.length > 0 ? { provenance: { providerIds } } : {}),
  });
}
