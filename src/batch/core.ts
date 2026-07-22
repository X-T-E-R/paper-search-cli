import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { ResolvedConfig } from "../config/schema.js";
import { AcquireResolverError, planArtifactDownload, runArtifactDownload } from "../material/artifactDownload.js";
import { planMaterialExtraction, runMaterialExtraction } from "../material/extract.js";
import { planMaterialIngest, runMaterialIngest } from "../material/ingest.js";
import { planResourcePdfCompatibility, runResourcePdfCompatibility } from "../material/resourcePdf.js";
import type { PatentDetailResult, ResourceItem } from "../providers/sdk/types.js";
import {
  type WorkspaceDetailPayload,
} from "../workspace/store.js";
import { selectResourceIntoWorkspace } from "../workspace/selection.js";
import { failEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import { runCanonicalTool } from "../surface/toolRunner.js";

export type BatchAddMode = "row" | "none" | "first";
export type BatchOutputFormat = "json" | "jsonl" | "csv";
export type BatchStatus = "ok" | "skipped" | "error";
export type BatchTool =
  | "academic_search"
  | "patent_search"
  | "patent_detail"
  | "web_search"
  | "resource_lookup"
  | "resource_add"
  | "resource_pdf"
  | "artifact_download"
  | "extract"
  | "material_ingest"
  | "citation_expand"
  | "assessment_run";
export type BatchMaterialTool = Extract<BatchTool, "artifact_download" | "extract" | "material_ingest">;
export type BatchWorkflowTool = Extract<BatchTool, "citation_expand" | "assessment_run">;
export type BatchDiscoveryTool = Extract<
  BatchTool,
  "academic_search" | "patent_search" | "patent_detail" | "web_search" | "resource_lookup"
>;

export interface BatchDefaults {
  addMode: BatchAddMode;
  collectionKey?: string;
  collectionPath?: string;
  collectionMap: Record<string, string>;
  defaultPlatform?: string;
  extraTags: string[];
  fetchPdf: boolean;
  includeRaw: boolean;
  maxResults?: number;
  skipStatuses: Set<string>;
}

export interface BatchTask {
  index: number;
  id: string;
  raw: Record<string, string>;
  tool: BatchTool;
  args: Record<string, unknown>;
  addMode: Exclude<BatchAddMode, "row">;
  addArgs: Record<string, unknown>;
  fetchPdf: boolean;
  tags: string[];
  skipReason?: string;
}

export interface BatchResult {
  index: number;
  id: string;
  status: BatchStatus;
  ok?: boolean;
  capability?: ResultEnvelope["capability"];
  tool?: string;
  data?: unknown;
  addMode?: string;
  resultCount?: number;
  selected?: Record<string, unknown>;
  add?: unknown;
  planned?: boolean;
  state?: ResultEnvelope["state"];
  actions?: ResultEnvelope["actions"];
  diagnostics?: ResultEnvelope["diagnostics"];
  warnings?: string[];
  errors?: string[];
  provenance?: ResultEnvelope["provenance"];
  raw?: unknown;
  error?: string;
  skippedReason?: string;
}

interface BatchRuntime {
  config: ResolvedConfig;
  recordHistory?: boolean;
}

interface CollectionTarget {
  collectionKey?: string;
  collectionPath?: string;
}

const MATERIAL_BATCH_TOOLS = [
  "artifact_download",
  "extract",
  "material_ingest",
] as const satisfies readonly BatchMaterialTool[];

function isMaterialBatchTool(tool: BatchTool): tool is BatchMaterialTool {
  return (MATERIAL_BATCH_TOOLS as readonly string[]).includes(tool);
}

function isWorkflowBatchTool(tool: BatchTool): tool is BatchWorkflowTool {
  return tool === "citation_expand" || tool === "assessment_run";
}

function isDiscoveryBatchTool(tool: BatchTool): tool is BatchDiscoveryTool {
  return [
    "academic_search",
    "patent_search",
    "patent_detail",
    "web_search",
    "resource_lookup",
  ].includes(tool);
}

export function parseCsvText(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const [headerRow, ...dataRows] = rows.filter((candidate) =>
    candidate.some((value) => value.trim().length > 0),
  );
  if (!headerRow) return [];

  const headers = headerRow.map((header) => header.trim());
  return dataRows
    .filter((dataRow) => dataRow.some((value) => value.trim().length > 0))
    .map((dataRow) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        if (header) {
          record[header] = (dataRow[index] ?? "").trim();
        }
      });
      return record;
    });
}

export async function readBatchRows(filePath: string): Promise<Record<string, string>[]> {
  const text = await readFile(filePath, "utf8");
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".csv") {
    return parseCsvText(text);
  }

  if (extension === ".jsonl" || extension === ".ndjson") {
    return text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => normalizeRow(JSON.parse(line)));
  }

  const parsed =
    extension === ".yaml" || extension === ".yml" ? YAML.parse(text) : JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown[] })?.tasks;
  if (!Array.isArray(rows)) {
    throw new Error(
      "Batch input must be CSV, JSONL, a JSON/YAML array, or an object with a tasks array.",
    );
  }
  return rows.map((row) => normalizeRow(row));
}

