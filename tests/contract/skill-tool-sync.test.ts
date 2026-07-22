import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getCanonicalToolNames } from "../../src/surface/toolCatalog.js";
import { CLI_ONLY_COMMANDS, CLI_TOOL_MAPPINGS } from "../../src/surface/tools.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "../..");

const SKILL_DOC_PATHS = [
  "skills/paper-search-cli/SKILL.md",
  "skills/paper-search-cli/references/capability-routing.md",
  "skills/paper-search-cli/references/cli-contract.md",
  "skills/paper-search-cli/references/management-layer.md",
] as const;

const CLI_CONTRACT_PATH = "skills/paper-search-cli/references/cli-contract.md";

/**
 * Tight non-tool terms that intentionally look command-like in the skill docs.
 * Do not add old tool names here: CLI aliases must come from CLI_TOOL_MAPPINGS,
 * and CLI-only provider-management commands should come from CLI_ONLY_COMMANDS
 * when that exported catalog covers them.
 */
const APPROVED_NON_TOOL_IDENTIFIER_TERMS = [
  "paper-search-cli",
  "resource-search-providers",
  "material-provider",
  "material-providers",
  // Mutable material registry release tag in the documented exact JSON URL.
  "material-registry-latest",
  // Material provider manifest kind documented by the skill, not a tool name.
  "artifact_resolver",
  // Named smoke cases from scripts/run-smoke.mjs, not tool names.
  "material-mineru-live",
  "material-unpaywall-live",
] as const;

/**
 * CLI-only command heads that are not canonical MCP tools and are not fully
 * represented in CLI_ONLY_COMMANDS. Keep this list narrow so stale tool names
 * cannot pass as generic commands.
 */
const APPROVED_NON_TOOL_COMMAND_HEADS = [
  "batch",
  "config path",
  "config keys",
  "config list",
  "config get",
  "config set",
  "config unset",
  "config import-env",
  "doctor",
  "mcp serve",
  "tools",
  "run",
  "material-providers validate-manifest",
  "material-providers inspect-package",
  "material-providers plan-registry",
  "material-providers sync-registry",
  "material-providers install-zip",
] as const;

const TOOLISH_IDENTIFIER_PATTERN =
  /\b(?:(?:mcp|academic|resource|patent|web|collection|workspace|artifact|material|platform|research|run|citation|assessment)_[a-z0-9]+(?:_[a-z0-9]+)*|(?:paper-search|academic|resource|patent|web|collection|workspace|artifact|material|platform|mcp|research|run|citation|assessment)-[a-z0-9]+(?:-[a-z0-9]+)*)\b/g;

