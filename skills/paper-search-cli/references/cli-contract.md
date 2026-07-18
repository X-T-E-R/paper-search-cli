# CLI Contract

## Installed Entrypoint and Probe

Run from the projected skill root:

```text
paper-search-cli/
```

The skill-local launcher resolves the retained checkout and its verified build:

```bash
node scripts/paper-search.mjs --version
node scripts/paper-search.mjs paths --json
```

Do not use repository-relative `node dist/cli.js` as the normal agent
entrypoint. If the verified runtime is missing or incompatible, the launcher
prints the repository installer command to run.

Probe before deeper actions:

```bash
node scripts/paper-search.mjs status --json
node scripts/paper-search.mjs tools --json
node scripts/paper-search.mjs help
```

If reference text disagrees with the launcher's `tools --json`, `help`, command
`--help`, or the source catalog, trust the live CLI and report the drift.

## ResultEnvelope

Capability commands and canonical tools return a machine-readable envelope:

```ts
interface ResultEnvelope<T = unknown> {
  ok: boolean;
  capability: "discover" | "identify" | "assess" | "acquire" | "extract" | "organize" | "orchestrate" | "operate";
  tool: string;
  planned?: boolean;
  data: T | null;
  diagnostics?: Record<string, unknown>;
  warnings?: string[];
  errors?: string[];
  provenance?: Record<string, unknown>;
}
```

Use `ok`, `planned`, `errors`, and `warnings` for control flow. Parse capability payloads from `data`. Treat `diagnostics` and `provenance` as evidence, not as the primary payload.

Some discovery surfaces such as `tools --json`, `help`, and `providers registry-candidates --json` expose catalog metadata rather than literature/material payloads. Use them to choose a supported command, then parse the command or canonical tool envelope.

## JSON Output

Prefer JSON/envelope output whenever available:

```bash
node scripts/paper-search.mjs status --json
node scripts/paper-search.mjs doctor --json
node scripts/paper-search.mjs platform-status --json
node scripts/paper-search.mjs providers list-installed --kind search --json
node scripts/paper-search.mjs providers list-installed --kind material --json
node scripts/paper-search.mjs artifact list --json
node scripts/paper-search.mjs material status <target> --json
```

Many source-compatible commands already emit JSON directly. Do not parse human text when an envelope or catalog JSON is available.

Commands whose only stdout representation is already a JSON `ResultEnvelope`
accept a command-local `--json` compatibility flag. On those commands the flag
is a no-op and does not change the envelope, so either form is safe:

```bash
node scripts/paper-search.mjs context status --json
node scripts/paper-search.mjs search-plan --type academic --json
node scripts/paper-search.mjs citation plan --doi <doi> --depth 1 --json
node scripts/paper-search.mjs assess plan --snapshot ./observations.json --sha256 <digest> --json
```

This is not a global format flag. Commands with human, file, catalog, or
multi-format stdout accept `--json` only when their own `--help` advertises it;
for example, `help` emits catalog JSON directly and `batch` uses
`--output-format` instead.

## Canonical tools and durable invocation

The human `run <tool>` command is the durable projection of canonical
`research_run`. It accepts only the fixed, non-destructive discovery allowlist:

```bash
node scripts/paper-search.mjs run academic_search --json-args "{\"query\":\"retrieval augmented generation\",\"presets\":[\"general\",\"computer-science\"],\"maxResults\":5}"
node scripts/paper-search.mjs run resource_lookup --arg identifier=10.1145/3366423.3380130
```

`--json-args` must be a JSON object. Repeated `--arg key=value` entries are merged with JSON args and parsed as booleans, numbers, or JSON when possible. The runner validates the argument schema and returns a `ResultEnvelope`.

Allowed tools are `academic_search`, `patent_search`, `resource_lookup`,
`patent_detail`, and optional `web_search`. Intrinsically durable citation and
assessment tools, local writes, and management operations are rejected. Use
their friendly CLI command or call their canonical/MCP tool directly.

