# Paper Search CLI X workflows and storage

Paper Search CLI X adds extensible citation expansion, durable research runs,
transparent assessment, configurable output roots, and an optional Zotero
bibliographic handoff. The X means extensibility and open possibilities; it is
a display name, not a breaking rename of the `paper-search` command, package,
configuration keys, canonical tools, or MCP identity.

Paper Search remains a search engine rather than a research-project directory.
Paperflow is the semantic-path and project-runtime layer; a project-side
bibliography/catalog adapter owns selected records. The two systems exchange
canonical JSON requests and `ResultEnvelope` responses. Paper Search does not
read `paperflow.yaml` or write Paperflow path roles. See
[Paperflow integration](./paperflow-integration.md).

## Use one conventional user home

Unless you set an absolute `PAPER_SEARCH_HOME`, conventional user state lives
below `~/.paper-search/`:

```text
~/.paper-search/
  config.toml
  config.d/
  subscriptions.toml
  credentials.toml
  external-search.toml
  adapters/
  bin/
  providers/
  cache/
    registries/
    archives/
  state/
  runs/
  workspace/
  storage/
    artifacts/
    extractions/
  exports/
```

Directories are created only when a command needs them. The CLI, installed
Skill launcher, and MCP server resolve the same defaults regardless of the
current working directory.

The old `%APPDATA%/paper-search/`, `$XDG_CONFIG_HOME/paper-search/`, and
`~/.config/paper-search/` roots are migration sources only. Use `paths`,
`config path --all`, `status`, `doctor`, and `migrate` to inspect the authority
and migration state. Migration copies known files and does not delete or rewrite
the legacy source.

## Configure records, outputs, and run history independently

The default workspace, material files, exports, and durable runs have separate
roots:

```toml
[workspace]
root = "~/.paper-search/workspace"

[storage]
artifactRoot = "~/.paper-search/storage/artifacts"
extractionRoot = "~/.paper-search/storage/extractions"
exportRoot = "~/.paper-search/exports"

[runs]
root = "~/.paper-search/runs"
maxAgeDays = -1
recordByDefault = true
```

Changing one root affects future writes; it does not reinterpret existing
workspace-relative `path` fields. New material outputs retain a versioned local
storage reference with the captured root and a contained relative key.

Use the managed export path when an export should live below the configured
export root:

```bash
paper-search workspace-export --store reports/library.jsonl --dry-run --json
paper-search workspace-export --store reports/library.jsonl --json
```

`--store` accepts a safe relative key, never overwrites an existing target, and
writes through the same versioned local-storage contract as material outputs.
`--out` remains an explicit caller-relative path; with neither option the
export remains on stdout.

`maxAgeDays = -1` means age alone never makes a run eligible for pruning. A
positive value supplies the cutoff used by an explicit prune plan. Paper Search
does not delete history during unrelated commands.

Durable runs are private local plaintext. Real discovery calls are recorded by
default across friendly CLI, canonical/MCP, and batch surfaces. Sanitized queries, identifiers,
results, assessment observations, and policy traces may remain indefinitely at
the default setting. Review a prune plan before applying it:

```bash
paper-search runs list
paper-search runs show <run-id>
paper-search runs prune
paper-search runs prune --max-age-days 30
paper-search runs prune --max-age-days 30 --apply
```

`runs export`, `runs pin`, `runs unpin`, and applied pruning are CLI-only. The
canonical/MCP management tools are `run_list`, `run_show`, and the plan-only
`run_prune_plan`.

## Keep discovery history unless you opt out

Friendly discovery commands record a durable run by default:

```bash
paper-search academic "graph neural networks" --preset general
paper-search patent "solid-state battery" --preset patents
paper-search lookup 10.1145/3366423.3380130
```

Each result reports `diagnostics.historyRecorded`; recorded calls also report a
`runId`. Use `--no-history` for a one-off CLI opt-out, `recordHistory: false`
for a canonical/MCP opt-out, or `runs.recordByDefault = false` for an explicit
configuration-wide opt-out. Batch has the same `--no-history` switch.

Use the `run` wrapper when the invocation should be explicitly and always
durable regardless of the default configuration:

```bash
paper-search run academic_search \
  --json-args '{"query":"graph neural networks","presets":["general","computer-science"],"maxResults":5}'
```

The corresponding canonical/MCP wrapper is `research_run`. Its allowlist is
`academic_search`, `patent_search`, `resource_lookup`, `patent_detail`, and the
optional `web_search`. Intrinsically durable workflows and destructive
management operations are not accepted by this wrapper.

## Union presets and sources

Repeat `--preset`, `--source`, or `--category` to form a canonical provider-id
union. Once a positive selector is present, the implicit default preset is not
added. Exact `--exclude-source` selectors are applied last.

```bash
paper-search search-plan --type academic \
  --preset general \
  --preset computer-science \
  --source crossref \
  --exclude-source wos
```

`search-plan` expands presets, aliases, categories, exclusions, and readiness
without searching. Literal `--platform all` means all runnable installed
non-view sources for that command type; it is not an alias for `general`.