function readSkillDocs(): Record<string, string> {
  return Object.fromEntries(
    SKILL_DOC_PATHS.map((relativePath) => [
      relativePath,
      readFileSync(path.join(packageRoot, relativePath), "utf8"),
    ]),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsExactTerm(markdown: string, term: string): boolean {
  const pattern = escapeRegExp(term).replace(/\\ /g, "\\s+");
  return new RegExp(`(?<![A-Za-z0-9_/-])${pattern}(?![A-Za-z0-9_/-])`).test(markdown);
}

function markdownSection(markdown: string, heading: string): string {
  const headingLine = `## ${heading}`;
  const start = markdown.indexOf(headingLine);
  if (start === -1) {
    throw new Error(`Missing markdown section: ${headingLine}`);
  }
  const rest = markdown.slice(start + headingLine.length);
  const nextHeading = rest.search(/\n## /);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function catalogAliasCommands(): string[] {
  return CLI_TOOL_MAPPINGS.flatMap((mapping) => mapping.commands);
}

function stripFlagsAndArgs(command: string): string {
  const commandParts: string[] = [];
  for (const part of command.split(/\s+/).filter(Boolean)) {
    if (part.startsWith("--") || part.startsWith("<") || part.startsWith("./")) {
      break;
    }
    commandParts.push(part);
  }
  return commandParts.join(" ");
}

function toolishIdentifiers(value: string): string[] {
  return [...value.matchAll(TOOLISH_IDENTIFIER_PATTERN)]
    .filter((match) => {
      const index = match.index ?? -1;
      return index < 2 || value.slice(index - 2, index) !== "--";
    })
    .map((match) => match[0]);
}

function allowedIdentifierTerms(): Set<string> {
  return new Set([
    ...getCanonicalToolNames(),
    ...catalogAliasCommands().flatMap(toolishIdentifiers),
    ...CLI_ONLY_COMMANDS.map((entry) => entry.command).flatMap(toolishIdentifiers),
    ...APPROVED_NON_TOOL_IDENTIFIER_TERMS,
  ]);
}

function tokenizeCommandTail(tail: string): string[] {
  return (tail.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    token.replace(/^["']|["']$/g, ""),
  );
}

function parseCliInvocation(line: string): { commandHead: string; runTool?: string } | null {
  const match = line.match(/node\s+dist\/cli\.js\s+([^`\r\n]+)/);
  if (!match) return null;

  const tail = match[1];
  if (!tail) return null;

  const tokens = tokenizeCommandTail(tail);
  const first = tokens[0];
  if (!first) return null;

  if (first === "run") {
    return { commandHead: "run", runTool: tokens[1] };
  }

  if (
    [
      "artifact",
      "assess",
      "citation",
      "config",
      "material",
      "material-providers",
      "mcp",
      "providers",
      "runs",
      "zotero",
    ].includes(first)
  ) {
    const second = tokens[1];
    if (second && !second.startsWith("--") && !second.startsWith("<") && !second.startsWith("./")) {
      return { commandHead: `${first} ${second}` };
    }
  }

  return { commandHead: first };
}

function allowedCommandHeads(): Set<string> {
  return new Set([
    ...catalogAliasCommands().map(stripFlagsAndArgs),
    ...CLI_ONLY_COMMANDS.map((entry) => stripFlagsAndArgs(entry.command)),
    ...APPROVED_NON_TOOL_COMMAND_HEADS,
  ]);
}

describe("paper-search skill tool synchronization", () => {
  it("documents every canonical tool and current CLI alias from the source catalog", () => {
    const canonicalTools = getCanonicalToolNames();
    const mappedTools = [...new Set(CLI_TOOL_MAPPINGS.map((mapping) => mapping.tool))].sort();
    expect(mappedTools).toEqual([...canonicalTools].sort());

    const cliContract = readFileSync(path.join(packageRoot, CLI_CONTRACT_PATH), "utf8");
    const currentAliasSection = markdownSection(cliContract, "Current CLI Aliases");

    const missingCanonicalTools = canonicalTools.filter(
      (tool) => !mentionsExactTerm(currentAliasSection, tool),
    );
    const missingAliases = catalogAliasCommands().filter(
      (command) => !mentionsExactTerm(currentAliasSection, command),
    );

    expect(missingCanonicalTools).toEqual([]);
    expect(missingAliases).toEqual([]);
  });

  it("rejects stale tool-like identifiers and CLI examples outside the catalog", () => {
    const docs = readSkillDocs();
    const canonicalTools = new Set(getCanonicalToolNames());
    const allowedIdentifiers = allowedIdentifierTerms();
    const allowedCommands = allowedCommandHeads();
    const identifierViolations: string[] = [];
    const commandViolations: string[] = [];

    for (const [relativePath, markdown] of Object.entries(docs)) {
      markdown.split(/\r?\n/).forEach((line, index) => {
        for (const identifier of toolishIdentifiers(line)) {
          if (!allowedIdentifiers.has(identifier)) {
            identifierViolations.push(`${relativePath}:${index + 1}: ${identifier}`);
          }
        }

        const invocation = parseCliInvocation(line);
        if (!invocation) return;

        if (invocation.commandHead === "run") {
          if (!invocation.runTool || !canonicalTools.has(invocation.runTool)) {
            commandViolations.push(
              `${relativePath}:${index + 1}: run ${invocation.runTool ?? "<missing-tool>"}`,
            );
          }
          return;
        }

        if (!allowedCommands.has(invocation.commandHead)) {
          commandViolations.push(`${relativePath}:${index + 1}: ${invocation.commandHead}`);
        }
      });
    }

    expect(identifierViolations).toEqual([]);
    expect(commandViolations).toEqual([]);
  });
});