The authoritative canonical names come from `node scripts/paper-search.mjs tools --json`. Current names are:

```text
mcp_help
academic_search
resource_lookup
patent_search
patent_detail
web_search
resource_add
collection_list
workspace_export
resource_pdf
artifact_download
artifact_list
artifact_show
extract
material_ingest
material_status
material_provider_list_installed
research_run
run_list
run_show
run_prune_plan
citation_expand
citation_run_status
assessment_run
assessment_show
assessment_list
platform_status
```

## Current CLI Aliases

Use aliases only when the freshly built live catalog reports them:

| Canonical tool | CLI commands and aliases |
| --- | --- |
| `academic_search` | `academic`, `academic-search`, `academic_search` |
| `resource_lookup` | `lookup`, `resource-lookup`, `resource_lookup` |
| `patent_search` | `patent`, `patent-search`, `patent_search` |
| `patent_detail` | `patent-detail`, `patent_detail` |
| `web_search` | `web`, `web-search`, `web_search` |
| `resource_add` | `resource-add`, `resource_add`, `add` |
| `collection_list` | `collection-list`, `collection_list`, `collections` |
| `workspace_export` | `workspace-export`, `resource-export`, `resource_export` |
| `resource_pdf` | `resource-pdf`, `resource_pdf`, `pdf` |
| `artifact_download` | `artifact download` |
| `artifact_list` | `artifact list` |
| `artifact_show` | `artifact show` |
| `extract` | `extract` |
| `material_ingest` | `material ingest` |
| `material_status` | `material status` |
| `material_provider_list_installed` | `providers list-installed --kind material`, `material-providers list-installed` |
| `research_run` | `run <tool>` |
| `run_list` | `runs list` |
| `run_show` | `runs show <id>` |
| `run_prune_plan` | `runs prune` without `--apply` |
| `citation_expand` | `citation plan`, `citation run`, `citation resume` |
| `citation_run_status` | `citation status` |
| `assessment_run` | `assess plan`, `assess run` |
| `assessment_show` | `assess show` |
| `assessment_list` | `assess list` |
| `platform_status` | `platform-status`, `platform_status` |
| `mcp_help` | `help` |

## Dry-Run and Plan

Before write or network actions, prefer the plan path:

```bash
node scripts/paper-search.mjs providers install <id> --json
node scripts/paper-search.mjs providers update [id...] --json
node scripts/paper-search.mjs providers install-zip <zip> --kind material --json
node scripts/paper-search.mjs providers uninstall <id> --kind material --json
node scripts/paper-search.mjs providers rollback <id> --kind material --revision <sha256> --json
node scripts/paper-search.mjs self mode self-update --json
node scripts/paper-search.mjs self update --json
node scripts/paper-search.mjs providers plan-registry <source> --kind search --json
node scripts/paper-search.mjs providers plan-registry <source> --kind material --json
node scripts/paper-search.mjs providers sync-registry <source> --kind material --json
node scripts/paper-search.mjs artifact download <url-or-itemKey-or-doi> --dry-run --json
node scripts/paper-search.mjs extract <input> --dry-run --json
node scripts/paper-search.mjs material ingest <input> --dry-run --json
node scripts/paper-search.mjs material setup-local-pymupdf4llm --python <absolute-python-3.11-path> --json
node scripts/paper-search.mjs citation plan --doi <doi> --depth 1
node scripts/paper-search.mjs assess plan --snapshot ./observations.json --sha256 <digest>
node scripts/paper-search.mjs runs prune
node scripts/paper-search.mjs zotero sink <item-id>
node scripts/paper-search.mjs batch ./rows.jsonl --dry-run --out ./planned.jsonl
```