export async function readCompletedBatchResultIds(filePath: string): Promise<Set<string>> {
  const text = await readFile(filePath, "utf8");
  return parseCompletedBatchResultIds(text, filePath);
}

export function parseCompletedBatchResultIds(
  text: string,
  sourceLabel = "batch result JSONL",
): Set<string> {
  const completedIds = new Set<string>();
  const lines = text.split(/\r?\n/u);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not parse ${sourceLabel} line ${index + 1}: ${message}`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`Expected ${sourceLabel} line ${index + 1} to be a JSON object.`);
    }
    const id = typeof parsed.id === "string" ? parsed.id : undefined;
    const status = typeof parsed.status === "string" ? parsed.status.toLowerCase() : undefined;
    const planned = parsed.planned === true;
    if (id && !planned && (status === "ok" || status === "skipped")) {
      completedIds.add(id);
    }
  });

  return completedIds;
}

export async function readCollectionMap(input: string | undefined): Promise<Record<string, string>> {
  if (!input) return {};
  let raw = input;
  if (input.startsWith("@")) {
    raw = await readFile(input.slice(1), "utf8");
  }
  const parsed = parseStructuredValue(raw);
  if (!isRecord(parsed)) {
    throw new Error("Collection map must be a JSON/YAML object.");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, value === undefined ? "" : String(value)]),
  );
}

export function buildBatchTasks(rows: Record<string, string>[], defaults: BatchDefaults): BatchTask[] {
  return rows.map((row, index) => buildBatchTask(row, index, defaults));
}

export function buildBatchTask(
  row: Record<string, string>,
  index: number,
  defaults: BatchDefaults,
): BatchTask {
  const id = pick(row, ["task_id", "id", "key", "name"]) || String(index + 1);
  const status = pick(row, ["status", "state"]);
  if (status && defaults.skipStatuses.has(status.toLowerCase())) {
    return skippedTask(index, id, row, `status:${status}`);
  }

  const tool = normalizeTool(row);
  const fetchPdf = parseBoolean(pick(row, ["fetch_pdf", "fetchPDF"]), defaults.fetchPdf);
  const tags = mergeUnique([...defaults.extraTags, ...parseTags(pick(row, ["tags", "tag"]))]);
  const collectionTarget = resolveCollectionTarget(row, defaults);
  const addMode = isMaterialBatchTool(tool) || isWorkflowBatchTool(tool)
    ? "none"
    : resolveAddMode(row, defaults.addMode);
  const args = buildToolArgs(tool, row, defaults);
  const addArgs = cleanObject({
    collectionKey: collectionTarget.collectionKey,
    collectionPath: collectionTarget.collectionPath,
    tags: tags.length > 0 ? tags : undefined,
    fetchPdf,
  });

  return { index, id, raw: row, tool, args, addMode, addArgs, fetchPdf, tags };
}

export async function runBatchTasks(
  runtime: BatchRuntime,
  tasks: BatchTask[],
  options: {
    concurrency: number;
    failFast: boolean;
    includeRaw: boolean;
    progress?: (result: BatchResult) => void;
  },
): Promise<BatchResult[]> {
  const results = new Array<BatchResult>(tasks.length);
  let cursor = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped) {
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= tasks.length) return;
      const task = tasks[currentIndex]!;
      const result = await executeBatchTask(runtime, task, options.includeRaw);
      results[currentIndex] = result;
      options.progress?.(result);
      if (options.failFast && result.status === "error") {
        stopped = true;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(options.concurrency, tasks.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.filter(Boolean);
}

export async function executeBatchTask(
  runtime: BatchRuntime,
  task: BatchTask,
  includeRaw: boolean,
): Promise<BatchResult> {
  if (task.skipReason) {
    return {
      index: task.index,
      id: task.id,
      status: "skipped",
      skippedReason: task.skipReason,
    };
  }

  try {
    if (isMaterialBatchTool(task.tool)) {
      const envelope = await executeMaterialTool(runtime.config, task.tool, task.args);
      return envelopeBatchResult(task, envelope, includeRaw);
    }

    if (isWorkflowBatchTool(task.tool)) {
      const envelope = await runCanonicalTool(runtime.config, task.tool, task.args);
      return envelopeBatchResult(task, envelope, includeRaw);
    }

    if (isDiscoveryBatchTool(task.tool)) {
      const envelope = await runCanonicalTool(
        runtime.config,
        task.tool,
        task.args,
        runtime.recordHistory === undefined
          ? {}
          : { recordHistory: runtime.recordHistory },
      );
      if (!envelope.ok) return envelopeBatchResult(task, envelope, includeRaw);

      const rawResult = envelope.data;
      const candidates = extractCandidates(rawResult);
      const selected = task.addMode === "first"
        ? selectAddCandidate(task.tool, rawResult, candidates)
        : undefined;
      if (task.addMode === "first" && !selected) {
        return cleanResult({
          index: task.index,
          id: task.id,
          status: "error",
          ok: false,
          capability: envelope.capability,
          tool: task.tool,
          addMode: task.addMode,
          resultCount: candidates.length,
          diagnostics: envelope.diagnostics,
          warnings: envelope.warnings,
          provenance: envelope.provenance,
          raw: includeRaw ? envelope : undefined,
          error: missingAddCandidateError(task.tool, rawResult, candidates.length),
        });
      }

      const addResult = selected
        ? await executeSelectedAdd(runtime.config, task, rawResult, selected)
        : undefined;
      return cleanResult({
        index: task.index,
        id: task.id,
        status: "ok",
        ok: true,
        capability: envelope.capability,
        tool: task.tool,
        data: envelope.data,
        addMode: task.addMode,
        resultCount: candidates.length,
        selected: selected ? summarizeCandidate(selected) : undefined,
        add: addResult,
        diagnostics: envelope.diagnostics,
        warnings: envelope.warnings,
        provenance: envelope.provenance,
        raw: includeRaw ? envelope : undefined,
      });
    }

    if (task.tool === "resource_add") {
      const add = await executeDirectAdd(runtime.config, mergeDirectAddArgs(task));
      return cleanResult({
        index: task.index,
        id: task.id,
        status: "ok",
        tool: task.tool,
        addMode: "direct",
        add,
        raw: includeRaw ? add : undefined,
      });
    }

    if (task.tool === "resource_pdf") {
      const envelope = await executeLocalTool(runtime.config, task.tool, task.args) as ResultEnvelope;
      return envelopeBatchResult(task, envelope, includeRaw);
    }

    throw new Error(`Unsupported batch tool: ${task.tool}`);
  } catch (error) {
    if (isMaterialBatchTool(task.tool) || isWorkflowBatchTool(task.tool)) {
      const capability = task.tool === "assessment_run" ? "assess" : "orchestrate";
      return envelopeBatchResult(
        task,
        isMaterialBatchTool(task.tool)
          ? materialFailureEnvelope(task.tool, error)
          : failEnvelope({
              capability,
              tool: task.tool,
              errors: [error instanceof Error ? error.message : String(error)],
            }),
        includeRaw,
      );
    }
    return {
      index: task.index,
      id: task.id,
      status: "error",
      tool: task.tool,
      addMode: task.addMode,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function serializeBatchResults(results: BatchResult[], format: BatchOutputFormat): string {
  if (format === "json") return `${JSON.stringify(results, null, 2)}\n`;
  if (format === "jsonl") return `${results.map((result) => JSON.stringify(result)).join("\n")}\n`;

  const columns = [
    "index",
    "id",
    "status",
    "tool",
    "addMode",
    "resultCount",
    "selectedTitle",
    "selectedDoi",
    "selectedUrl",
    "error",
    "skippedReason",
  ];
  const lines = [
    columns.map(csvEscape).join(","),
    ...results.map((result) => {
      const selected = result.selected ?? {};
      const row: Record<string, unknown> = {
        index: result.index,
        id: result.id,
        status: result.status,
        tool: result.tool,
        addMode: result.addMode,
        resultCount: result.resultCount,
        selectedTitle: selected.title,
        selectedDoi: selected.doi,
        selectedUrl: selected.url,
        error: result.error,
        skippedReason: result.skippedReason,
      };
      return columns.map((column) => csvEscape(row[column])).join(",");
    }),
  ];
  return `${lines.join("\n")}\n`;
}

export function serializeBatchResultJsonl(result: BatchResult): string {
  return `${JSON.stringify(result)}\n`;
}

export function inferOutputFormat(
  filePath: string | undefined,
  explicit: string | undefined,
): BatchOutputFormat {
  const value = (explicit || path.extname(filePath || "").replace(/^\./u, "") || "jsonl").toLowerCase();
  if (value === "json" || value === "jsonl" || value === "csv") {
    return value;
  }
  throw new Error(`Unsupported batch output format: ${value}`);
}

export function missingAddCandidateError(tool: string, result: unknown, candidateCount: number): string {
  const message = isRecord(result) && typeof result.message === "string" ? result.message.trim() : "";
  if (message) {
    return `Add requested for ${tool}, but no addable candidate was found: ${message}`;
  }
  return `Add requested for ${tool}, but no addable candidate was found (candidate count: ${candidateCount}).`;
}

async function executeLocalTool(
  config: ResolvedConfig,
  tool: BatchTask["tool"],
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    case "resource_add":
      return executeDirectAdd(config, args);
    case "resource_pdf":
      {
        const materialOptions = {
          config,
          itemKey: typeof args.itemKey === "string" ? args.itemKey : "",
          url: typeof args.url === "string" ? args.url : undefined,
          filename: typeof args.filename === "string" ? args.filename : undefined,
          download: args.download !== false,
          providerId: stringArg(args, "providerId"),
          resolverProviderId: stringArg(args, "resolverProviderId"),
          policy: stringArg(args, "policy"),
        };
        return booleanArg(args, "dryRun") === true
          ? planResourcePdfCompatibility(materialOptions)
          : runResourcePdfCompatibility(materialOptions);
      }
    default:
      throw new Error(`Unsupported batch tool: ${tool}`);
  }
}

async function executeMaterialTool(
  config: ResolvedConfig,
  tool: BatchMaterialTool,
  args: Record<string, unknown>,
): Promise<ResultEnvelope> {
  const dryRun = booleanArg(args, "dryRun") === true;
  if (tool === "artifact_download") {
    const materialOptions = {
      config,
      input: requiredStringArg(args, "input", "input"),
      attachTo: stringArg(args, "attachTo"),
      providerId: stringArg(args, "providerId"),
      policy: stringArg(args, "policy"),
      resolverProviderId: stringArg(args, "resolverId") ?? stringArg(args, "resolverProviderId"),
      download: booleanArg(args, "download"),
    };
    return dryRun
      ? planArtifactDownload(materialOptions)
      : runArtifactDownload(materialOptions);
  }

  if (tool === "extract") {
    const materialOptions = {
      config,
      input: requiredStringArg(args, "input", "input"),
      attachTo: stringArg(args, "attachTo"),
      providerId: stringArg(args, "providerId"),
      policy: stringArg(args, "policy"),
    };
    return dryRun
      ? planMaterialExtraction(materialOptions)
      : runMaterialExtraction(materialOptions);
  }

  const materialOptions = {
    config,
    input: requiredStringArg(args, "input", "input"),
    attachTo: stringArg(args, "attachTo"),
    artifactProviderId: stringArg(args, "artifactProviderId"),
    extractProviderId: stringArg(args, "extractProviderId"),
    policy: stringArg(args, "policy"),
  };
  return dryRun
    ? planMaterialIngest(materialOptions)
    : runMaterialIngest(materialOptions);
}

function envelopeBatchResult(
  task: BatchTask,
  envelope: ResultEnvelope,
  includeRaw: boolean,
): BatchResult {
  return cleanResult({
    index: task.index,
    id: task.id,
    status: envelope.ok ? "ok" : "error",
    ok: envelope.ok,
    capability: envelope.capability,
    tool: envelope.tool,
    data: envelope.data,
    planned: envelope.planned,
    state: envelope.state,
    actions: envelope.actions,
    diagnostics: envelope.diagnostics,
    warnings: envelope.warnings,
    errors: envelope.errors,
    provenance: envelope.provenance,
    raw: includeRaw ? envelope : undefined,
    error: envelope.ok ? undefined : envelope.errors?.join("; ") || `${task.tool} failed.`,
  });
}

function materialFailureEnvelope(tool: BatchMaterialTool, error: unknown): ResultEnvelope<null> {
  return failEnvelope({
    capability: materialToolCapability(tool),
    tool,
    errors: [error instanceof Error ? error.message : String(error)],
    ...(error instanceof AcquireResolverError && error.actions.length > 0
      ? { state: "action_required", actions: error.actions }
      : {}),
  });
}

function materialToolCapability(tool: BatchMaterialTool): "acquire" | "extract" | "orchestrate" {
  if (tool === "artifact_download") return "acquire";
  if (tool === "extract") return "extract";
  return "orchestrate";
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function requiredStringArg(args: Record<string, unknown>, key: string, label: string): string {
  const value = stringArg(args, key);
  if (!value) throw new Error(`Batch row is missing required ${label}.`);
  return value;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

async function executeDirectAdd(
  config: ResolvedConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tags = Array.isArray(args.tags)
    ? args.tags.map((tag) => String(tag))
    : parseTags(typeof args.tags === "string" ? args.tags : undefined);
  const selected = await selectResourceIntoWorkspace(config, {
    item: isRecord(args.item) ? (args.item as unknown as ResourceItem) : undefined,
    detail: isRecord(args.detail) ? (args.detail as WorkspaceDetailPayload) : undefined,
    url: typeof args.url === "string" ? args.url : undefined,
    title: typeof args.title === "string" ? args.title : undefined,
    collectionKey: typeof args.collectionKey === "string" ? args.collectionKey : undefined,
    collectionPath: typeof args.collectionPath === "string" ? args.collectionPath : undefined,
    tags,
    fetchPdf: args.fetchPDF === true || args.fetchPdf === true,
    defaultCollectionPath: config.workspace.defaultCollection,
  });
  return cleanObject({
    ...selected.workspace,
    zoteroSync: selected.zoteroSync.status === "not_requested" ? undefined : selected.zoteroSync.status,
  });
}

function mergeDirectAddArgs(task: BatchTask): Record<string, unknown> {
  const rowCollectionKey =
    typeof task.args.collectionKey === "string" ? task.args.collectionKey : undefined;
  const rowCollectionPath =
    typeof task.args.collectionPath === "string" ? task.args.collectionPath : undefined;
  const tags = mergeUnique([
    ...extractTagValues(task.addArgs.tags),
    ...extractTagValues(task.args.tags),
  ]);

  return cleanObject({
    ...task.addArgs,
    ...task.args,
    collectionKey:
      rowCollectionKey ??
      (typeof task.addArgs.collectionKey === "string" ? task.addArgs.collectionKey : undefined),
    collectionPath:
      rowCollectionPath ??
      (typeof task.addArgs.collectionPath === "string" ? task.addArgs.collectionPath : undefined),
    tags,
    fetchPdf:
      task.args.fetchPdf === true ||
      task.args.fetchPDF === true ||
      task.addArgs.fetchPdf === true ||
      task.addArgs.fetchPDF === true,
  });
}

async function executeSelectedAdd(
  config: ResolvedConfig,
  task: BatchTask,
  rawResult: unknown,
  selected: unknown,
): Promise<unknown> {
  if (task.tool === "patent_detail" && isPatentDetailResult(rawResult)) {
    return executeDirectAdd(config, {
      ...task.addArgs,
      item: rawResult.item,
      detail: rawResult.detail,
    });
  }
  if (task.tool === "resource_lookup") {
    if (isLookupStyleResult(rawResult) && isRecord(rawResult.item)) {
      return executeDirectAdd(config, {
        ...task.addArgs,
        item: rawResult.item,
        url: typeof rawResult.url === "string" ? rawResult.url : undefined,
      });
    }
    if (isRecord(selected)) {
      return executeDirectAdd(config, {
        ...task.addArgs,
        item: selected,
      });
    }
    if (typeof selected === "string" && /^https?:\/\//iu.test(selected)) {
      return executeDirectAdd(config, {
        ...task.addArgs,
        url: selected,
      });
    }
  }
  if (isRecord(selected)) {
    return executeDirectAdd(config, {
      ...task.addArgs,
      item: selected,
    });
  }
  if (typeof selected === "string" && /^https?:\/\//iu.test(selected)) {
    return executeDirectAdd(config, {
      ...task.addArgs,
      url: selected,
    });
  }
  throw new Error(`Unsupported add candidate for ${task.tool}`);
}

function normalizeRow(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Each batch row must be an object.");
  }
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).map(([key, value]) => [
      key,
      normalizeRowValue(value),
    ]),
  );
}

function normalizeRowValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function skippedTask(index: number, id: string, raw: Record<string, string>, reason: string): BatchTask {
  return {
    index,
    id,
    raw,
    tool: "resource_add",
    args: {},
    addMode: "none",
    addArgs: {},
    fetchPdf: false,
    tags: [],
    skipReason: reason,
  };
}

function buildToolArgs(
  tool: BatchTask["tool"],
  row: Record<string, string>,
  defaults: BatchDefaults,
): Record<string, unknown> {
  if (tool === "academic_search") {
    return cleanObject({
      query: requiredField(row, ["query", "title", "search"], "query"),
      platform: pick(row, ["platform", "provider_or_platform", "provider"]) || defaults.defaultPlatform,
      maxResults: parseNumber(pick(row, ["max_results", "maxResults"]), defaults.maxResults),
      page: parseNumber(pick(row, ["page"])),
      year: pick(row, ["year", "year_filter"]),
      author: pick(row, ["author"]),
      sortBy: pick(row, ["sort_by", "sortBy"]),
      extra: parseStructuredValue(pick(row, ["extra", "extra_json"])),
    });
  }

  if (tool === "patent_search") {
    return cleanObject({
      query: requiredField(row, ["query", "title", "search"], "query"),
      platform: pick(row, ["platform", "provider_or_platform", "provider"]) || defaults.defaultPlatform,
      maxResults: parseNumber(pick(row, ["max_results", "maxResults"]), defaults.maxResults),
      page: parseNumber(pick(row, ["page"])),
      sortBy: pick(row, ["sort_by", "sortBy"]),
      patentType: pick(row, ["patent_type", "patentType"]),
      legalStatus: pick(row, ["legal_status", "legalStatus"]),
      database: pick(row, ["database"]),
      sortField: pick(row, ["sort_field", "sortField"]),
      sortOrder: pick(row, ["sort_order", "sortOrder"]),
      queryMode: pick(row, ["query_mode", "queryMode"]),
      rawQuery: pick(row, ["raw_query", "rawQuery"]),
      extra: parseStructuredValue(pick(row, ["extra", "extra_json"])),
    });
  }

  if (tool === "patent_detail") {
    return cleanObject({
      platform: requiredField(row, ["platform", "provider_or_platform", "provider"], "platform"),
      sourceId: requiredField(row, ["source_id", "sourceId", "ane", "identifier"], "sourceId"),
      include: splitCsv(pick(row, ["include", "sections"])),
    });
  }

  if (tool === "web_search") {
    return cleanObject({
      query: requiredField(row, ["query", "title", "search"], "query"),
      mode: pick(row, ["mode"]),
      intent: pick(row, ["intent"]),
      freshness: pick(row, ["freshness"]),
      maxResults: parseNumber(pick(row, ["max_results", "maxResults"]), defaults.maxResults),
    });
  }

  if (tool === "resource_lookup") {
    const value = requiredField(row, ["identifier", "doi", "pmid", "arxiv", "isbn", "url", "query"], "identifier/url");
    const isUrl = /^https?:\/\//iu.test(value);
    const inferredType =
      pick(row, ["identifier_type", "identifierType", "type"]) || inferIdentifierType(row);
    return cleanObject({
      identifier: isUrl ? undefined : value,
      identifierType: isUrl ? undefined : inferredType,
      url: isUrl ? value : undefined,
      provider: pick(row, ["provider"]),
      formats: splitCsv(pick(row, ["formats"])),
    });
  }

  if (tool === "resource_add") {
    return cleanObject({
      item: parseStructuredValue(pick(row, ["item", "item_json"])),
      detail: parseStructuredValue(pick(row, ["detail", "detail_json"])),
      url: pick(row, ["url"]),
      title: pick(row, ["title"]),
      collectionKey: pick(row, ["collection_key", "collectionKey"]),
      collectionPath: pick(row, ["collection_path", "collectionPath"]),
      tags: parseTags(pick(row, ["tags", "tag"])),
      fetchPDF: parseBoolean(pick(row, ["fetch_pdf", "fetchPDF"]), defaults.fetchPdf),
    });
  }

  if (tool === "resource_pdf") {
    return cleanObject({
      itemKey: requiredField(row, ["item_key", "itemKey", "record_id", "recordId", "key"], "itemKey"),
      url: pick(row, ["url", "pdf_url", "pdfUrl"]),
      filename: pick(row, ["filename", "file_name", "fileName"]),
      download: parseOptionalBoolean(pick(row, ["download"])),
      providerId: pick(row, ["provider", "provider_id", "providerId"]),
      resolverProviderId: pick(row, ["resolver", "resolver_id", "resolverId"]),
      policy: pick(row, ["policy"]),
      dryRun: parseOptionalBoolean(pick(row, ["dry_run", "dryRun", "plan"])),
    });
  }

  if (tool === "artifact_download") {
    return cleanObject({
      input: requiredField(
        row,
        ["input", "material_input", "materialInput", "artifact_input", "artifactInput", "source", "url", "item_key", "itemKey", "record_id", "recordId", "key"],
        "input",
      ),
      attachTo: pick(row, ["attach_to", "attachTo"]),
      providerId: pick(row, ["provider", "provider_id", "providerId", "artifact_provider", "artifactProvider", "downloader_provider", "downloaderProvider"]),
      policy: pick(row, ["policy"]),
      download: parseArtifactDownloadFlag(row),
      dryRun: parseOptionalBoolean(pick(row, ["dry_run", "dryRun", "plan"])),
    });
  }

  if (tool === "extract") {
    return cleanObject({
      input: requiredField(
        row,
        ["input", "material_input", "materialInput", "source", "artifact_id", "artifactId", "path", "url"],
        "input",
      ),
      attachTo: pick(row, ["attach_to", "attachTo"]),
      providerId: pick(row, ["provider", "provider_id", "providerId", "extract_provider", "extractProvider"]),
      policy: pick(row, ["policy"]),
      dryRun: parseOptionalBoolean(pick(row, ["dry_run", "dryRun", "plan"])),
    });
  }

  if (tool === "material_ingest") {
    return cleanObject({
      input: requiredField(
        row,
        ["input", "material_input", "materialInput", "source", "path", "url", "item_key", "itemKey", "item_id", "itemId", "record_id", "recordId", "key"],
        "input",
      ),
      attachTo: pick(row, ["attach_to", "attachTo"]),
      artifactProviderId: pick(row, ["artifact_provider", "artifactProvider", "artifact_provider_id", "artifactProviderId", "downloader_provider", "downloaderProvider"]),
      extractProviderId: pick(row, ["extract_provider", "extractProvider", "extract_provider_id", "extractProviderId", "provider", "provider_id", "providerId"]),
      policy: pick(row, ["policy"]),
      dryRun: parseOptionalBoolean(pick(row, ["dry_run", "dryRun", "plan"])),
    });
  }

  if (tool === "citation_expand") {
    const canonical = parseCanonicalBatchArgs(row);
    const explicitSeeds = parseStructuredValue(pick(row, ["seeds", "seeds_json"]));
    const convenienceSeeds = ([
      ["doi", pick(row, ["doi", "dois"])],
      ["pmid", pick(row, ["pmid", "pmids"])],
      ["arxiv", pick(row, ["arxiv", "arxiv_ids"])],
      ["semantic", pick(row, ["semantic", "semantic_ids"])],
      ["openalex", pick(row, ["openalex", "openalex_ids"])],
      ["scopus", pick(row, ["scopus", "scopus_ids"])],
    ] as const).flatMap(([kind, value]) =>
      splitCsv(value).map((identifier) => ({ identifiers: { [kind]: identifier } })),
    );
    const explicitLimits = parseStructuredValue(pick(row, ["limits", "limits_json"]));
    const columnLimits = cleanObject({
      depth: parseNumber(pick(row, ["depth"])),
      perNode: parseNumber(pick(row, ["per_node", "perNode"])),
      nodes: parseNumber(pick(row, ["max_nodes", "nodes"])),
      edges: parseNumber(pick(row, ["max_edges", "edges"])),
      providerPages: parseNumber(pick(row, ["max_pages", "provider_pages", "providerPages"])),
      concurrency: parseNumber(pick(row, ["citation_concurrency", "concurrency"])),
    });
    const explicit = cleanObject({
      mode: pick(row, ["mode"]),
      runId: pick(row, ["run_id", "runId"]),
      seeds: explicitSeeds ?? (convenienceSeeds.length > 0 ? convenienceSeeds : undefined),
      directions: splitCsv(pick(row, ["directions", "direction"])),
      providers: splitCsv(pick(row, ["providers", "provider"])),
      excludeIdentifiers: parseStructuredValue(
        pick(row, ["exclude_identifiers", "excludeIdentifiers", "exclude_identifiers_json"]),
      ),
      limits: explicitLimits ?? (Object.keys(columnLimits).length > 0 ? columnLimits : undefined),
    });
    return cleanObject({ ...canonical, ...explicit });
  }

  if (tool === "assessment_run") {
    const canonical = parseCanonicalBatchArgs(row);
    const explicit = cleanObject({
      mode: pick(row, ["mode"]),
      snapshotPath: pick(row, ["snapshot_path", "snapshotPath", "snapshot"]),
      snapshotSha256: pick(row, ["snapshot_sha256", "snapshotSha256", "sha256"]),
      policy: parseStructuredValue(pick(row, ["policy", "policy_json"])),
    });
    return cleanObject({ ...canonical, ...explicit });
  }

  throw new Error(`Unsupported batch tool: ${tool}`);
}

function normalizeTool(row: Record<string, string>): BatchTask["tool"] {
  const raw = (pick(row, ["tool", "action", "type"]) || "").trim().toLowerCase();
  if (!raw) {
    if (pick(row, ["source_id", "sourceId", "ane"])) return "patent_detail";
    if (pick(row, ["mode", "intent", "freshness"])) return "web_search";
    if (pick(row, ["item_key", "itemKey", "record_id", "recordId"])) return "resource_pdf";
    if (pick(row, ["doi", "pmid", "arxiv", "isbn", "identifier", "url"])) return "resource_lookup";
    if (pick(row, ["item", "item_json", "detail", "detail_json"])) return "resource_add";
    return "academic_search";
  }
  const normalized = raw.replace(/[-\s]/gu, "_");
  const aliases: Record<string, BatchTask["tool"]> = {
    academic: "academic_search",
    paper: "academic_search",
    papers: "academic_search",
    patent: "patent_search",
    patents: "patent_search",
    patent_detail: "patent_detail",
    detail: "patent_detail",
    web: "web_search",
    web_search: "web_search",
    lookup: "resource_lookup",
    add: "resource_add",
    save: "resource_add",
    pdf: "resource_pdf",
    artifact: "artifact_download",
    artifact_download: "artifact_download",
    download_artifact: "artifact_download",
    extract: "extract",
    material_extract: "extract",
    ingest: "material_ingest",
    material_ingest: "material_ingest",
    citation: "citation_expand",
    citations: "citation_expand",
    citation_expand: "citation_expand",
    assess: "assessment_run",
    assessment: "assessment_run",
    assessment_run: "assessment_run",
    academic_search: "academic_search",
    patent_search: "patent_search",
    resource_lookup: "resource_lookup",
    resource_add: "resource_add",
    resource_pdf: "resource_pdf",
  };
  const tool = aliases[normalized];
  if (!tool) {
    throw new Error(`Unsupported batch tool: ${raw}`);
  }
  return tool;
}

function resolveAddMode(
  row: Record<string, string>,
  defaultMode: BatchAddMode,
): Exclude<BatchAddMode, "row"> {
  if (defaultMode !== "row") return defaultMode;
  const policy = (pick(row, ["save_policy", "savePolicy", "add_mode", "addMode"]) || "").toLowerCase();
  if (/screen|review|manual|none|no\s+add|before\s+add/u.test(policy)) return "none";
  if (/first|import|save|auto\s*add|add\s*first/u.test(policy)) return "first";
  return "none";
}

function resolveCollectionTarget(
  row: Record<string, string>,
  defaults: BatchDefaults,
): CollectionTarget {
  const explicitKey = pick(row, ["collection_key", "collectionKey"]);
  if (explicitKey) return { collectionKey: explicitKey };

  const label = pick(row, ["target_collection", "collection", "collection_path", "collectionPath"]);
  if (label) {
    const mapped = defaults.collectionMap[label] ?? defaults.collectionMap[label.toLowerCase()];
    if (mapped) {
      return looksLikeCollectionKey(mapped) ? { collectionKey: mapped } : { collectionPath: mapped };
    }
    if (label.includes("/") || label.includes("\\")) {
      return { collectionPath: label.replaceAll("\\", "/") };
    }
  }

  if (defaults.collectionKey) return { collectionKey: defaults.collectionKey };
  if (defaults.collectionPath) return { collectionPath: defaults.collectionPath };
  if (label) return { collectionPath: label };
  return {};
}

function selectAddCandidate(tool: BatchTask["tool"], result: unknown, candidates: unknown[]): unknown | undefined {
  if (tool === "resource_lookup" && isLookupStyleResult(result) && isRecord(result.item)) {
    return result.item;
  }
  if (tool === "patent_detail" && isPatentDetailResult(result)) {
    return result.item;
  }
  return candidates[0];
}

function isLookupStyleResult(
  value: unknown,
): value is { item: ResourceItem; url?: string } {
  return isRecord(value) && isRecord(value.item) && looksLikeResource(value.item as Record<string, unknown>);
}

function isPatentDetailResult(value: unknown): value is PatentDetailResult {
  return isRecord(value) && isRecord(value.item) && isRecord(value.detail);
}

export function extractCandidates(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!isRecord(result)) return [];
  if (looksLikeResource(result)) return [result];
  if (isLookupStyleResult(result)) return [result.item];
  if (isPatentDetailResult(result)) return [result.item];

  for (const key of ["results", "items", "data", "papers", "resources", "records", "patents"]) {
    const value = result[key];
    if (Array.isArray(value)) return flattenCandidateArray(value);
    if (isRecord(value)) {
      const nested = Object.values(value).flatMap((candidate) =>
        Array.isArray(candidate) ? flattenCandidateArray(candidate) : [],
      );
      if (nested.length > 0) return nested;
    }
  }

  return [];
}

function flattenCandidateArray(values: unknown[]): unknown[] {
  return values.flatMap((value) => {
    if (isRecord(value) && Array.isArray(value.items)) return value.items;
    return [value];
  });
}

export function summarizeCandidate(candidate: unknown): Record<string, unknown> {
  if (!isRecord(candidate)) return { value: String(candidate) };
  return cleanObject({
    title: candidate.title ?? candidate.name,
    doi: candidate.doi ?? candidate.DOI,
    url: candidate.url ?? candidate.URL,
    year: candidate.year ?? candidate.date ?? candidate.publicationYear,
    source: candidate.source ?? candidate.provider ?? candidate.platform,
    authors: candidate.authors ?? candidate.creators,
    sourceId: candidate.sourceId,
  });
}

function pick(row: Record<string, string>, names: string[]): string | undefined {
  const normalized = new Map(
    Object.entries(row).map(([key, value]) => [normalizeKey(key), value]),
  );
  for (const name of names) {
    const value = row[name] ?? normalized.get(normalizeKey(name));
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return undefined;
}

function requiredField(row: Record<string, string>, names: string[], label: string): string {
  const value = pick(row, names);
  if (!value) throw new Error(`Batch row is missing required ${label}.`);
  return value;
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-\s]+/gu, "_");
}

function parseNumber(value: string | undefined, fallback?: number): number | undefined {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected numeric batch value, got: ${value}`);
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (/^(1|true|yes|y)$/iu.test(value)) return true;
  if (/^(0|false|no|n)$/iu.test(value)) return false;
  throw new Error(`Expected boolean batch value, got: ${value}`);
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  return parseBoolean(value, false);
}

