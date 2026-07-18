# Paper Search CLI X architecture

Paper Search CLI X is organized around one rule: the CLI, MCP server, batch
runner, provider runtimes, and companion skill share the same capability and
result contracts. Human-facing commands are adapters over those contracts.
The X describes extensibility and open possibilities; existing machine-facing
names remain compatible.

## Main Layers

1. **Core config and contracts**
   - layered TOML config and `PAPER_SEARCH_*` environment overrides
   - capability map in `src/surface/capabilities.ts`
   - unified `ResultEnvelope` in `src/surface/resultEnvelope.ts`
   - shared dry-run/plan envelope in `src/surface/plan.ts`
   - provider manifest validation and registry URL expansion
   - smoke-test policy and explicit live-check gates
2. **Provider runtimes**
   - search-provider runtime compatible with `resource-search-providers`
   - material-provider runtime for artifact downloaders and extractors
   - one management surface: `providers --kind search|material`
   - compatibility alias: `material-providers` maps to `providers --kind material`
   - session-aware `withCredentials` cookie transport for login-gated search
     providers
   - optional generic External Search v1 child-process boundary
3. **Entry surfaces**
   - CLI commands for humans
   - canonical tool catalog for deterministic tool calls
   - `run <tool>` as the durable CLI projection of canonical `research_run`
   - MCP JSON-RPC server for AI clients
   - companion skill for capability routing and workflow discipline
   - batch runner over the same canonical tools and result envelope
4. **Storage and sinks**
   - one conventional user home at `~/.paper-search/`
   - independently configurable workspace, artifact, extraction, export, and
     durable-run roots
   - provider-mediated artifact acquisition for `resource-pdf` compatibility
   - portable workspace export sink for JSON, JSONL, CSV, and BibTeX
   - no general host-application bridge or profile writer; the bounded Zotero
     MCP Neo selected-item projection is the exception defined by
     [ADR-0005](./decisions/ADR-0005-selected-resource-zotero-projection.md)

## Product boundary

Paper Search owns discovery, identifier resolution, citation traversal,
transparent assessment, normalized machine output, provider provenance, and
search history. It does not own a research project's schema or long-lived
catalog. Paperflow owns workspace creation, semantic path roles, and
research-runtime invariants. A project-side bibliography/catalog workflow owns
selected literature.

Integration uses a generated config and shared path-role contract. Paper Search selects the
nearest ancestor `paper-search.toml` and writes one run to its configured
`runs.root`; it never imports Paperflow modules or reads `paperflow.yaml`.
Paperflow generates that TOML so run, selected-workspace, artifact, extraction,
and export roots match its roles, then reads the validated run files directly.
Global state keeps only a run locator, not a duplicate payload. Mounted history
is not automatic catalog/evidence promotion. A successful download selects by
default, while Paperflow evidence verification remains a later state.

## Conventional home and storage classes

`PAPER_SEARCH_HOME` may select an explicit absolute home. Otherwise all
conventional config, credentials, subscriptions, adapters, provider packages,
registry snapshots, caches, state, runs, workspace records, material outputs,
exports, and managed shims derive from `~/.paper-search/`. Platform config roots
are inspected only as copy-migration sources.

The default path classes are distinct:

- `workspace/` owns local bibliographic and material metadata records;
- `storage/artifacts/` owns acquired bytes such as PDFs;
- `storage/extractions/` owns Markdown, structured output, and assets;
- `exports/` owns explicit managed portable exports written with
  `workspace-export --store`; and
- `runs/` owns global execution history and checkpoints when no context exists.

A standalone or Paperflow project context may choose all five roots.
Nearest-ancestor discovery affects the project configuration layer, while the
conventional user home remains the authority for credentials, providers, state,
and locators.

`workspace.root`, `storage.artifactRoot`, `storage.extractionRoot`,
`storage.exportRoot`, and `runs.root` can be configured independently. Changing
a root affects future writes. Versioned local storage references capture the
resolved root and contained key; legacy workspace-relative `path` fields keep
their existing meaning.

