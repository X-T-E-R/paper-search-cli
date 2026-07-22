import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import { listInstalledProviders } from "../providers/registry/sync.js";
import type { Io } from "../runtime/io.js";
import type { LookupIdentifierType } from "../lookup/resource.js";
import { createHelpSnapshot } from "../surface/help.js";
import { createPlatformStatusSnapshot } from "../surface/status.js";
import type { PlatformStatusSnapshot } from "../surface/status.js";
import { getTools, CLI_ONLY_COMMANDS, CLI_TOOL_MAPPINGS } from "../surface/tools.js";
import { inspectExternalSearchStatic } from "../external-search/config.js";
import { okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import { runCanonicalTool } from "../surface/toolRunner.js";
import { cliHistoryOptions, compactCanonicalArguments } from "./history.js";
import { acceptAlwaysJsonFlag } from "./alwaysJson.js";

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseLookupIdentifierType(value: unknown): LookupIdentifierType | undefined {
  return value === "doi" || value === "pmid" || value === "arxiv" || value === "isbn"
    ? value
    : undefined;
}

function platformStatusEnvelope(data: PlatformStatusSnapshot): ResultEnvelope<PlatformStatusSnapshot> {
  return okEnvelope({
    capability: "operate",
    tool: "platform_status",
    data,
    diagnostics: {
      providerInstallDir: data.providerInstallDir,
      sourceCounts: {
        academic: data.academic.length,
        patent: data.patent.length,
        web: data.web.length,
        invalid: data.invalidProviders.length,
      },
    },
  });
}

export function registerDiscoveryCommands(program: Command, io: Io): void {
  acceptAlwaysJsonFlag(program
    .command("lookup <identifierOrUrl>")
    .alias("resource-lookup")
    .alias("resource_lookup")
    .description("Resolve an identifier or URL into normalized resource metadata."))
    .option("--type <value>", "identifier type: doi, pmid, arxiv, or isbn")
    .option("--formats <csv>", "URL metadata format hints, comma-separated")
    .option("--provider <value>", "URL metadata provider hint; direct HTTP metadata capture is used by default")
    .option("--no-history", "resolve without writing a durable history record")
    .action(async (identifierOrUrl: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const isUrl = /^https?:\/\//i.test(identifierOrUrl);
      io.writeJson(await runCanonicalTool(config, "resource_lookup", compactCanonicalArguments({
        identifier: isUrl ? undefined : identifierOrUrl,
        identifierType: parseLookupIdentifierType(options.type),
        url: isUrl ? identifierOrUrl : undefined,
        formats: splitCsv(typeof options.formats === "string" ? options.formats : undefined),
        provider: typeof options.provider === "string" ? options.provider : undefined,
      }), cliHistoryOptions(options)));
    });

  program
    .command("tools")
    .description("List the current canonical tool surface and CLI mappings.")
    .option("--json", "print full discovery metadata")
    .action(async (options: { json?: boolean }, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const [installed, externalSearch] = await Promise.all([
        listInstalledProviders(config.providers.installDir),
        inspectExternalSearchStatic(),
      ]);
      const tools = getTools(installed, { externalSearchAvailable: externalSearch.state === "configured" });
      const cliMappings = CLI_TOOL_MAPPINGS.filter((mapping) => tools.some((tool) => tool.name === mapping.tool));
      if (options.json) {
        io.writeJson({
          surface: "capability-first",
          tools,
          cliMappings,
          cliOnlyCommands: CLI_ONLY_COMMANDS,
        });
        return;
      }
      for (const tool of tools) {
        io.writeLine(tool.name);
      }
    });

  program
    .command("help [topic]")
    .description("Show local capability help, provider usage notes, and CLI/tool mappings.")
    .option("--tool <name>", "focus on a canonical tool name")
    .option("--provider <id>", "focus on a provider id")
    .option("--locale <locale>", "locale hint: zh or en")
    .action(async (topic: string | undefined, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const snapshot = await createHelpSnapshot(config, {
        topic,
        tool: typeof options.tool === "string" ? options.tool : undefined,
        provider: typeof options.provider === "string" ? options.provider : undefined,
        locale: typeof options.locale === "string" ? options.locale : undefined,
      });
      io.writeJson(snapshot);
    });

  program
    .command("platform-status")
    .alias("platform_status")
    .description("Show provider health, config readiness, and canonical tool availability.")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: { json?: boolean }, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const snapshot = await createPlatformStatusSnapshot(config);
      const envelope = platformStatusEnvelope(snapshot);
      if (options.json) {
        io.writeJson(envelope);
        return;
      }
      io.writeLine(`provider install dir: ${snapshot.providerInstallDir}`);
      io.writeLine(`available tools: ${snapshot.availableTools.join(", ")}`);
      io.writeLine(`external search: ${snapshot.externalSearch.state}`);
      for (const group of [
        ["academic", snapshot.academic],
        ["patent", snapshot.patent],
        ["web", snapshot.web],
      ] as const) {
        io.writeLine(`${group[0]} providers:`);
        if (group[1].length === 0) {
          io.writeLine("  (none)");
          continue;
        }
        for (const entry of group[1]) {
          io.writeLine(
            `  - ${entry.id}@${entry.version ?? "unknown"} enabled=${entry.enabled ? "yes" : "no"} configured=${entry.configured ? "yes" : "no"} available=${entry.available ? "yes" : "no"}`,
          );
        }
      }
      if (snapshot.invalidProviders.length > 0) {
        io.writeLine("invalid providers:");
        for (const invalid of snapshot.invalidProviders) {
          io.writeLine(`  - ${invalid.id}: ${invalid.error ?? "unknown error"}`);
        }
      }
    });
}
