import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { CitationDirection, CitationIdentifierKind } from "../providers/sdk/types.js";
import type { Io } from "../runtime/io.js";
import { runCanonicalTool } from "../surface/toolRunner.js";

interface CitationOptions {
  doi?: string[];
  pmid?: string[];
  arxiv?: string[];
  semantic?: string[];
  openalex?: string[];
  scopus?: string[];
  direction?: string[];
  provider?: string[];
  exclude?: string[];
  depth?: string;
  perNode?: string;
  maxNodes?: string;
  maxEdges?: string;
  maxPages?: string;
  concurrency?: string;
  runId?: string;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function positiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseExcluded(values: readonly string[] | undefined): Array<Record<string, string>> | undefined {
  if (!values || values.length === 0) return undefined;
  const allowed = new Set<CitationIdentifierKind>([
    "doi",
    "pmid",
    "arxiv",
    "semantic",
    "openalex",
    "scopus",
  ]);
  return values.map((entry) => {
    const separator = entry.indexOf(":");
    const kind = entry.slice(0, separator) as CitationIdentifierKind;
    const value = entry.slice(separator + 1).trim();
    if (separator <= 0 || !allowed.has(kind) || !value) {
      throw new Error(`--exclude must use kind:value with an exact citation identifier: ${entry}`);
    }
    return { [kind]: value };
  });
}

function citationArguments(mode: "plan" | "run", options: CitationOptions): Record<string, unknown> {
  const seeds = ([
    ["doi", options.doi],
    ["pmid", options.pmid],
    ["arxiv", options.arxiv],
    ["semantic", options.semantic],
    ["openalex", options.openalex],
    ["scopus", options.scopus],
  ] as const).flatMap(([kind, values]) =>
    (values ?? []).map((value) => ({ identifiers: { [kind]: value } })),
  );
  const directions = options.direction?.map((value) => {
    if (value !== "backward" && value !== "forward") {
      throw new Error("--direction must be backward or forward");
    }
    return value as CitationDirection;
  });
  const limits = {
    depth: nonNegativeInteger(options.depth, "--depth"),
    perNode: positiveInteger(options.perNode, "--per-node"),
    nodes: positiveInteger(options.maxNodes, "--max-nodes"),
    edges: positiveInteger(options.maxEdges, "--max-edges"),
    providerPages: positiveInteger(options.maxPages, "--max-pages"),
    concurrency: positiveInteger(options.concurrency, "--concurrency"),
  };
  return {
    mode,
    ...(options.runId ? { runId: options.runId } : {}),
    seeds,
    ...(directions?.length ? { directions } : {}),
    ...(options.provider?.length ? { providers: options.provider } : {}),
    ...(options.exclude?.length ? { excludeIdentifiers: parseExcluded(options.exclude) } : {}),
    ...(Object.values(limits).some((value) => value !== undefined) ? {
      limits: Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined)),
    } : {}),
  };
}

function addCitationOptions(command: Command, includeRunId: boolean): Command {
  command
    .option("--doi <doi>", "DOI seed; repeat for multiple seeds", collect, [])
    .option("--pmid <pmid>", "PMID seed; repeat for multiple seeds", collect, [])
    .option("--arxiv <id>", "arXiv seed; repeat for multiple seeds", collect, [])
    .option("--semantic <id>", "Semantic Scholar paper id; repeat for multiple seeds", collect, [])
    .option("--openalex <id>", "OpenAlex work id; repeat for multiple seeds", collect, [])
    .option("--scopus <id>", "Scopus EID; repeat for multiple seeds", collect, [])
    .option("--direction <direction>", "backward or forward; repeat for both", collect, [])
    .option("--provider <id>", "graph-capable installed provider id; repeat to union", collect, [])
    .option("--exclude <kind:value>", "exact identifier to exclude; repeat as needed", collect, [])
    .option("--depth <n>", "bounded breadth-first traversal depth")
    .option("--per-node <n>", "maximum relations retained per expanded node")
    .option("--max-nodes <n>", "maximum graph nodes")
    .option("--max-edges <n>", "maximum graph edges")
    .option("--max-pages <n>", "maximum provider pages")
    .option("--concurrency <n>", "maximum concurrent provider pages");
  if (includeRunId) command.option("--run-id <id>", "optional portable run id; generated when omitted");
  return command;
}

export function registerCitationCommands(program: Command, io: Io): void {
  const citation = program
    .command("citation")
    .description("Plan, run, resume, and inspect bounded citation-graph expansion.");

  for (const mode of ["plan", "run"] as const) {
    addCitationOptions(
      citation.command(mode).description(
        mode === "plan"
          ? "Validate providers, exact identifiers, and limits without network or writes."
          : "Create a durable citation run and checkpoint each valid provider page.",
      ),
      mode === "run",
    ).action(async (options: CitationOptions, command: Command) => {
      try {
        const global = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: global.config });
        io.writeJson(await runCanonicalTool(config, "citation_expand", citationArguments(mode, options)));
      } catch (error) {
        io.writeJson({
          ok: false,
          capability: "orchestrate",
          tool: "citation_expand",
          data: null,
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    });
  }

  citation
    .command("resume <run-id>")
    .description("Resume remaining work from a validated citation checkpoint.")
    .action(async (runId: string, _options: unknown, command: Command) => {
      const global = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: global.config });
      io.writeJson(await runCanonicalTool(config, "citation_expand", { mode: "resume", runId }));
    });

  citation
    .command("status <run-id>")
    .description("Inspect one durable citation run without provider calls.")
    .action(async (runId: string, _options: unknown, command: Command) => {
      const global = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: global.config });
      io.writeJson(await runCanonicalTool(config, "citation_run_status", { runId }));
    });
}
