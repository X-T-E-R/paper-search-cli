import { appendFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { Io } from "../runtime/io.js";
import {
  buildBatchTasks,
  inferOutputFormat,
  readBatchRows,
  readCollectionMap,
  readCompletedBatchResultIds,
  runBatchTasks,
  serializeBatchResultJsonl,
  serializeBatchResults,
  writeBatchOutput,
  type BatchAddMode,
} from "../batch/core.js";

function parseIntegerOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAddMode(value: string): BatchAddMode {
  if (value === "row" || value === "none" || value === "first") return value;
  throw new Error("--add must be one of: row, none, first");
}

function parseConcurrency(value: number | undefined): number {
  if (value === undefined) return 2;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  return value;
}

export function registerBatchCommands(program: Command, io: Io): void {
  program
    .command("batch <file>")
    .description("Run CSV/JSONL/JSON/YAML batches for local search, lookup, workspace, and material flows.")
    .option("--out <path>", "write results to a file instead of stdout")
    .option("--output-format <format>", "jsonl, json, or csv; inferred from --out when omitted")
    .option("--add <mode>", "row, none, or first", "row")
    .option("--collection-key <key>", "default workspace collection key for add operations")
    .option("--collection-path <path>", "default workspace collection path for add operations")
    .option("--collection-map <json>", "JSON/YAML object or @file mapping target_collection labels to keys/paths")
    .option("--default-platform <id>", "default provider/platform when rows omit platform")
    .option("--max-results <n>", "default search result count", parseIntegerOption)
    .option("--tags <csv>", "extra tags added to every resource-add")
    .option("--skip-status <csv>", "skip rows whose status/state matches any value", "imported,done,complete,completed")
    .option("--limit <n>", "process at most N rows", parseIntegerOption)
    .option("--concurrency <n>", "number of rows to process in parallel", parseIntegerOption, 2)
    .option("--fetch-pdf", "record PDF fetch requests for add operations")
    .option("--include-raw", "include raw tool results in output")
    .option("--dry-run", "only print planned task calls; do not execute local search/add/material logic")
    .option("--fail-fast", "stop scheduling new rows after the first error")
    .option("--resume-from <jsonl>", "skip row ids already completed in a prior JSONL result file")
    .action(async (file: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const addMode = parseAddMode(String(options.add ?? "row"));
      const rows = await readBatchRows(file);
      const limitedRows = typeof options.limit === "number" ? rows.slice(0, options.limit) : rows;
      const collectionMap = await readCollectionMap(
        typeof options.collectionMap === "string" ? options.collectionMap : undefined,
      );
      let tasks = buildBatchTasks(limitedRows, {
        addMode,
        collectionKey: typeof options.collectionKey === "string" ? options.collectionKey : undefined,
        collectionPath: typeof options.collectionPath === "string" ? options.collectionPath : undefined,
        collectionMap,
        defaultPlatform: typeof options.defaultPlatform === "string" ? options.defaultPlatform : undefined,
        extraTags: splitCsv(typeof options.tags === "string" ? options.tags : undefined),
        fetchPdf: options.fetchPdf === true,
        includeRaw: Boolean(options.includeRaw),
        maxResults: typeof options.maxResults === "number" ? options.maxResults : undefined,
        skipStatuses: new Set(
          splitCsv(typeof options.skipStatus === "string" ? options.skipStatus : undefined).map((value) =>
            value.toLowerCase(),
          ),
        ),
      });
      const outputFormat = inferOutputFormat(
        typeof options.out === "string" ? options.out : undefined,
        typeof options.outputFormat === "string" ? options.outputFormat : undefined,
      );

      const resumeFrom = typeof options.resumeFrom === "string" ? options.resumeFrom : undefined;
      if (resumeFrom) {
        const completedIds = await readCompletedBatchResultIds(resumeFrom);
        const before = tasks.length;
        tasks = tasks.filter((task) => !completedIds.has(task.id));
        const skipped = before - tasks.length;
        io.stderr.write(
          `Resuming batch: skipped ${skipped} completed row${skipped === 1 ? "" : "s"} from ${resumeFrom}\n`,
        );
      }

      if (Boolean(options.dryRun)) {
        const text = serializePlannedBatchTasks(tasks, outputFormat);
        if (await writeBatchOutput(typeof options.out === "string" ? options.out : undefined, text)) {
          return;
        }
        io.stdout.write(text);
        return;
      }

      const outPath = typeof options.out === "string" ? options.out : undefined;
      const streamJsonl = Boolean(outPath) && outputFormat === "jsonl";
      const appendResumeJsonl = Boolean(
        streamJsonl &&
          outPath &&
          resumeFrom &&
          path.resolve(outPath) === path.resolve(resumeFrom),
      );
      if (streamJsonl && outPath && !appendResumeJsonl) {
        await writeBatchOutput(outPath, "");
      }

      const results = await runBatchTasks(
        { config },
        tasks,
        {
          concurrency: parseConcurrency(typeof options.concurrency === "number" ? options.concurrency : undefined),
          failFast: Boolean(options.failFast),
          includeRaw: Boolean(options.includeRaw),
          progress: (result) => {
            io.stderr.write(
              `[${result.index + 1}/${tasks.length}] ${result.id} ${result.status}${result.error ? `: ${result.error}` : ""}\n`,
            );
            if (streamJsonl && outPath) {
              appendFileSync(outPath, serializeBatchResultJsonl(result), "utf8");
            }
          },
        },
      );

      if (streamJsonl && outPath) {
        return;
      }
      const text = serializeBatchResults(results, outputFormat);
      if (await writeBatchOutput(outPath, text)) {
        return;
      }
      io.stdout.write(text);
    });
}

function serializePlannedBatchTasks(
  tasks: ReturnType<typeof buildBatchTasks>,
  outputFormat: "json" | "jsonl" | "csv",
): string {
  const payload = tasks.map((task) => ({
    index: task.index,
    id: task.id,
    tool: task.tool,
    args: task.args,
    addMode: task.addMode,
    addArgs: task.addArgs,
    skipReason: task.skipReason,
  }));

  if (outputFormat === "json") {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }
  if (outputFormat === "jsonl") {
    return `${payload.map((item) => JSON.stringify(item)).join("\n")}\n`;
  }

  const columns = ["index", "id", "tool", "addMode", "skipReason", "args", "addArgs"];
  const lines = [
    columns.join(","),
    ...payload.map((item) =>
      columns
        .map((column) => csvEscape(column === "args" || column === "addArgs" ? item[column as "args" | "addArgs"] : item[column as keyof typeof item]))
        .join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function csvEscape(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}