## Durable runs

Real discovery through friendly CLI, canonical/MCP, and batch surfaces is
durable by default. `runs.recordByDefault = false`, a direct CLI/batch
`--no-history`, or canonical/MCP `recordHistory: false` is the explicit opt-out.
`run <tool>` and canonical/MCP `research_run` remain the always-durable wrapper
over the fixed non-destructive discovery allowlist:
`academic_search`, `patent_search`, `resource_lookup`, `patent_detail`, and the
optional `web_search`. Citation and assessment workflows are intrinsically
durable when run rather than planned.

The common run store persists sanitized request, resolved selection,
timestamps, diagnostics, provenance, failures, and terminal results or
references. A context run exists only in its selected root; the user-level state
stores a bounded run-id locator so `run_show` can find it from another context.
Citation runs also persist checkpoints. `runs.maxAgeDays = -1`
means age alone never selects a run for pruning. Pruning is explicit and
plan-first; active, interrupted-resumable, corrupt, and pinned records are not
age-prune candidates.

Canonical/MCP exposes `run_list`, `run_show`, and plan-only `run_prune_plan`.
Run export, pin/unpin, and applied pruning remain CLI-only. Durable history is
private local plaintext and may be retained indefinitely with the default.
Plans and dry-runs do not create history. An already-durable wrapper invokes the
canonical executor through an internal bypass so one search creates one record.

## Optional Zotero boundary

Paper Search local workspace and material records remain authoritative. The
Zotero projection separates user-owned connection settings from project binding
policy. A project may inherit global selected-item defaults, disable projection,
or bind to multiple exact existing collections. Search hits do not write to
Zotero. Explicit workspace selection and successful downloads may project when
durably configured; host failure leaves a pending receipt without reversing the
local operation.

The adapter creates or updates a mapped bibliographic item, can render one
selected extraction as a note, and may link/import durable artifact or Markdown
files through Zotero MCP Neo. It never creates collections. The explicit
`zotero sink` plan/preview/digest-acknowledged apply flow remains available.
Mappings and complete/partial/pending receipts live under the Paper Search
workspace root. Partial remote completion is not automatically rolled back.

## Capability Contract

The capability map is the stable top-level routing contract. Commands and tools
are projections of these eight groups:

| Capability | Layer | Contract |
| --- | --- | --- |
| `discover` | work | Search academic, patent, and web sources. |
| `identify` | work | Resolve known identifiers, URLs, or provider-native ids to normalized metadata. |
| `assess` | work | Evaluate checksum-bound observations, preserve conflicts/provenance, and optionally apply an explicit traceable user policy. |
| `acquire` | work | Fetch or record artifacts with provenance and attempt history. |
| `extract` | work | Turn artifacts, URLs, or files into Markdown, JSON, or assets. |
| `organize` | work | Compatibility storage/export surfaces; project records belong to external bibliography/catalog tools that may resolve Paperflow roles. |
| `orchestrate` | work | Run durable discovery, citation expansion, and multi-step workflows over primitives. |
| `operate` | management | Inspect readiness/config/runs, manage providers, and run server surfaces. |

`operate` is the only management-layer group. This keeps commands such as
`doctor`, `config`, `providers`, `tools`, `help`, and `mcp serve` out of the
research/material workflow path.

### Citation expansion

`citation_expand` plans, starts, or resumes bounded backward/forward traversal
from exact identifiers. Repeated graph-capable providers use union semantics.
Core normalizes identities, deduplicates nodes and edges, retains per-edge
provider provenance, detects cycles, and applies depth, breadth, node, edge,
page, and concurrency bounds. A plan performs no provider calls or writes; a run
checkpoints each valid provider page in the common run store; resume continues
remaining work after checkpoint and provider-drift validation.

`citation_run_status` reads a stored checkpoint without calling providers.
`citation_expand` is also a supported batch row tool. Citation results are not
automatically added to the workspace.

### Transparent assessment

