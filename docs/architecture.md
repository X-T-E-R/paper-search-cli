# Architecture

`paper-search-cli` is organized around one rule: the CLI, MCP server, batch
runner, provider runtimes, and companion skill share the same capability and
result contracts. Human-facing commands are adapters over those contracts.

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
   - built-in web backend router for Tavily, Firecrawl, Exa, xAI, and MySearch
     Proxy
3. **Entry surfaces**
   - CLI commands for humans
   - canonical tool catalog for deterministic tool calls
   - `run <canonical_tool>` for schema-validated single-tool execution
   - MCP JSON-RPC server for AI clients
   - companion skill for capability routing and workflow discipline
   - batch runner over the same canonical tools and result envelope
4. **Storage and sinks**
   - local workspace records under the configured workspace root
   - artifact and extraction records for material workflows
   - attachment sink for `resource-pdf` compatibility
   - workspace export sink for JSON, JSONL, CSV, and BibTeX
   - no host-application bridge or profile writer in this system

## Capability Contract

The capability map is the stable top-level routing contract. Commands and tools
are projections of these eight groups:

| Capability | Layer | Contract |
| --- | --- | --- |
| `discover` | work | Search academic, patent, and web sources. |
| `identify` | work | Resolve known identifiers, URLs, or provider-native ids to normalized metadata. |
| `assess` | work | **Reserved** — rank, dedupe, and report source/journal metrics (no canonical tools; see [ADR-0003](./decisions/ADR-0003-assess-capability-group-disposition.md)). |
| `acquire` | work | Fetch or record artifacts with provenance and attempt history. |
| `extract` | work | Turn artifacts, URLs, or files into Markdown, JSON, or assets. |
| `organize` | work | Store, tag, collect, and export workspace records. |
| `orchestrate` | work | Run multi-step workflows over primitives. |
| `operate` | management | Inspect readiness/config, manage providers, and run server surfaces. |

`operate` is the only management-layer group. This keeps commands such as
`doctor`, `config`, `providers`, `tools`, `help`, and `mcp serve` out of the
research/material workflow path.

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
```

The default provider kind is `search` for `providers`. The
`material-providers` command is a compatibility alias with default kind
`material`.

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

Web search and web research are built-in API backend adapters rather than
provider packages. They use TOML `[api.*]` config sections or matching
environment variables.

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
- provider-scoped cache
- policy metadata
- controlled workspace writes when the manifest permits them

Core owns orchestration, records, validation, and workspace storage. Networked
acquisition/extraction logic belongs in provider packages.

### Material Provider Distribution

Distributable material packages are published from the separate
[`material-providers`](https://github.com/X-T-E-R/material-providers)
repository (see
[ADR-0002](./decisions/ADR-0002-material-provider-distribution-channel.md)),
so search packages remain in the independent `resource-search-providers`
registry. Its existing provider entries remain backward compatible, while an
optional inventory section classifies countable sources, source-backed views,
aliases, service families, source domains, content kinds, access classes,
default aggregate membership, and retained-unpublished entries. Installed
manifests freeze this metadata for runtime selection; a mutable registry can
change catalogue display but cannot silently change the behavior of an already
installed package. Provider enablement remains a hard runtime switch, while the
layered `[search.selection]` policy controls only `platform=all`.
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

Artifact bytes, when stored, live under `material/files/<artifact-id>/`.
Artifact records live under `material/artifacts/<artifact-id>.json`.

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

Extraction records live under `material/extractions/<extraction-id>.json`.
Generated Markdown and structured provider output live under
`material/extractions/<extraction-id>/`.

## Command Semantics

### Discovery and Identification

- `tools` returns the canonical tool catalog used by CLI and MCP mappings.
- `help` returns provider-aware local help snapshots.
- `platform-status` reports installed provider health and web backend readiness.
- `lookup` normalizes DOI, PMID, arXiv ID, ISBN, and URL metadata.
- `patent` and `patent-detail` expose patent search/detail over installed
  providers.
- `web` and `web-research` use configured web API backends.

### Workspace and Export

- `resource-add` writes normalized item records into `items/*.json`.
- `resource-pdf` downloads or records PDF attachments for existing workspace
  item ids and remains available as `pdf`.
- `collection-list` reads the local collection tree from `collections.json`.
- `workspace-export` writes portable JSON, JSONL, CSV, or BibTeX.
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
  extraction.
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