Generic external Web search is optional. The `web`, `web-search`, and
`web_search` surfaces appear only when the user-owned
`~/.paper-search/external-search.toml` grants External Search v1 process
authority. Project configuration cannot grant that executable authority.

## Plan, run, and resume citation expansion

Citation expansion starts from exact identifiers and uses installed
graph-capable academic providers. Repeated providers and both directions use
union semantics; normalized nodes and edges are deduplicated while per-edge
provider provenance is retained.

Plan first to validate identifiers, provider readiness, and bounds without
network calls or writes:

```bash
paper-search citation plan \
  --doi 10.1145/3366423.3380130 \
  --direction backward \
  --direction forward \
  --provider semantic \
  --depth 1 \
  --per-node 25 \
  --max-nodes 100 \
  --max-edges 200
```

Run the same bounded traversal with `citation run`. Each valid provider page is
checkpointed in the common run store. If the run is interrupted, continue from
its checkpoint instead of repeating completed provider work:

```bash
paper-search citation resume <run-id>
paper-search citation status <run-id>
```

The canonical/MCP names are `citation_expand` for plan, run, and resume, and
`citation_run_status` for inspection. `citation_expand` is also a supported
batch row tool.

## Inspect transparent assessment evidence

Assessment consumes an explicit local observation snapshot and requires the
exact lowercase SHA-256 of its bytes. This checksum-bound input makes the
evidence set replayable and prevents a changed snapshot from being evaluated
under an old identity.

```bash
paper-search assess plan \
  --snapshot ./observations.json \
  --sha256 <64-character-lowercase-sha256>

paper-search assess run \
  --snapshot ./observations.json \
  --sha256 <64-character-lowercase-sha256> \
  --policy ./policy.json

paper-search assess show <run-id>
paper-search assess list
```

Reports preserve observation source, version, observation time, coverage state,
raw-evidence digest, conflicts, and missing signals. Without a policy, there is
no disposition. An optional named policy may produce `include`, `exclude`, or
`review` with a trace to exact rules and observations; missing or conflicting
required evidence remains reviewable. Paper Search does not publish a universal
quality score, decide scientific truth, or alter discovery ranking and
deduplication.

The canonical/MCP names are `assessment_run`, `assessment_show`, and
`assessment_list`. `assessment_run` is also a supported batch row tool.

## Keep networked PDF and extraction work in providers

Core plans storage, records, provenance, and containment-safe writes. Installed
material providers own source-specific identifier resolution, network download,
and extraction:

```bash
paper-search providers list-installed --kind material --json
paper-search artifact download <item-id-or-url-or-doi> --dry-run --json
paper-search extract <artifact-id-or-path-or-url> --dry-run --json
paper-search material ingest <input> --dry-run --json
```

A DOI can be projected to candidate URLs only through an installed
`artifact_resolver` provider. Bytes are acquired through a downloader provider,
and Markdown, structured output, or assets are produced through an extractor
provider. The compatibility commands `resource-pdf`, `resource_pdf`, and `pdf`
use the same provider-mediated artifact path; they do not restore a core HTTP
download fallback.

`material ingest <local-file>` is the durable local-file path: it copies the
source into `storage.artifactRoot`, records its storage reference and digest,
then passes the managed artifact to an extractor that advertises `artifact`
input support. The caller's source file is not changed. In contrast, direct
`extract <local-file>` reads the supplied path without adding a managed
artifact copy.

Paper Search reports technical provider prerequisites and provenance. It does
not decide licensing, entitlement, legality, or jurisdiction for the user.

## Export bibliographic data to Zotero explicitly

Zotero is optional. Paper Search remains usable without it, and local workspace
records and material files remain authoritative. The Zotero sink is a CLI-only
host write; it is not a canonical tool, MCP operation, batch row, workspace
default, or automatic search/material side effect.

```bash
# Local plan: no remote request and no write
paper-search zotero sink <item-id>

# Remote dry-run preview: no Zotero write
paper-search zotero sink <item-id> --preview

# Apply only with the exact preview digest
paper-search zotero sink <item-id> --apply --ack <preview-digest>
```

The sink may create one bibliographic item, render one selected local extraction
as a child note, and add the item to one existing collection. It does not create
collections or import PDF, Markdown, JSON, or asset attachments. Unsupported
metadata and local files are reported as omissions. If the endpoint is
unavailable, the configured `zotero.unavailable = "error" | "warn"` policy
applies and the result states that no Zotero write occurred.

Multi-step Zotero writes are not atomic. Partial completion reports the created
item key and failed phase; Paper Search does not automatically retry or roll it
back.

## Canonical tools and surface boundaries

The current canonical catalog is:

```text
mcp_help
academic_search
resource_lookup
patent_search
patent_detail
web_search                    # only when External Search v1 is configured
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

Use `paper-search tools --json` as the live authority. Applied run pruning,
run export/pin/unpin, and Zotero writes remain CLI-only.
