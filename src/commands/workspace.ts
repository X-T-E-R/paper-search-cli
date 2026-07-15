import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { ResourceItem } from "../providers/sdk/types.js";
import {
  planLocalStorageWrite,
  writeLocalStorageBytes,
} from "../storage/local.js";
import {
  addResourceToWorkspace,
  exportWorkspaceItems,
  listWorkspaceCollections,
  type WorkspaceExportFormat,
  type WorkspaceDetailPayload,
  type WorkspaceCollectionNode,
} from "../workspace/store.js";
import type { Io } from "../runtime/io.js";
import { isResultEnvelope, okEnvelope, type ResultDiagnostics, type ResultEnvelope } from "../surface/resultEnvelope.js";

interface WorkspaceJsonOption {
  json?: boolean;
}

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveExportFormat(value: unknown, outPath: unknown): WorkspaceExportFormat {
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "json" ||
      normalized === "jsonl" ||
      normalized === "csv" ||
      normalized === "bibtex"
    ) {
      return normalized;
    }
    throw new Error("Export format must be one of: json, jsonl, csv, bibtex");
  }
  if (typeof outPath === "string") {
    const extension = path.extname(outPath).toLowerCase();
    if (extension === ".jsonl" || extension === ".ndjson") return "jsonl";
    if (extension === ".csv") return "csv";
    if (extension === ".bib" || extension === ".bibtex") return "bibtex";
  }
  return "json";
}

function exportWritesMachineJsonToStdout(format: WorkspaceExportFormat, outPath?: string): boolean {
  return !outPath && (format === "json" || format === "jsonl");
}

function unwrapEnvelopeData(value: unknown): unknown {
  return isResultEnvelope(value) ? value.data : value;
}

function workspaceEnvelope<T>(
  tool: "resource_add" | "collection_list" | "workspace_export",
  data: T,
  diagnostics: ResultDiagnostics,
): ResultEnvelope<T> {
  return okEnvelope({
    capability: "organize",
    tool,
    data,
    diagnostics,
  });
}

function countCollectionNodes(nodes: Array<{ children?: unknown[] }>): number {
  return nodes.reduce(
    (total, node) =>
      total + 1 + countCollectionNodes(Array.isArray(node.children) ? node.children as Array<{ children?: unknown[] }> : []),
    0,
  );
}

async function parseResourceInput(options: {
  itemJson?: string;
  itemFile?: string;
  index?: number;
}): Promise<ResourceItem | undefined> {
  if (options.itemJson) {
    return JSON.parse(options.itemJson) as ResourceItem;
  }
  if (!options.itemFile) {
    return undefined;
  }
  const raw = await readFile(options.itemFile, "utf8");
  const parsed = unwrapEnvelopeData(JSON.parse(raw) as unknown);
  const index = options.index ?? 0;
  if (Array.isArray(parsed)) {
    return parsed[index] as ResourceItem | undefined;
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown[] }).items)) {
    return (parsed as { items: ResourceItem[] }).items[index];
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "item" in (parsed as Record<string, unknown>) &&
    (parsed as { item?: unknown }).item &&
    typeof (parsed as { item?: unknown }).item === "object" &&
    "title" in ((parsed as { item: Record<string, unknown> }).item) &&
    "itemType" in ((parsed as { item: Record<string, unknown> }).item)
  ) {
    return (parsed as { item: ResourceItem }).item;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "title" in (parsed as Record<string, unknown>) &&
    "itemType" in (parsed as Record<string, unknown>)
  ) {
    return parsed as ResourceItem;
  }
  throw new Error("Unsupported item-file JSON shape");
}