`assessment_run` evaluates an immutable local observation snapshot bound to its
exact SHA-256. It preserves source/version/time, coverage outcomes, raw-evidence
digests, conflicts, missing signals, and an optional user-policy trace. Without
a policy there is no disposition. A policy can return `include`, `exclude`, or
`review`, but cannot be presented as a universal quality score or automatic
acceptance decision.

`assessment_show` replays a completed assessment from stored evidence, and
`assessment_list` lists assessment-run headers. Assessment does not rerank or
deduplicate discovery results. See [ADR-0003](./decisions/ADR-0003-assess-capability-group-disposition.md).

## Result Envelope Contract

Every capability command and canonical tool returns the same machine contract:

```ts
interface ResultEnvelope<T> {
  ok: boolean;
  capability: CapabilityGroup;
  tool: string;
  planned?: boolean;
  data: T | null;
  diagnostics?: ResultDiagnostics;
  warnings?: string[];
  errors?: string[];
  provenance?: ResultProvenance;
}
```

The fields have these responsibilities:

- `ok`: whether the command/tool succeeded
- `capability`: one of the eight capability groups
- `tool`: canonical tool name, even when a CLI alias invoked it
- `planned`: `true` for dry-run/plan output that performs no writes or live
  network calls
- `data`: capability-specific payload, or `null` on failure
- `diagnostics`: counts, elapsed time, target ids, workspace roots, failed
  sources, and other operational details
- `warnings`: non-fatal problems that the caller may act on
- `errors`: failure messages for `ok: false`
- `provenance`: provider ids, policy names, config paths, registry sources, and
  other reproducibility metadata

This contract lets CLI, MCP, batch, docs, and skills parse one shape rather than
maintaining command-specific output checklists.

## Provider Runtime Model

`providers` is the management command family for both runtimes:

```bash
providers list-installed --kind search
providers list-installed --kind material
providers inspect-package <path> --kind search
providers inspect-package <path> --kind material
providers validate-manifest <path> --kind search
providers validate-manifest <path> --kind material
providers plan-registry <source> --kind material
providers sync-registry <source> --kind material
providers install-zip <zip> --kind material
providers uninstall <id> --kind material
providers rollback <id> --kind material --revision <sha256>
```

The default provider kind is `search` for `providers`. The
`material-providers` command is a compatibility alias with default kind
`material`.

Manual ZIP ownership transitions are explicit. A subscription-bound target is
rejected unless `--replace-bound` is present; the plan pins its receipt/source
and installed revision. Successful replacement or uninstall retains the exact
prior provider directory below the kind-specific hidden rollback store. The
emitted revision is the only selector accepted by `providers rollback`, which
uses compare-and-swap preconditions and retains any displaced current revision.

### Search Providers

Search providers use the `resource-search-providers` package contract. The
runtime loads provider packages, validates `manifest.json`, exposes search and
detail methods through a Node compatibility API, and supports authenticated
providers through session-aware cookie transport.

Search-provider bundles are trusted extensions that execute in the CLI process.
The Node `vm` wrapper supplies a compatible global namespace; it is not a
security sandbox for hostile JavaScript. Install search providers only from a
trusted registry or archive. Manifest URL permissions, config allowlists,
required-credential checks, HTTP status handling, and rate limits constrain the
supported provider API, but they do not turn untrusted code into safe code.

Registry installs bind the archive to the planned provider id, version, SHA-256,
and minimum CLI version before an existing provider is replaced. ZIP entry paths
are validated for traversal and case-insensitive collisions. Registry planning
and installed-provider listing are read-only and do not create the install
directory.

Search provider entrypoints include:

- `academic` / `academic_search`
- `patent` / `patent_search`
- `patent-detail` / `patent_detail`
- provider management commands with `--kind search`

Generic `web_search` is an optional process capability. Execution authority is
loaded only from the conventional user config root's `external-search.toml`.
Native tools receive one v1 JSON request on stdin; trusted custom adapters run
in a bundled Node child host and are never imported by the main process.

### Material Providers

