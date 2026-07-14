import type { InstalledProviderSummary } from "../providers/registry/sync.js";
import { cloneToolSchemas, type ToolSchema } from "./toolCatalog.js";

export interface CliToolMapping {
  tool: string;
  commands: string[];
  note?: string;
}

export const CLI_TOOL_MAPPINGS: CliToolMapping[] = [
  {
    tool: "mcp_help",
    commands: ["help"],
    note: "Local help snapshot for the capability-first CLI surface.",
  },
  {
    tool: "academic_search",
    commands: ["academic", "academic-search", "academic_search"],
  },
  {
    tool: "resource_lookup",
    commands: ["lookup", "resource-lookup", "resource_lookup"],
  },
  {
    tool: "patent_search",
    commands: ["patent", "patent-search", "patent_search"],
  },
  {
    tool: "patent_detail",
    commands: ["patent-detail", "patent_detail"],
    note: "Use patent-detail before resource-add when patent notes, claims, or PDF/image URLs matter.",
  },
  {
    tool: "web_search",
    commands: ["web", "web-search", "web_search"],
    note: "Uses the optional user-level External Search v1 process configuration.",
  },
  {
    tool: "resource_add",
    commands: ["resource-add", "resource_add", "add"],
    note: "Writes into the local workspace sink.",
  },
  {
    tool: "collection_list",
    commands: ["collection-list", "collection_list", "collections"],
  },
  {
    tool: "workspace_export",
    commands: ["workspace-export", "resource-export", "resource_export"],
    note: "Exports local workspace records as JSON, JSONL, CSV, or BibTeX.",
  },
  {
    tool: "resource_pdf",
    commands: ["resource-pdf", "resource_pdf", "pdf"],
    note: "Uses installed material providers and projects the artifact onto a workspace item.",
  },
  {
    tool: "artifact_download",
    commands: ["artifact download"],
    note: "Uses material downloader providers and stores artifact records with provenance.",
  },
  {
    tool: "artifact_list",
    commands: ["artifact list"],
    note: "Reads artifact records from the local workspace.",
  },
  {
    tool: "artifact_show",
    commands: ["artifact show"],
    note: "Reads one artifact record by id from the local workspace.",
  },
  {
    tool: "extract",
    commands: ["extract"],
    note: "Uses material extractor providers and stores extraction records.",
  },
  {
    tool: "material_ingest",
    commands: ["material ingest"],
    note: "Orchestrates artifact acquisition and extraction through the shared material primitives.",
  },
  {
    tool: "material_status",
    commands: ["material status"],
    note: "Reports artifact and extracted-output status for a workspace item, artifact, or extraction.",
  },
  {
    tool: "material_provider_list_installed",
    commands: ["providers list-installed --kind material", "material-providers list-installed"],
    note: "Uses the durable providers --kind material management shape.",
  },
  {
    tool: "research_run",
    commands: ["run"],
    note: "Only wraps the fixed non-destructive discovery allowlist; intrinsically durable and management tools are rejected.",
  },
  {
    tool: "run_list",
    commands: ["runs list"],
  },
  {
    tool: "run_show",
    commands: ["runs show"],
  },
  {
    tool: "run_prune_plan",
    commands: ["runs prune"],
    note: "Canonical invocation is plan-only; applying a prune remains CLI-only and requires --apply.",
  },
  {
    tool: "citation_expand",
    commands: ["citation plan", "citation run", "citation resume"],
    note: "Unions exact-identifier graph providers with bounded traversal and durable checkpoints.",
  },
  {
    tool: "citation_run_status",
    commands: ["citation status"],
  },
  {
    tool: "assessment_run",
    commands: ["assess plan", "assess run"],
    note: "Consumes an immutable checksum-bound local observation snapshot; it does not make hidden quality decisions.",
  },
  {
    tool: "assessment_show",
    commands: ["assess show"],
  },
  {
    tool: "assessment_list",
    commands: ["assess list"],
  },
  {
    tool: "platform_status",
    commands: ["platform-status", "platform_status"],
  },
];