`planned: true` means the command selected policy/provider/paths and did not
perform the write or network action. `self mode <mode>`, `self update`,
`providers install`, `providers update`, `providers sync-registry`,
`providers install-zip`, `providers uninstall`, and `providers rollback` are
plans unless `--apply` is present. Execute a change only after reviewing its
blockers, pinned source, digest, preconditions, actions, and any emitted rollback
revision. Replacing a subscription-bound provider from a local ZIP additionally
requires explicit `--replace-bound`; the default remains source-preserving. The production self-update
policy is source-sealed to the official HTTPS `main` origin; config,
environment, and CLI values cannot add or override repository authority.

`material setup-local-pymupdf4llm` is also plan-first. First-time `--apply`
requires an absolute Python 3.11 executable and creates the exact locked runtime
below `PAPER_SEARCH_HOME`; later calls verify the installed versions. Use
`extract <artifactId-or-path> --provider local-pymupdf4llm` to select it.
Installing this explicit-only provider does not change automatic extractor
selection.

For DOI inputs, `artifact download` accepts `--resolver <id>` and the canonical tool accepts `resolverId`/`resolver_id`. DOI dry-run plans list resolver loading and invocation before the download steps, and resolver failures are typed as `no_resolver`, `no_candidates`, or `resolver_error` in envelope diagnostics.

For a direct HTTPS URL, `material_ingest` dry-run may expose an
`exactUrlFallback` plan. Execution enters `exact_url_extraction` only after
`direct-url-downloader` reports HTTP 401, 403, or 429. Its success data has `artifact: null`,
an `acquisition` object with `status: "not_materialized"`, and extraction-only
output paths. Treat that as retained URL Markdown, not as acquired bytes.
Standalone `artifact_download`, other status codes, and unsafe/non-URL inputs do
not use this fallback.

## Batch JSONL

`batch` accepts CSV, JSONL, JSON, and YAML rows. Supported row tools include:

```text
academic_search
patent_search
patent_detail
web_search
resource_lookup
resource_add
resource_pdf
artifact_download
extract
material_ingest
citation_expand
assessment_run
```

Use `--dry-run` when rows mix search, local writes, or material actions. With `--out ./results.jsonl`, results are streamed in completion order; reconcile resumed runs by row `id` or `index`, not by line position.

## Workspace, outputs, and durable runs

- Conventional defaults live below `~/.paper-search/`; `PAPER_SEARCH_HOME` must
  be absolute when set. The invocation directory may select the nearest ancestor
  `paper-search.toml` as a project configuration layer.
- Workspace records, artifact bytes, extraction outputs, exports, and runs use
  independent resolved roots: `workspace.root`, `storage.artifactRoot`,
  `storage.extractionRoot`, `storage.exportRoot`, and `runs.root`.
- `workspace-export --store <safe-relative-key>` writes a collision-safe,
  versioned export below `storage.exportRoot`; add `--dry-run` for a no-write
  plan. `--out` remains caller-relative, and no file option means stdout.
- `resource_add`, including an explicit batch add row or `addMode = first`,
  writes normalized selected items to the local workspace sink. When a durable
  Zotero policy is active, the returned add result also reports its projection
  status; this is not a batch-exposed direct Zotero command.
- `resource_pdf` treats `itemKey` as the workspace item id and uses the same
  provider-mediated artifact path as `artifact_download`.
- `artifact_download` creates artifact records with source, attempts, policy, provider provenance, local/remote references, and optional workspace item links. DOI-resolved acquisitions also record `provenance.resolverProviderId`, `provenance.resolverSource`, the originating identifier in `resolvedFrom`, and per-candidate resolver attempts.
- `extract` creates extraction records with source, backend/provider id, options, outputs, cache status, and optional workspace item links.
- `material_ingest` copies a local-file input into managed artifact storage,
  records its storage ref/digest/size, and invokes an extractor that supports
  `artifact` input by artifact id. Direct `extract <path>` remains path-based.
