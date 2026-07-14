import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { Io } from "../runtime/io.js";
import { okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import { runWebResearch, runWebSearch } from "../web/router.js";
import type {
  SearchIntent,
  SearchMode,
  SearchStrategy,
  WebProviderName,
  WebResearchResponse,
  WebSearchResponse,
} from "../web/types.js";

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntegerOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function parseMode(value: unknown): SearchMode | undefined {
  const valid = ["auto", "web", "news", "social", "docs", "research", "github", "pdf"];
  return typeof value === "string" && valid.includes(value) ? value as SearchMode : undefined;
}

function parseIntent(value: unknown): SearchIntent | undefined {
  const valid = ["auto", "factual", "status", "comparison", "tutorial", "exploratory", "news", "resource"];
  return typeof value === "string" && valid.includes(value) ? value as SearchIntent : undefined;
}

function parseStrategy(value: unknown): SearchStrategy | undefined {
  const valid = ["auto", "fast", "balanced", "verify", "deep"];
  return typeof value === "string" && valid.includes(value) ? value as SearchStrategy : undefined;
}

function parseProvider(value: unknown): WebProviderName | undefined {
  const valid = ["auto", "tavily", "firecrawl", "exa", "xai", "mysearch"];
  return typeof value === "string" && valid.includes(value) ? value as WebProviderName : undefined;
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

export function registerWebCommands(program: Command, io: Io): void {
  program
    .command("web <query>")
    .alias("web-search")
    .alias("web_search")
    .description("Run source-compatible web_search through configured web backends.")
    .option("--mode <mode>", "auto, web, news, social, docs, research, github, or pdf")
    .option("--intent <intent>", "auto, factual, status, comparison, tutorial, exploratory, news, or resource")
    .option("--strategy <strategy>", "auto, fast, balanced, verify, or deep")
    .option("--provider <provider>", "auto, tavily, firecrawl, exa, xai, or mysearch")
    .option("--sources <csv>", "search sources, for example web,x")
    .option("--max-results <n>", "maximum results; 0 uses config default", parseIntegerOption)
    .option("--include-content", "request full page content when supported")
    .option("--include-answer", "include provider-generated answer", true)
    .option("--no-include-answer", "do not request provider-generated answer")
    .option("--include-domains <csv>", "only search these domains")
    .option("--exclude-domains <csv>", "exclude these domains")
    .option("--allowed-x-handles <csv>", "allowed X handles for xAI social search")
    .option("--excluded-x-handles <csv>", "excluded X handles for xAI social search")
    .option("--from-date <date>", "start date filter, YYYY-MM-DD")
    .option("--to-date <date>", "end date filter, YYYY-MM-DD")
    .action(async (query: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const result = await runWebSearch(config, {
        query,
        mode: parseMode(options.mode),
        intent: parseIntent(options.intent),
        strategy: parseStrategy(options.strategy),
        provider: parseProvider(options.provider),
        sources: splitCsv(typeof options.sources === "string" ? options.sources : undefined),
        maxResults: typeof options.maxResults === "number" ? options.maxResults : undefined,
        includeContent: options.includeContent === true,
        includeAnswer: options.includeAnswer !== false,
        includeDomains: splitCsv(typeof options.includeDomains === "string" ? options.includeDomains : undefined),
        excludeDomains: splitCsv(typeof options.excludeDomains === "string" ? options.excludeDomains : undefined),
        allowedXHandles: splitCsv(typeof options.allowedXHandles === "string" ? options.allowedXHandles : undefined),
        excludedXHandles: splitCsv(typeof options.excludedXHandles === "string" ? options.excludedXHandles : undefined),
        fromDate: typeof options.fromDate === "string" ? options.fromDate : undefined,
        toDate: typeof options.toDate === "string" ? options.toDate : undefined,
      });
      io.writeJson(webSearchEnvelope(result));
    });

  program
    .command("web-research <query>")
    .alias("web_research")
    .description("Run source-compatible web_research: search, scrape top pages, and optionally query social/X.")
    .option("--web-max-results <n>", "web search result count", parseIntegerOption)
    .option("--social-max-results <n>", "social result count", parseIntegerOption)
    .option("--scrape-top-n <n>", "number of top web results to extract", parseIntegerOption)
    .option("--include-social", "include X/social search when configured", true)
    .option("--no-include-social", "skip X/social search")
    .option("--mode <mode>", "auto, web, news, social, docs, research, github, or pdf")
    .option("--intent <intent>", "auto, factual, status, comparison, tutorial, exploratory, news, or resource")
    .option("--strategy <strategy>", "auto, fast, balanced, verify, or deep")
    .option("--include-domains <csv>", "only search these domains")
    .option("--exclude-domains <csv>", "exclude these domains")
    .option("--allowed-x-handles <csv>", "allowed X handles for xAI social search")
    .option("--excluded-x-handles <csv>", "excluded X handles for xAI social search")
    .option("--from-date <date>", "start date filter, YYYY-MM-DD")
    .option("--to-date <date>", "end date filter, YYYY-MM-DD")
    .action(async (query: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const result = await runWebResearch(config, {
        query,
        webMaxResults: typeof options.webMaxResults === "number" ? options.webMaxResults : undefined,
        socialMaxResults: typeof options.socialMaxResults === "number" ? options.socialMaxResults : undefined,
        scrapeTopN: typeof options.scrapeTopN === "number" ? options.scrapeTopN : undefined,
        includeSocial: options.includeSocial !== false,
        mode: parseMode(options.mode),
        intent: parseIntent(options.intent),
        strategy: parseStrategy(options.strategy),
        includeDomains: splitCsv(typeof options.includeDomains === "string" ? options.includeDomains : undefined),
        excludeDomains: splitCsv(typeof options.excludeDomains === "string" ? options.excludeDomains : undefined),
        allowedXHandles: splitCsv(typeof options.allowedXHandles === "string" ? options.allowedXHandles : undefined),
        excludedXHandles: splitCsv(typeof options.excludedXHandles === "string" ? options.excludedXHandles : undefined),
        fromDate: typeof options.fromDate === "string" ? options.fromDate : undefined,
        toDate: typeof options.toDate === "string" ? options.toDate : undefined,
      });
      io.writeJson(webResearchEnvelope(result));
    });
}