Material providers use a separate manifest and runtime because they need
artifact, extraction, cache, workspace-write, and permission contracts that are
not part of search providers.

Material provider manifests declare:

- `kind`: `artifact_resolver`, `artifact_downloader`, `extractor`, `converter`,
  or `enricher`
- `entry`: provider script entrypoint
- `capabilities.inputs`, `inputTypes`, `identifierSchemes`, `outputs`, and
  `network`
- `configSchema` for provider config and secrets
- `permissions.network`, `localRead`, and `localWrite`
- optional `rateLimit` and integrity metadata

Resolver providers (`artifact_resolver`) accept `identifier` inputs (DOI
first), return ordered candidate locations as link metadata only, and never
fetch artifact bytes; byte download stays in downloader providers.

The material runtime gives providers controlled access to:

- redacted config reads
- permission-checked HTTP transport
- bounded ZIP-to-Markdown reading for extractor result archives
- provider-scoped cache
- policy metadata
- controlled workspace writes when the manifest permits them

Core owns orchestration, records, validation, and workspace storage. Networked
acquisition/extraction logic belongs in provider packages.

Binary HTTP responses must declare a decoded-byte limit. Result-archive readers
also enforce archive and Markdown limits, safe entry paths, entry-count bounds,
and a deterministic preferred Markdown entry before returning text to a
provider.

### Material Provider Distribution