async function parseDetailInput(options: {
  detailJson?: string;
  detailFile?: string;
}): Promise<WorkspaceDetailPayload | undefined> {
  const unwrap = (value: unknown): WorkspaceDetailPayload | undefined => {
    const payload = unwrapEnvelopeData(value);
    if (payload !== value) {
      return unwrap(payload);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return payload as WorkspaceDetailPayload | undefined;
    }
    if ("detail" in (payload as Record<string, unknown>)) {
      return (payload as { detail?: WorkspaceDetailPayload }).detail;
    }
    return payload as WorkspaceDetailPayload;
  };
  if (options.detailJson) {
    return unwrap(JSON.parse(options.detailJson) as unknown);
  }
  if (!options.detailFile) {
    return undefined;
  }
  const raw = await readFile(options.detailFile, "utf8");
  return unwrap(JSON.parse(raw) as unknown);
}

export function registerWorkspaceCommands(program: Command, io: Io): void {
  program
    .command("collection-list")
    .alias("collections")
    .alias("collection_list")
    .description("List local workspace collections for the workspace sink.")
    .option("--flat", "return a flat path list instead of a tree")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: WorkspaceJsonOption & { flat?: boolean }, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const collections = await listWorkspaceCollections(config.workspace.root, {
        defaultCollectionPath: config.workspace.defaultCollection,
        flat: Boolean(options.flat),
      });
      const count = options.flat
        ? collections.length
        : countCollectionNodes(collections as WorkspaceCollectionNode[]);
      const result = {
        workspaceRoot: config.workspace.root,
        format: options.flat ? "flat" : "tree",
        count,
        collections,
      };
      const envelope = workspaceEnvelope("collection_list", result, {
        workspaceRoot: config.workspace.root,
        sourceCounts: { collections: count },
      });
      if (options.json) {
        io.writeJson(envelope);
        return;
      }
      io.writeLine(`workspace root: ${config.workspace.root}`);
      io.writeJson(envelope);
    });

  program
    .command("resource-add")
    .alias("add")
    .alias("resource_add")
    .description("Add an item or URL into the local workspace sink.")
    .option("--item-json <json>", "ResourceItem JSON payload")
    .option("--item-file <path>", "JSON file containing a ResourceItem or search result payload")
    .option("--index <n>", "when using --item-file with arrays/items[], pick this index", (value) =>
      Number.parseInt(value, 10),
    )
    .option("--detail-json <json>", "optional patent detail payload JSON")
    .option("--detail-file <path>", "optional file containing patent detail payload JSON")
    .option("--url <url>", "URL-only capture input")
    .option("--title <title>", "fallback title when using --url without item metadata")
    .option("--collection-key <key>", "existing collection key")
    .option("--collection-path <path>", "collection path using / separators")
    .option("--tags <csv>", "comma-separated tags")
    .option("--fetch-pdf", "record that PDF fetch was requested (default: off)")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const item = await parseResourceInput({
        itemJson: typeof options.itemJson === "string" ? options.itemJson : undefined,
        itemFile: typeof options.itemFile === "string" ? options.itemFile : undefined,
        index: typeof options.index === "number" ? options.index : undefined,
      });
      const detail = await parseDetailInput({
        detailJson: typeof options.detailJson === "string" ? options.detailJson : undefined,
        detailFile: typeof options.detailFile === "string" ? options.detailFile : undefined,
      });
      const result = await addResourceToWorkspace(config.workspace.root, {
        item,
        detail,
        url: typeof options.url === "string" ? options.url : undefined,
        title: typeof options.title === "string" ? options.title : undefined,
        collectionKey:
          typeof options.collectionKey === "string" ? options.collectionKey : undefined,
        collectionPath:
          typeof options.collectionPath === "string" ? options.collectionPath : undefined,
        tags: splitCsv(typeof options.tags === "string" ? options.tags : undefined),
        fetchPdf: options.fetchPdf === true,
        defaultCollectionPath: config.workspace.defaultCollection,
      });
      const envelope = workspaceEnvelope(
        "resource_add",
        result,
        { workspaceRoot: config.workspace.root },
      );
      if (options.json) {
        io.writeJson(envelope);
        return;
      }
      io.writeLine(`stored ${result.record.id} in ${result.collection.path}`);
      io.writeJson(envelope);
    });

  program
    .command("workspace-export")
    .alias("resource-export")
    .alias("resource_export")
    .description("Export local workspace items as JSON, JSONL, CSV, or BibTeX.")
    .option("--format <format>", "json, jsonl, csv, or bibtex; defaults to target extension or json")
    .option("--out <path>", "write export content to an explicit file instead of stdout")
    .option(
      "--store <safe-relative-key>",
      "write through managed local storage below storage.exportRoot",
    )
    .option("--dry-run", "plan a managed --store export without writing files")
    .option("--collection-key <key>", "export only one collection key")
    .option("--collection-path <path>", "export only one collection path")
    .option("--include-children", "include child collection paths when filtering by --collection-path")
    .option("--json", "when a file target is used, emit a machine-readable summary")
    .action(async (options: Record<string, unknown>, command: Command) => {
      const storeKey = typeof options.store === "string" ? options.store : undefined;
      const outPath = typeof options.out === "string" ? options.out : undefined;
      if (storeKey && outPath) {
        throw new Error("--store and --out are mutually exclusive");
      }
      if (options.dryRun === true && !storeKey) {
        throw new Error("--dry-run requires --store");
      }
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const format = resolveExportFormat(options.format, outPath ?? storeKey);
      const result = await exportWorkspaceItems(config.workspace.root, {
        format,
        collectionKey: typeof options.collectionKey === "string" ? options.collectionKey : undefined,
        collectionPath: typeof options.collectionPath === "string" ? options.collectionPath : undefined,
        includeChildren: options.includeChildren === true,
      });
      const stdoutEnvelope = workspaceEnvelope("workspace_export", result, {
        workspaceRoot: config.workspace.root,
        sourceCounts: { items: result.count },
      });

      if (storeKey) {
        if (options.dryRun === true) {
          const planned = await planLocalStorageWrite({
            root: config.storage.exportRoot,
            key: storeKey,
            area: "export",
          });
          const envelope = okEnvelope({
            capability: "organize",
            tool: "workspace_export",
            planned: true,
            data: { ...result, out: planned.path, storage: planned.ref },
            diagnostics: {
              workspaceRoot: config.workspace.root,
              exportRoot: planned.ref.root,
              out: planned.path,
              sourceCounts: { items: result.count },
            },
          });
          if (options.json) {
            io.writeJson(envelope);
            return;
          }
          io.writeLine(
            `would export ${result.count} item(s) to ${planned.path} as ${result.format}`,
          );
          return;
        }

        const stored = await writeLocalStorageBytes({
          root: config.storage.exportRoot,
          key: storeKey,
          area: "export",
          bytes: Buffer.from(result.content, "utf8"),
        });
        const envelope = workspaceEnvelope(
          "workspace_export",
          { ...result, out: stored.path, storage: stored.ref },
          {
            workspaceRoot: config.workspace.root,
            exportRoot: stored.ref.root,
            out: stored.path,
            sourceCounts: { items: result.count },
          },
        );
        if (options.json) {
          io.writeJson(envelope);
          return;
        }
        io.writeLine(`exported ${result.count} item(s) to ${stored.path} as ${result.format}`);
        return;
      }

      if (outPath) {
        const resolvedOut = path.resolve(outPath);
        await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
        await writeFile(outPath, result.content, "utf8");
        const envelope = workspaceEnvelope(
          "workspace_export",
          { ...result, out: resolvedOut },
          {
            workspaceRoot: config.workspace.root,
            out: resolvedOut,
            sourceCounts: { items: result.count },
          },
        );
        if (options.json) {
          io.writeJson(envelope);
          return;
        }
        io.writeLine(`exported ${result.count} item(s) to ${resolvedOut} as ${result.format}`);
        return;
      }

      if (options.json || exportWritesMachineJsonToStdout(format, outPath)) {
        io.writeJson(stdoutEnvelope);
        return;
      }

      io.stdout.write(result.content.endsWith("\n") ? result.content : `${result.content}\n`);
    });
}