- `material_status` reports related artifact and extraction ids for a workspace item, artifact, or extraction.
- `workspace_export` emits portable JSON, JSONL, CSV, or BibTeX files from local workspace records.
- Friendly CLI, canonical/MCP, and batch discovery write sanitized private local
  plaintext history by default. Direct CLI/batch uses `--no-history` to opt out;
  canonical/MCP uses `recordHistory: false`; `runs.recordByDefault = false` is
  the configuration-wide opt-out. `research_run` remains explicitly durable.
  Citation runs and assessment runs own their records. The default
  `runs.maxAgeDays = -1` disables age-based eligibility until the user supplies a
  positive prune cutoff.

A plain discovery command returns its envelope to stdout and writes one full run
to the effective context. A standalone or Paperflow context writes only its
configured `runs.root` plus a small global locator; without one, the global run
root is used with a short fallback hint. `context init .` creates a standalone
context, while fresh Paperflow workspaces generate their root config. Project
promotion remains separate from mounted search history.

Academic `sortBy` accepts `relevance`, `date`, and `citations`; patent `sortBy`
accepts `relevance` and `date`. Date and citations are descending per provider.
The host may stably reorder only the returned page when metadata is available.
Advanced requests expose compact values such as
`diagnostics.ordering.crossref = "citations:page-desc"` or
`"citations:unsupported"`; do not infer a global ranking.

Paper Search does not own the Paperflow schema. Paperflow generates a Paper
Search config whose run root matches `search_runs`, then reads those validated
runs directly. A separate bibliography/catalog workflow writes selected
records; mounted history is not an import schema or an acceptance decision.

Zotero MCP Neo is the optional host-application write boundary. User config
owns the endpoint/global defaults; project `zoteroBinding` may inherit, disable,
or bind selected items to multiple existing collections. Search hits never
trigger it. `resource-add` and successful downloads may project when durably
configured, with pending/partial receipts preserving local success. The
  explicit `zotero sink <itemId>` flow remains plan-first: `--preview` performs
  remote dry-runs and `--apply --ack <previewDigest>` performs bounded writes.
  For a newly created parent, the preview digest binds the attachment action and
  local path/mode template; apply resolves the new parent key and repeats the
  attachment dry-run before that attachment write. Mapped items can link or
  import durable artifact/Markdown files.

## Secret and Config Boundary

The conventional `~/.paper-search/` bundle contains user non-secret `config.toml`, user-only
`subscriptions.toml`, and optional ACL-restricted plaintext
`credentials.toml`. Optional external process authority lives separately in
`external-search.toml`. Only `config.toml` is required. Plaintext credentials
are not encrypted.

Configuration layers resolve in this order: built-in defaults, user
`config.toml`, nearest ancestor project config, explicit `--config`, `credentials.toml` for
credential keys, environment overrides, and command-specific flags where
supported. Project and explicit config remain one-off runtime overrides; they
are not promoted into trusted subscriptions.

- Inspect every conventional path with `node scripts/paper-search.mjs config path --all`.
- Use `config validate` to validate each file against its owning schema and
  `config explain <key>` to inspect the winning origin.
- Supported keys come from `node scripts/paper-search.mjs config keys`.
- Secret-like values are masked by `config list`, `config get`, and `doctor`.
- Use `config credentials set <key> --stdin` or `--from-env <name>`; never pass
  a credential as a positional value. `get` is masked, and `unset` removes it.
- `config import-env <env-path>` plans by default. It routes supported
  non-secrets to `config.toml` and secrets to `credentials.toml`; add `--apply`
  only after review. Entries already present in the shell environment are
  skipped.
- `migrate` plans journaled legacy-v0 config and flat provider-directory
  migration together. Add `--apply` only after reviewing its source, target,
  blockers, and digests; custom provider roots require
  `--legacy-install-dir <path>`.
- `external-search.toml` is the only authority for `web_search`; project,
  explicit, credential, and environment layers cannot select its executable or adapter.
- Provider-specific config lives under the provider id section used by the runtime.

Never print raw API keys, tokens, passwords, or credentials. If a command needs live credentials, report only whether the required key is present or missing.
