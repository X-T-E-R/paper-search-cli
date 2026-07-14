import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import {
  ExternalSearchFreshnessSchema,
  ExternalSearchIntentSchema,
  ExternalSearchModeSchema,
  type ExternalSearchFreshness,
  type ExternalSearchIntent,
  type ExternalSearchMode,
} from "../external-search/types.js";
import { runExternalWebSearchEnvelope } from "../external-search/service.js";
import type { Io } from "../runtime/io.js";

function parseIntegerOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--max-results must be a positive integer");
  return parsed;
}

function parseMode(value: unknown): ExternalSearchMode | undefined {
  return typeof value === "string" ? ExternalSearchModeSchema.parse(value) : undefined;
}

function parseIntent(value: unknown): ExternalSearchIntent | undefined {
  return typeof value === "string" ? ExternalSearchIntentSchema.parse(value) : undefined;
}

function parseFreshness(value: unknown): ExternalSearchFreshness | undefined {
  return typeof value === "string" ? ExternalSearchFreshnessSchema.parse(value) : undefined;
}

export function registerWebCommands(program: Command, io: Io): void {
  program
    .command("web <query>")
    .alias("web-search")
    .alias("web_search")
    .description("Run generic web_search through the configured External Search v1 process.")
    .option("--mode <mode>", "auto, fast, deep, or answer")
    .option("--intent <intent>", "factual, status, comparison, tutorial, exploratory, news, or resource")
    .option("--freshness <freshness>", "pd, pw, pm, or py")
    .option("--max-results <n>", "maximum normalized results", parseIntegerOption)
    .action(async (query: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      io.writeJson(await runExternalWebSearchEnvelope(config, {
        query,
        mode: parseMode(options.mode),
        intent: parseIntent(options.intent),
        freshness: parseFreshness(options.freshness),
        maxResults: typeof options.maxResults === "number" ? options.maxResults : undefined,
      }));
    });
}