Distributable material packages are published from the separate
[`material-providers`](https://github.com/X-T-E-R/material-providers)
repository (see
[ADR-0002](./decisions/ADR-0002-material-provider-distribution-channel.md)),
so search packages remain in the independent `resource-search-providers`
registry. Its existing provider entries remain backward compatible, while an
optional inventory section classifies countable sources, source-backed views,
aliases, service families, source domains, content kinds, access classes,
legacy `defaultInAll` membership, and retained-unpublished entries. Installed
manifests freeze this metadata for runtime selection; a mutable registry can
change catalogue display but cannot silently change the behavior of an already
installed package.

The shared selection resolver expands built-in and user presets, inventory
classifications, aliases, exact source selectors, and exclusions into canonical
provider ids. Academic commands default to the `general` preset, patent
commands default to `patents`, and literal `all` selects only runnable installed
non-view sources without consulting legacy `defaultInAll`. Readiness is
evaluated after taxonomy membership for presets: uninstalled, invalid,
disabled, or unconfigured members remain visible and are reported as skipped.
Validated active subscription snapshots provide classification for uninstalled
catalogue entries, while an installed manifest remains authoritative for an
installed package. CLI commands, canonical tools, MCP calls, `platform-status`,
and `search-plan` consume this resolver.

Layered TOML stores command defaults, user `tag:*` classifications, user
presets, hard enablement, and provider configuration. Named tag/preset
definitions are atomic across layers, while explicit `extends` owns preset
composition. Each main non-secret config file may have a lexically ordered
adjacent fragment directory (`config.toml` + `config.d/*.toml`, for example)
using the same schema and precedence rules.
Known aliases written through `config set` are canonicalized at the persistent
config boundary; unknown ids remain portable for subscriptions that are not
active locally.
Material `registry.json` entries carry `id`, `version`, `kind`, `downloadUrl`,
`sha256`, and `minCliVersion`. The registry loader reads `minPluginVersion` as
a compatibility alias mapped to the same min-version gate. The loader accepts
local registry JSON and exact HTTPS `registry.json` URLs; local entries may use
`packagePath`, `archivePath`, or `archiveRef`, while published entries use
`downloadUrl`. Installation flows through subscription-bound `providers
install`/`providers update`, or the compatibility `providers install-zip` and
`providers plan-registry`/`sync-registry` commands. Registry-level `sha256`,
manifest identity, and the `minCliVersion` gate are enforced before replacement.

## Material Data Flow

The material workflow is:

```text
resource metadata or input -> artifact acquisition/recording -> extraction -> export or workflow use
```

Artifacts and extractions are durable workspace records. They can be standalone
or linked to a workspace item.

### Identifier Resolver Funnel

`artifact download` and `material ingest` accept a DOI identifier as input in
addition to URLs and workspace item ids. Identifier inputs are resolved through
an installed `artifact_resolver` provider before the download path runs:

1. Select the resolver: `--resolver <id>` on the CLI, or
   `resolverId`/`resolver_id` on the `artifact_download` canonical tool;
   without a selection the first usable installed resolver is used.
2. The resolver returns ordered candidate locations (URL plus license, version,
   host, and content-type metadata) with provenance.
3. The existing download path tries each candidate in order until one succeeds.

Dry-run plans include `load-resolver` and `run-resolver` steps before the
download steps. Resolver failures are typed as `no_resolver` (no usable
resolver installed), `no_candidates` (the identifier resolved to no locations),
or `resolver_error`, with resolver attempts preserved in envelope diagnostics.

### Artifact Records

An `ArtifactRecord` represents a file or URL snapshot that entered the
workspace through download, a resolver, or user-supplied input.

Important fields:

- `id`, `kind`, and `status`
- optional `itemId` workspace link
- `filename`, `contentType`, `path`, `remoteUrl`, and `sizeBytes`
- `provenance.origin`, `sourceUrl`, `providerId`, `policy`, and `resolvedFrom`
- `provenance.resolverProviderId` and `resolverSource` for DOI-resolved
  acquisitions
- `attempts[]` entries with tier, source, provider id, success, status, message,
  and timestamp, including `artifact-resolver` tier attempts and per-candidate
  download attempts for resolved acquisitions

Artifact records live under the workspace root at
`material/artifacts/<artifact-id>.json`. New artifact bytes use the configured
`storage.artifactRoot` and a versioned local storage reference that captures its
root, contained key, and digest/size when available. Legacy record paths retain
their original workspace-relative meaning.

When `material ingest` receives a local file, it preserves the caller's file,
copies the bytes into the configured artifact root, commits the versioned
storage reference, and then addresses the managed artifact by id for extraction.
Direct `extract <path>` remains path-based and does not create an artifact.

### Local PyMuPDF4LLM Sidecar

`local-pymupdf4llm` is an explicit-only material extractor for `local_file` and
managed `artifact` PDF inputs. The provider VM receives no process primitive.
Instead, the host runtime authorizes the one resolved input path and exposes a
single `sidecar.pymupdf4llm.toMarkdown({ ocr, timeoutMs })` operation only to
that exact provider id and manifest permission shape. The provider cannot send
a path, executable, script, argument list, working directory, or environment.

The host resolves a versioned Python 3.11 executable below the Paper Search
home and a packaged adapter next to the CLI bundle. It starts those two fixed
paths with `shell: false`, sends one bounded JSON request on stdin, accepts one
bounded JSON response on stdout, applies a deadline, and empties inherited
environment values before adding only Python encoding, runtime temp, disabled
proxy, and Windows loader variables. The adapter calls the official
`pymupdf4llm.to_markdown()` API with image output disabled and the
`lines_strict` table strategy. It reports parser versions, page count, elapsed
time, output mode, and sanitized warnings; it never emits image assets or links.

The dependency lock contains `pymupdf4llm 0.3.4`, `PyMuPDF 1.27.2.3`, and
`tabulate 0.10.0`. The first two packages are dual licensed under GNU AGPL 3.0
or an Artifex commercial license. The optional `pymupdf-layout` extension has a
different license and is not part of this runtime. OCR is not installed; an
explicit OCR request or unreadable embedded text produces `OCR_UNAVAILABLE`.
The provider declares `network: false` and is excluded from implicit extractor
selection, preserving existing online provider routing.

### Extraction Records

An `ExtractionRecord` represents derived output from an artifact, local file, or
URL.

Important fields:

- `id`, `source`, `backend`, and `status`
- backend `options`
- `outputs.markdownPath`, `outputs.jsonPath`, `outputs.assetsDir`, or inline
  Markdown
- `cacheHit`
- optional `itemId` workspace link
- optional provider message

Extraction records live under the workspace root at
`material/extractions/<extraction-id>.json`. New Markdown, structured provider
output, and assets use `storage.extractionRoot` and versioned local storage
references. Legacy record paths retain their original workspace-relative
meaning.

## Command Semantics

### Discovery and Identification

- `tools` returns the canonical tool catalog used by CLI and MCP mappings.
- `help` returns provider-aware local help snapshots.
- `platform-status` reports installed provider health and static external-search readiness.
- `lookup` normalizes DOI, PMID, arXiv ID, ISBN, and URL metadata.
- `patent` and `patent-detail` expose patent search/detail over installed
  providers.
- `web` uses the configured External Search v1 process; `web_research` was removed in 0.4.

### Workspace and Export

- `resource-add` writes normalized item records into `items/*.json`.
- `resource-pdf` acquires or records a PDF for an existing workspace item id
  through the installed material-provider path and remains available as `pdf`.
- `collection-list` reads the local collection tree from `collections.json`.
- `workspace-export` writes portable JSON, JSONL, CSV, or BibTeX. With no file
  option it writes to stdout; `--out` keeps its explicit caller-relative
  semantics; `--store <safe-relative-key>` writes atomically below
  `storage.exportRoot`, and `--store ... --dry-run` validates and reports the
  target without writing.
- Workspace mutations are serialized per root so concurrent batch adds do not
  corrupt collection state.
- `collections.json` is read fail-closed: malformed data or read errors are
  reported instead of being treated as an empty workspace. Updates use a
  same-directory temporary file followed by atomic rename.

### Material Workflows

- `artifact download <itemKey|url|doi>` creates an artifact record and
  optionally writes artifact bytes; DOI inputs go through the identifier
  resolver funnel and accept `--resolver <id>`.
- `artifact list` and `artifact show` inspect artifact records.
- `extract <artifactId|path|url>` produces extraction records and output files.
- `material ingest <path|url|itemKey|doi>` plans or runs acquisition plus
  extraction. A local path is copied into managed artifact storage before the
  extractor receives it as an artifact.
- `material status <itemKey|artifactId|extractionId>` reports related artifacts
  and extracted outputs.
- `batch` can run `artifact_download`, `extract`, and `material_ingest` rows and
  writes one envelope per row.

Dry-run is cross-cutting. Commands that may write or use a provider report a
planned envelope with selected policy/provider, intended steps, and target paths
when run with `--dry-run` or when registry sync is invoked without `--apply`.

## MCP Semantics

The MCP server is an adapter over the same core functions as the CLI:

- `tools/list` reads the shared canonical tool catalog and capability
  annotations.
- `tools/call` returns MCP text content containing the JSON result from the
  matching core operation; failed result envelopes set MCP `isError: true`.
- Tool definitions are static for a server process, so initialization advertises
  `tools.listChanged: false`.
- The HTTP mode uses `/mcp`, `/mcp/help`, `/mcp/status`, and `/ping` as a
  project-specific JSON-RPC bridge. It is not a complete MCP HTTP+SSE transport;
  use stdio for standards-based MCP clients until that transport is implemented.
- stdio transport accepts line-delimited JSON-RPC messages for local clients.
- MCP calls inherit TOML/env config, provider runtimes, workspace semantics,
  result envelopes, and smoke boundaries from direct CLI commands.

## Test and Live-Check Boundaries

The default test chain is deterministic and offline. It uses local provider
fixtures, temporary config files, stubbed web/search/material transport, and
workspace temp directories.

Live provider, web, registry, credentialed, and third-party download checks are
smoke checks. They run only when an explicit gate such as
`PAPER_SEARCH_RUN_SMOKE=1` is set.

## Git Layout

- This repository owns the CLI implementation, docs, tests, companion skill,
  installer, and `system.yaml` metadata.
- Search and material provider packages live in independent repositories and
  publish separate registries.
- Cross-repository release checks clone the three repositories as sibling
  directories and pin each provider repository to a reviewed commit.