function parseArtifactDownloadFlag(row: Record<string, string>): boolean | undefined {
  const noDownload = parseOptionalBoolean(pick(row, ["no_download", "noDownload"]));
  if (noDownload !== undefined) return !noDownload;
  return parseOptionalBoolean(pick(row, ["download"]));
}

function parseTags(value: string | undefined): string[] {
  return splitCsv(value);
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseStructuredValue(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return YAML.parse(value);
  }
}

function parseCanonicalBatchArgs(row: Record<string, string>): Record<string, unknown> {
  const parsed = parseStructuredValue(pick(row, ["args", "args_json", "arguments", "arguments_json"]));
  if (parsed === undefined) return {};
  if (!isRecord(parsed)) throw new Error("Batch canonical args must be a JSON/YAML object.");
  return parsed;
}

function inferIdentifierType(row: Record<string, string>): string | undefined {
  if (pick(row, ["doi"])) return "doi";
  if (pick(row, ["pmid"])) return "pmid";
  if (pick(row, ["arxiv"])) return "arxiv";
  if (pick(row, ["isbn"])) return "isbn";
  return undefined;
}

function mergeUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractTagValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return parseTags(value);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeResource(value: Record<string, unknown>): boolean {
  return Boolean(value.title || value.doi || value.url || value.DOI || value.URL);
}

function looksLikeCollectionKey(value: string): boolean {
  return /^[A-Z0-9]{8}$/u.test(value);
}

function cleanObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item === undefined || item === null) return false;
      if (typeof item === "string") return item.trim().length > 0;
      if (Array.isArray(item)) return item.length > 0;
      if (isRecord(item)) return Object.keys(item).length > 0;
      return true;
    }),
  ) as T;
}

function cleanResult(result: BatchResult): BatchResult {
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  ) as BatchResult;
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

export async function writeBatchOutput(filePath: string | undefined, text: string): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
  return filePath;
}
