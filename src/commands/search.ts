import { InvalidArgumentError, type Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { Io } from "../runtime/io.js";
import { okEnvelope } from "../surface/resultEnvelope.js";
import { runCanonicalTool } from "../surface/toolRunner.js";
import { createProviderSelectionPlan } from "../search/runtime.js";
import type { ProviderSelectionRequest } from "../search/selection.js";
import { acceptAlwaysJsonFlag } from "./alwaysJson.js";
import { cliHistoryOptions, compactCanonicalArguments } from "./history.js";

function parseIntegerOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function parseChoice<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (allowed.includes(value as T)) return value as T;
  throw new InvalidArgumentError(`${label} must be one of: ${allowed.join(", ")}`);
}

const parseAcademicSort = (value: string) =>
  parseChoice(value, ["relevance", "date", "citations"] as const, "academic sort");
const parsePatentSort = (value: string) =>
  parseChoice(value, ["relevance", "date"] as const, "patent sort");

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function collectRepeatable(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function stringArrayOption(options: Record<string, unknown>, key: string): string[] | undefined {
  const value = options[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function selectionRequestFromOptions(options: Record<string, unknown>): ProviderSelectionRequest {
  return {
    platform: typeof options.platform === "string" ? options.platform : undefined,
    provider: typeof options.provider === "string" ? options.provider : undefined,
    presets: stringArrayOption(options, "preset"),
    sources: stringArrayOption(options, "source"),
    categories: stringArrayOption(options, "category"),
    excludeSources: stringArrayOption(options, "excludeSource"),
    excludeCategories: stringArrayOption(options, "excludeCategory"),
  };
}

function addSelectionOptions(command: Command): Command {
  return command
    .option("--platform <id>", 'legacy singular provider id, or literal "all"')
    .option("--provider <id>", "alias of --platform")
    .option("--preset <name>", "named source preset; repeat to union presets", collectRepeatable)
    .option("--source <id>", "provider id or alias; repeat to union sources", collectRepeatable)
    .option(
      "--category <selector>",
      "classification selector such as domain:biomedicine; repeat to union",
      collectRepeatable,
    )
    .option(
      "--exclude-source <id>",
      "provider id or alias to remove after the union; repeatable",
      collectRepeatable,
    )
    .option(
      "--exclude-category <selector>",
      "classification selector to remove before exact source inclusion; repeatable",
      collectRepeatable,
    );
}

export function registerSearchCommands(program: Command, io: Io): void {
  addSelectionOptions(acceptAlwaysJsonFlag(program
    .command("academic <query>")
    .alias("academic-search")
    .alias("academic_search")
    .description("Search installed academic providers through the local provider-compatible runtime.")))
    .option("--max-results <n>", "results per provider; 0 uses config, -1 uses the provider limit", parseIntegerOption)
    .option("--page <n>", "provider page number (default: 1)", parseIntegerOption)
    .option("--year <value>", "year or year range, e.g. 2020-2024")
    .option("--author <value>", "author filter")
    .option("--sort-by <value>", "relevance, date, or citations (date/citations are descending)", parseAcademicSort)
    .option("--extra <json>", "provider-specific extra JSON object; prefer one exact source")
    .option("--no-history", "run this search without writing a durable history record")
    .action(async (query: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const extra =
        typeof options.extra === "string" && options.extra.trim()
          ? (JSON.parse(options.extra) as Record<string, unknown>)
          : undefined;
      const args = compactCanonicalArguments({
        query,
        ...selectionRequestFromOptions(options),
        maxResults: typeof options.maxResults === "number" ? options.maxResults : undefined,
        page: typeof options.page === "number" ? options.page : undefined,
        year: typeof options.year === "string" ? options.year : undefined,
        author: typeof options.author === "string" ? options.author : undefined,
        sortBy: typeof options.sortBy === "string" ? options.sortBy : undefined,
        extra,
      });
      io.writeJson(await runCanonicalTool(
        config,
        "academic_search",
        args,
        cliHistoryOptions(options),
      ));
    });

  addSelectionOptions(acceptAlwaysJsonFlag(program
    .command("patent <query>")
    .alias("patent-search")
    .alias("patent_search")
    .description("Search installed patent providers through the local provider-compatible runtime.")))
    .option("--max-results <n>", "results per provider; 0 uses config, -1 uses the provider limit", parseIntegerOption)
    .option("--page <n>", "provider page number (default: 1)", parseIntegerOption)
    .option("--sort-by <value>", "relevance or date (date is descending)", parsePatentSort)
    .option("--patent-type <value>", "all, invention, utility_model, or design")
    .option("--legal-status <value>", "all, valid, invalid, or pending")
    .option("--database <value>", "CN or WD")
    .option("--sort-field <value>", "applicationDate or publicationDate")
    .option("--sort-order <value>", "asc or desc")
    .option("--query-mode <value>", "simple or expert")
    .option("--raw-query <value>", "provider-native expert query")
    .option("--extra <json>", "provider-specific extra JSON object")
    .option("--no-history", "run this search without writing a durable history record")
    .action(async (query: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const extra =
        typeof options.extra === "string" && options.extra.trim()
          ? (JSON.parse(options.extra) as Record<string, unknown>)
          : undefined;
      const args = compactCanonicalArguments({
        query,
        ...selectionRequestFromOptions(options),
        maxResults: typeof options.maxResults === "number" ? options.maxResults : undefined,
        page: typeof options.page === "number" ? options.page : undefined,
        sortBy: typeof options.sortBy === "string" ? options.sortBy : undefined,
        patentType: typeof options.patentType === "string" ? options.patentType : undefined,
        legalStatus: typeof options.legalStatus === "string" ? options.legalStatus : undefined,
        database: typeof options.database === "string" ? options.database : undefined,
        sortField: typeof options.sortField === "string" ? options.sortField : undefined,
        sortOrder: typeof options.sortOrder === "string" ? options.sortOrder : undefined,
        queryMode: typeof options.queryMode === "string" ? options.queryMode : undefined,
        rawQuery: typeof options.rawQuery === "string" ? options.rawQuery : undefined,
        extra,
      });
      io.writeJson(await runCanonicalTool(
        config,
        "patent_search",
        args,
        cliHistoryOptions(options),
      ));
    });

  addSelectionOptions(acceptAlwaysJsonFlag(program
    .command("search-plan")
    .alias("search-selection-plan")
    .description("Explain source preset expansion, exclusions, and runtime readiness without searching.")))
    .option("--type <type>", "academic or patent", "academic")
    .action(async (options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const sourceType = options.type === "patent" ? "patent" : options.type === "academic" ? "academic" : null;
      if (!sourceType) throw new Error(`Invalid search source type: ${String(options.type)}`);
      const plan = await createProviderSelectionPlan(
        config,
        sourceType,
        selectionRequestFromOptions(options),
      );
      io.writeJson(okEnvelope({
        capability: "operate",
        tool: "search_selection_plan",
        data: plan,
        diagnostics: {
          selectedProviders: plan.selectedProviderIds.length,
          runnableProviders: plan.runnableProviderIds.length,
          skippedProviders: plan.skippedProviderIds.length,
        },
        ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
        provenance: { providerIds: plan.selectedProviderIds },
      }));
    });

  acceptAlwaysJsonFlag(program
    .command("patent-detail <platform> <source-id>")
    .alias("patent_detail")
    .description("Fetch detailed patent data by provider-native patent id."))
    .option(
      "--include <csv>",
      "detail sections to include: core, legalStatus, claims, description, pdf, images",
    )
    .option("--no-history", "fetch details without writing a durable history record")
    .action(async (platform: string, sourceId: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      io.writeJson(await runCanonicalTool(config, "patent_detail", compactCanonicalArguments({
        platform,
        sourceId,
        include: splitCsv(typeof options.include === "string" ? options.include : undefined),
      }), cliHistoryOptions(options)));
    });
}
