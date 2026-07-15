---
name: paper-search-cli
description: Use Paper Search CLI X for academic/patent discovery, optional External Search v1 web_search, multi-preset/source union, identifier lookup, durable research_run history, citation_expand plan/run/resume, checksum-bound transparent assessment, provider-mediated artifact/PDF acquisition and extraction, local workspace/export, CLI-only Zotero bibliographic handoff, provider/registry/config/migration/status management, and MCP serving. Trigger for paper-search-cli, paper-search, academic_search, patent_search, resource_lookup, research_run, runs, citation_expand, assessment_run, artifact_download, resource_pdf, extract, material_ingest, zotero sink, search-plan, registries, providers, doctor, or mcp serve. Do not use for ordinary web browsing unless the user explicitly requests Paper Search or its optional external-search surface.
---

# Paper Search CLI X

Use this skill for the local `paper-search-cli` system, its canonical tools, and
its MCP server. X means extensibility and open possibilities; it does not rename
the `paper-search` command, skill slug, configuration keys, or canonical tools.

## Installed entrypoint

Run commands from this skill directory through its launcher:

```bash
node scripts/paper-search.mjs --version
node scripts/paper-search.mjs paths --json
node scripts/paper-search.mjs status --json
node scripts/paper-search.mjs tools --json
```

The installed skill is a Junction or symlink into a retained Paper Search
checkout. The launcher resolves that checkout and starts its verified runtime.
Do not bypass it with repository-relative `node dist/cli.js` during normal agent
use. The `paper-search` shim is the equivalent human entrypoint.

## Activation boundary

Use this skill when the request concerns Paper Search, its provider packages,
search/run history, citation expansion, transparent assessment, compatibility
workspace/material records, its explicit Zotero sink, its MCP server, or a
canonical tool. Paper Search may write its own run record to a nearest-directory
standalone or Paperflow context. Paperflow still owns project roles and the
research runtime; selected bibliography/evidence records remain a separate
project workflow.

The optional `web_search` tool exists only when the user-owned
`external-search.toml` grants External Search v1 process authority. Use normal
search/browser routing for general web work. Use a dedicated Zotero skill for
general Zotero library operations; use this skill only for Paper Search's
explicit `zotero sink` handoff.

## Eight capability groups

| Group | Use for |
| --- | --- |
| `discover` | Academic and patent search, plus optional External Search v1. |
| `identify` | DOI/PMID/arXiv/ISBN/URL metadata lookup and patent detail. |
| `assess` | Checksum-bound observation snapshots, conflicts, provenance, and optional explicit policy traces. |
| `acquire` | Provider-mediated artifact acquisition or recording, including `resource_pdf` compatibility. |
| `extract` | Markdown, structured output, and assets through material extractor providers. |
| `organize` | Local workspace add/list/export and the explicit CLI-only Zotero bibliographic handoff. |
| `orchestrate` | Durable discovery, citation expansion, batch rows, material ingest, and material status. |
| `operate` | Paths, status, run inspection/pruning plans, config, provider management, help/tools, and MCP serving. |

## Default workflow

1. Probe `doctor --json`, `tools --json`, and installed search/material providers.
2. Use `search-plan` before a broad multi-preset/source query. Repeated positive
   selectors form a union. Real friendly CLI, canonical/MCP, and batch discovery
   is recorded by default. A plain search returns an envelope and writes one run
   to the effective context. Without a local config this is the global run root;
   inside a configured workspace it is that context's `runs.root`.
3. Use CLI/batch `--no-history`, canonical/MCP `recordHistory: false`, or
   `runs.recordByDefault = false` only for an explicit opt-out. `run
   <canonical-tool>` and canonical/MCP `research_run` remain explicitly durable.
   Default retention is `maxAgeDays = -1`; local plaintext history is not
   age-pruned automatically.
4. Use `citation plan` before `citation run`; set explicit bounds, and use
   `citation resume <id>` after interruption.
5. Use `context init .` once for a standalone project. Fresh Paperflow
   workspaces already map Paper Search `runs.root` to `search_runs`, so direct
   Paper Search calls from descendants are visible through Paperflow history.
   Do not treat mounted search hits as accepted bibliography/evidence records.
6. Discover material providers and run `--dry-run` before PDF acquisition,
   extraction, or ingest. Local-file ingest copies the source into managed
   artifact storage and therefore needs an extractor that advertises the
   `artifact` input kind. Direct
   path extraction does not create that copy. Core has no source-specific
   network fallback.
7. Use `assess plan` or `assess run` only with an exact snapshot checksum. Read
   conflicts and the policy trace; do not treat assessment as a ranking oracle.
8. If requested, use `zotero sink` plan, preview, and digest-acknowledged apply.
   Do not claim attachment import.

For result ordering, use `sortBy` or friendly `--sort-by`. Academic values are
`relevance`, `date`, and `citations`; patent values are `relevance` and `date`.
Date and citations are descending within each provider group. When omitted,
the provider-specific `platform.<id>.defaultSort` overrides the corresponding
`search.defaultAcademicSort` or `search.defaultPatentSort`; built-in fallback is
`relevance`. Do not present provider-group ordering as a cross-provider global
ranking. Advanced sorts expose compact per-provider values such as
`diagnostics.ordering.openalex = "citations:page-desc"` or
`"citations:unsupported"`; default relevance omits this diagnostic.

## Reference rule

- Read `references/capability-routing.md` before mapping an intent to current
  CLI and canonical names.
- Read `references/cli-contract.md` before canonical invocation, durable runs,
  citation/assessment schemas, aliases, batch rows, local records, Zotero, or
  secret/config handling.
- Read `references/management-layer.md` before `status`, `doctor`, `paths`,
  `runs`, `search-plan`, config, migration, registries/providers, retained
  checkout management, MCP serving, or smoke gates.

For networked material work, discover and validate installed material providers
before execution. DOI resolution, PDF download, and extraction remain
provider-mediated. Paper Search reports technical prerequisites and provenance;
the user remains responsible for licensing, entitlement, legal, and
jurisdictional decisions.

## Trust the live CLI

If this skill or a reference disagrees with the installed CLI, trust the live
catalog and help, then report the documentation drift:

```bash
node scripts/paper-search.mjs --version
node scripts/paper-search.mjs tools --json
node scripts/paper-search.mjs help
node scripts/paper-search.mjs status --json
```

Report the exact evidence used. Do not claim live provider, external Web,
remote PDF, network extraction, Zotero write, or MCP behavior without the
matching provider inspection, smoke gate, preview/apply receipt, contract test,
or JSON-RPC call.
