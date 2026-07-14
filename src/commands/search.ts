import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import { runAcademicSearch } from "../search/academic.js";
import { runPatentDetail, runPatentSearch } from "../search/patent.js";
import type { Io } from "../runtime/io.js";
import { okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import type { PatentDetailResult } from "../providers/sdk/types.js";
import { buildSearchEnvelope } from "../surface/searchEnvelope.js";

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
    .map((entry) => entry.trim())
    .filter(Boolean);
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

export function registerSearchCommands(program: Command, io: Io): void {
  program
    .command("academic <query>")
    .alias("academic-search")
    .alias("academic_search")
    .description("Search installed academic providers through the local provider-compatible runtime.")
    .option("--platform <id>", 'provider id, or "all" (default: all)')
    .option("--provider <id>", "alias of --platform")
    .option("--max-results <n>", "maximum results per provider", parseIntegerOption)
    .option("--page <n>", "page number", parseIntegerOption)
    .option("--year <value>", "year or year range, e.g. 2020-2024")
    .option("--author <value>", "author filter")
    .option("--sort-by <value>", "relevance, date, or citations")
    .option("--extra <json>", "provider-specific extra JSON object")
    .action(async (query: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const extra =
        typeof options.extra === "string" && options.extra.trim()
          ? (JSON.parse(options.extra) as Record<string, unknown>)
          : undefined;
      const result = await runAcademicSearch(config, {
        query,
        platform:
          (typeof options.platform === "string" && options.platform) ||
          (typeof options.provider === "string" && options.provider) ||
          "all",
        maxResults: typeof options.maxResults === "number" ? options.maxResults : undefined,
        page: typeof options.page === "number" ? options.page : undefined,
        year: typeof options.year === "string" ? options.year : undefined,
        author: typeof options.author === "string" ? options.author : undefined,
        sortBy:
          options.sortBy === "relevance" || options.sortBy === "date" || options.sortBy === "citations"
            ? options.sortBy
            : undefined,
        extra,
      });
      io.writeJson(buildSearchEnvelope("academic_search", result));
    });

  program
    .command("patent <query>")
    .alias("patent-search")
    .alias("patent_search")
    .description("Search installed patent providers through the local provider-compatible runtime.")
    .option("--platform <id>", 'provider id, or "all" (default: all)')
    .option("--provider <id>", "alias of --platform")
    .option("--max-results <n>", "maximum results per provider", parseIntegerOption)
    .option("--page <n>", "page number", parseIntegerOption)
    .option("--sort-by <value>", "relevance or date")
    .option("--patent-type <value>", "all, invention, utility_model, or design")
    .option("--legal-status <value>", "all, valid, invalid, or pending")
    .option("--database <value>", "CN or WD")
    .option("--sort-field <value>", "applicationDate or publicationDate")
    .option("--sort-order <value>", "asc or desc")
    .option("--query-mode <value>", "simple or expert")
    .option("--raw-query <value>", "provider-native expert query")
    .option("--extra <json>", "provider-specific extra JSON object")
    .action(async (query: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const extra =
        typeof options.extra === "string" && options.extra.trim()
          ? (JSON.parse(options.extra) as Record<string, unknown>)
          : undefined;
      const result = await runPatentSearch(config, {
        query,
        platform:
          (typeof options.platform === "string" && options.platform) ||
          (typeof options.provider === "string" && options.provider) ||
          "all",
        maxResults: typeof options.maxResults === "number" ? options.maxResults : undefined,
        page: typeof options.page === "number" ? options.page : undefined,
        sortBy: options.sortBy === "relevance" || options.sortBy === "date" ? options.sortBy : undefined,
        patentType: typeof options.patentType === "string" ? options.patentType : undefined,
        legalStatus: typeof options.legalStatus === "string" ? options.legalStatus : undefined,
        database: typeof options.database === "string" ? options.database : undefined,
        sortField: typeof options.sortField === "string" ? options.sortField : undefined,
        sortOrder: typeof options.sortOrder === "string" ? options.sortOrder : undefined,
        queryMode: typeof options.queryMode === "string" ? options.queryMode : undefined,
        rawQuery: typeof options.rawQuery === "string" ? options.rawQuery : undefined,
        extra,
      });
      io.writeJson(buildSearchEnvelope("patent_search", result));
    });

  program
    .command("patent-detail <platform> <source-id>")
    .alias("patent_detail")
    .description("Fetch detailed patent data by provider-native patent id.")
    .option(
      "--include <csv>",
      "detail sections to include: core, legalStatus, claims, description, pdf, images",
    )
    .action(async (platform: string, sourceId: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const result = await runPatentDetail(config, {
        platform,
        sourceId,
        include: splitCsv(typeof options.include === "string" ? options.include : undefined),
      });
      io.writeJson(patentDetailEnvelope(result));
    });
}
