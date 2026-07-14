---
name: paper-search-cli
description: Use the local paper-search-cli for academic/patent/configured-web search, identifier lookup, artifact acquisition, extraction, material ingest/status, workspace storage/export, provider and registry-subscription management, config/migration/status checks, and MCP serving. Trigger for paper-search-cli, paper-search MCP, mcp serve, provider registries, academic_search, patent_search, patent_detail, web_search, web_research, resource_lookup, resource_add, resource_pdf, artifact_download, extract, material_ingest, workspace_export, platform_status, batch, doctor, config, migrate, registries, providers, or material-providers. Use the Zotero skill instead for Zotero writes or Zotero Resource Search; do not use this skill for general web search that does not need Paper Search.
---

# Paper Search CLI

Use this skill for the local `paper-search-cli` system and its MCP server. Run the skill-local launcher for deterministic terminal evidence; use `mcp serve` only when the request needs the JSON-RPC transport over the same core behavior.

## Installed Entrypoint

Run commands from this skill directory through its launcher:

```bash
node scripts/paper-search.mjs --version
node scripts/paper-search.mjs paths --json
node scripts/paper-search.mjs self status --json
node scripts/paper-search.mjs self mode --json
node scripts/paper-search.mjs self update --json
```

The installed skill is a Junction or symlink into a retained Paper Search
checkout. This launcher resolves that checkout and starts its verified runtime.
Do not bypass it with a repository-relative `node dist/cli.js` command during
normal agent use. The `paper-search` command is the equivalent shim for humans.

## Activation Boundary

Use this skill when the request is explicitly about `paper-search-cli`, its provider packages, its local workspace, its material artifact/extraction records, its MCP server, or its source-compatible canonical tools.

Do not use this skill for ordinary news lookup, broad web browsing, or general current-events search unless the user explicitly asks to route that work through `paper-search-cli`.

## Eight Capability Groups

| Group | Use for |
| --- | --- |
| `discover` | Academic, patent, and configured web search. |
| `identify` | DOI/PMID/arXiv/ISBN/URL metadata lookup and patent detail. |
| `assess` | Reserved group with no implemented tools; do not route work here (promotion criteria: [ADR-0003](../../docs/decisions/ADR-0003-assess-capability-group-disposition.md)). |
| `acquire` | Artifact acquisition/recording from a URL, workspace item, or DOI, plus PDF attachment records. |
| `extract` | Markdown/JSON/assets extraction from an artifact, URL, or local file through material providers. |
| `organize` | Local workspace add/list/export operations. |
| `orchestrate` | Batch rows, material ingest, and material status over stored records. |
| `operate` | Status, doctor, config, provider management, help/tools, and MCP serving. |

## Reference Rule

Before parameter-heavy work, read the matching reference:

- Read `references/capability-routing.md` before mapping a request to the eight groups and current entrypoints.
- Read `references/cli-contract.md` before touching working directory, build/probe, JSON output, `ResultEnvelope`, `run <canonical_tool>`, aliases, batch rows, dry-run/plan, local records, or secrets/config.
- Read `references/management-layer.md` before using `status`, `doctor`, `config`, `migrate`, `registries`, subscription-bound `providers available|install|update`, `providers inventory`, `providers --kind search|material`, `material-providers`, `mcp serve`, `platform-status`, `help`, `tools`, or smoke gates.
- Read `references/management-layer.md` before planning or applying `self mode`
  or `self update`. These commands are plan-first. Production authority is
  source-sealed to the official HTTPS `main` origin and cannot be changed by
  config, environment, or CLI input; other clones remain user-managed.

For material download, extraction, or ingest, route through material-provider discovery and a dry-run/plan before live network or write execution. DOI inputs are resolved to candidate URLs through installed resolver providers before download. No networked material resolver, downloader, or extractor is built into the core CLI; installed material providers must be discovered and validated.

## Trust Live CLI

If this skill or a reference disagrees with the installed CLI, trust the live
CLI and report the documentation drift. Run every probe below from this skill
directory. If the launcher reports a missing or incompatible verified build,
follow its installer command rather than invoking `dist/cli.js` directly.
Prefer these probes:

```bash
node scripts/paper-search.mjs --version
node scripts/paper-search.mjs tools --json
node scripts/paper-search.mjs help
node scripts/paper-search.mjs status --json
```

## Validation Boundary

Report the exact command evidence used. Keep smoke or live-network validation explicit: do not claim live provider, live web backend, remote PDF, networked material extraction, or MCP behavior unless the matching smoke gate, provider inspection, contract test, or JSON-RPC call was actually run.