export const CLI_ONLY_COMMANDS = [
  {
    command: "paths",
    purpose: "Show the independent checkout, config, data, bin, state, and build paths.",
  },
  {
    command: "setup",
    purpose: "Plan or apply source-linked skill projections, CLI shims, and an isolated verified build.",
  },
  {
    command: "self status",
    purpose: "Inspect checkout ownership, source/build freshness, management mode, projections, and shims.",
  },
  {
    command: "self mode",
    purpose: "Inspect or plan the explicit switch between user-managed and official self-update modes.",
  },
  {
    command: "self update",
    purpose: "Plan or apply a policy-bound, verified fast-forward update of the retained checkout.",
  },
  {
    command: "status",
    purpose: "Resolve install/config/workspace/provider paths, build health, PATH membership, and smoke gating state.",
  },
  {
    command: "doctor",
    purpose: "Check install/build health, provider receipts and recovery state, workspace access, registry snapshots, and masked credential readiness.",
  },
  {
    command: "config path --all",
    purpose: "Show config.toml, config.d, subscriptions.toml, credentials.toml, and external-search.toml paths.",
  },
  {
    command: "config validate",
    purpose: "Validate the strict split configuration files and compatibility project layers.",
  },
  {
    command: "config explain",
    purpose: "Show a resolved non-secret or masked config value and its winning origin.",
  },
  {
    command: "config credentials set|get|unset",
    purpose: "Manage credentials through non-positional secret input and masked output.",
  },
  {
    command: "config import-env --apply",
    purpose: "Plan, classify, and optionally route environment entries to config or credential files.",
  },
  {
    command: "search-plan",
    purpose: "Explain preset/category expansion, exclusions, aliases, and provider readiness without searching.",
  },
  {
    command: "migrate",
    purpose: "Plan or apply journaled migration of legacy v0 user configuration and flat provider installs without modifying project config files.",
  },
  {
    command: "runs export",
    purpose: "Export one sanitized run or change whether age retention may prune it.",
  },
  {
    command: "runs pin",
    purpose: "Keep one durable run out of age-based pruning.",
  },
  {
    command: "runs unpin",
    purpose: "Return one durable run to the configured age-retention policy.",
  },
  {
    command: "runs prune --apply",
    purpose: "Explicitly quarantine and delete only eligible local run records after reviewing the plan.",
  },
  {
    command: "zotero sink",
    purpose: "Export bibliographic records to a configured Zotero endpoint with an explicit digest-bound apply step; attachments remain outside the claimed contract.",
  },
  {
    command: "registries list|show",
    purpose: "Inspect trusted search and material registry subscriptions and their bound identities.",
  },
  {
    command: "registries add|rebind|enable|disable|remove",
    purpose: "Plan trust changes by default and apply them only with an explicit --apply.",
  },
  {
    command: "registries refresh",
    purpose: "Validate enabled registry metadata into immutable local snapshots without installing providers.",
  },
  {
    command: "providers list-installed",
    purpose: "Inspect installed provider packages and malformed folders.",
  },
  {
    command: "providers available",
    purpose: "Inspect the aggregated provider catalog from enabled validated registry snapshots without refreshing them.",
  },
  {
    command: "providers inventory",
    purpose: "Report declared search entries, countable sources, views, aliases, service families, and retained entries from a search registry.",
  },
  {
    command: "providers install",
    purpose: "Plan or apply a subscription-bound provider install with pinned source, registry, and archive identities.",
  },
  {
    command: "providers update",
    purpose: "Plan or apply origin-bound provider updates from the receipts of installed providers.",
  },
  {
    command: "providers registry-candidates",
    purpose: "Expand GitHub repo or registry inputs into candidate registry.json URLs.",
  },
  {
    command: "providers plan-registry",
    purpose: "Dry-run provider install/update actions from a registry source.",
  },
  {
    command: "providers sync-registry --apply",
    purpose: "Apply provider install/update actions after an explicit dry-run review.",
  },
  {
    command: "providers validate-manifest",
    purpose: "Validate provider manifest.json against the local compatibility contract.",
  },
  {
    command: "providers inspect-package",
    purpose: "Instantiate a provider bundle in Node compatibility mode and inspect capabilities.",
  },
  {
    command: "providers install-zip",
    purpose: "Plan a local provider ZIP by default; --apply installs it with an unbound receipt.",
  },
];

export function getTools(
  installedProviders: InstalledProviderSummary[],
  options: { externalSearchAvailable?: boolean } = {},
): ToolSchema[] {
  const tools = cloneToolSchemas().filter(
    (tool) => tool.name !== "web_search" || options.externalSearchAvailable === true,
  );
  const patentSelectors = providerSelectorTokens(installedProviders, "patent");
  const patentDetailTool = tools.find((tool) => tool.name === "patent_detail");
  if (patentDetailTool && patentSelectors.length > 0) {
    const platformProp = patentDetailTool.inputSchema.properties.platform as { enum?: string[] };
    platformProp.enum = patentSelectors;
  }
  return tools;
}

function providerSelectorTokens(
  providers: InstalledProviderSummary[],
  sourceType: "academic" | "patent",
): string[] {
  return [...new Set(
    providers
      .filter((entry) => entry.valid && entry.manifest?.sourceType === sourceType)
      .flatMap((entry) => [entry.id, ...(entry.manifest?.inventory?.aliases ?? [])]),
  )].sort((left, right) => left.localeCompare(right));
}
