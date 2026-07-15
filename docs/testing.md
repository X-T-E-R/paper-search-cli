# Testing

The default test chain is fast, deterministic, and offline. Tests use temporary
config files, local provider fixtures, stubbed transports, and workspace temp
directories. Live network, live registry, real credential, and expensive checks
are explicit smoke gates.

## Default Chain

Run the default chain from the repository root:

```bash
npm run typecheck
npm run test
```

The layer scripts are independently runnable:

```bash
npm run test:unit
npm run test:contract
npm run test:integration
```

The layers cover:

- `unit`: identifier detection, lookup normalization, external-search protocol/process/status logic,
  capability and envelope contracts, plan envelopes, tool argument parsing, MCP
  JSON-RPC behavior, batch task shaping/serialization, workspace and local
  storage references, durable-run retention/redaction, citation normalization,
  assessment policy traces, and smoke gating
- `contract`: search-provider manifest validation, material-provider manifest
  validation, package loading, registry planning/install contracts, runtime
  permission enforcement, session-aware provider behavior, and MinerU wrapper
  compatibility with offline stubs
- `integration`: CLI behavior with temporary config files, realistic command
  wiring, local registry/package fixtures, discovery/help flows, MCP HTTP server
  flows, lookup-to-add flows, patent detail-to-add flows, offline external-search
  search commands, provider-mediated `resource-pdf`, material artifact and
  extraction workflows, durable discovery, citation checkpoint/resume,
  checksum-bound assessment, home-path reporting, batch workflows, resumable
  JSONL output, workspace sink checks, and workspace export checks

## Surface Contract Coverage

Capability-surface tests assert the eight groups used by the CLI, MCP tools, and
skill: `discover`, `identify`, `assess`, `acquire`, `extract`, `organize`,
`orchestrate`, and `operate`. `operate` is expected to be the only management
layer group.

Envelope tests assert that command and tool results carry `ok`, `capability`,
`tool`, `data`, and optional `planned`, `diagnostics`, `warnings`, `errors`, and
`provenance` fields. Plan tests assert that dry-run envelopes set
`planned: true`, include selected policy/provider information, list intended
steps, and do not write workspace state.

Provider-kind integration tests exercise both runtimes through
`providers --kind search|material` and verify the `material-providers`
compatibility alias. Artifact and extraction storage tests round-trip records
with provenance, attempts, provider/backend ids, output paths, cache status, and
optional workspace item links.

Run-management tests must distinguish direct ephemeral discovery from
`research_run`, prove that `maxAgeDays = -1` selects nothing for age pruning,
and keep applied pruning, pin/unpin, export, and Zotero host writes at the
CLI-only boundary. Citation tests cover provider union, bounds, cycles, partial
failure, checkpoints, and resume. Assessment tests cover checksum mismatch,
missing/conflicting observations, no-policy output, and deterministic policy
traces without an implicit universal verdict.

## Provider Fixture Coverage

Search-provider tests use fixture packages under `tests/fixtures/provider-*` and
the moved local `resource-search-providers` source tree. Material-provider tests
use fixture packages under:

- `tests/fixtures/material-downloaders/fixture-artifact-downloader`
- `tests/fixtures/material-resolvers/fixture-artifact-resolver`
- `tests/fixtures/material-extractors/fixture-markdown-extractor`
- `tests/fixtures/material-provider-packages/mineru-extractor`
- `tests/fixtures/material-provider-registries/local`

The fixture artifact downloader does not call live `fetch`; it emits fixed bytes
and records the input URL as provenance. The fixture artifact resolver maps DOI
identifiers to ordered candidate locations without network access. The fixture
Markdown extractor reads the supplied source shape and emits deterministic
Markdown/JSON output. The MinerU fixture provider is exercised with mocked HTTP
responses unless a smoke gate is explicitly enabled.

Targeted material fixture checks:

```bash
npx vitest run tests/integration/artifact-download-command.test.ts
npx vitest run tests/integration/artifact-resolver-funnel.test.ts
npx vitest run tests/integration/unpaywall-resolver-funnel.test.ts
npx vitest run tests/integration/extract-command.test.ts
npx vitest run tests/integration/material-ingest-plan-command.test.ts
npx vitest run tests/integration/material-ingest-execution-command.test.ts
npx vitest run tests/integration/material-provider-mineru-distribution.test.ts
npx vitest run tests/integration/material-status-command.test.ts
npx vitest run tests/integration/provider-kind-command.test.ts
```

The resolver funnel tests cover the DOI identifier -> resolver -> ordered
candidate download path offline: `artifact-resolver-funnel` uses the fixture
resolver, and `unpaywall-resolver-funnel` wires the distributable unpaywall
package with stubbed transport end to end, including no-candidate failure
envelopes. `material-provider-mineru-distribution` installs the promoted
mineru package through local registry plan/sync and install-zip channels with
checksum and `minCliVersion` gates enforced.

The material ingest execution test proves the runnable fixture workflow: it
copies fixture providers into a temporary install directory, writes a temporary
`paper-search.toml`, runs URL and local-file ingestion, asserts artifact and
extraction records exist, verifies managed local-file bytes and storage refs,
and verifies extracted Markdown paths. The workspace command integration test
also covers managed export planning, collision rejection, and writes below a
configured `storage.exportRoot`.

## Offline CLI Fixture Example

This example mirrors the integration fixtures and does not require live network
access. Run it from the repository root after `npm run build`.

```bash
tmp="$(mktemp -d)"
mkdir -p "$tmp/providers" "$tmp/inputs"
cp -R tests/fixtures/material-downloaders/fixture-artifact-downloader "$tmp/providers/"
cp -R tests/fixtures/material-extractors/fixture-markdown-extractor "$tmp/providers/"
printf 'fixture source body\n' > "$tmp/inputs/paper.txt"

cat > "$tmp/paper-search.toml" <<EOF
[providers]
installDir = "$tmp/providers"

[workspace]
root = "$tmp/workspace"
defaultCollection = "Inbox"

[platform.fixture-artifact-downloader]
mode = "testing-docs"

[platform.fixture-markdown-extractor]
mode = "testing-docs"
EOF

node dist/cli.js --config "$tmp/paper-search.toml" providers list-installed --kind material --json

node dist/cli.js --config "$tmp/paper-search.toml" material ingest \
  https://example.test/files/article.pdf \
  --attach-to item-123 \
  --policy offline-fixture \
  --dry-run \
  --json

node dist/cli.js --config "$tmp/paper-search.toml" material ingest \
  https://example.test/files/article.pdf \
  --attach-to item-123 \
  --policy offline-fixture \
  --json > "$tmp/ingest.json"

node dist/cli.js --config "$tmp/paper-search.toml" extract \
  "$tmp/inputs/paper.txt" \
  --provider fixture-markdown-extractor \
  --json > "$tmp/extract.json"
```

Expected result shape:

- every command emits a `ResultEnvelope`
- material plans include `planned: true`, selected policy/provider, intended
  steps, and target paths
- executed material ingest writes artifact/extraction records below the
  workspace root, artifact bytes below the configured artifact root, and
  Markdown/JSON below the configured extraction root
- the example URL is metadata for the fixture provider; no live request is made

## Official Compatibility Probe

`npm run test:compat:official` builds the sibling provider repository, verifies
each registry SHA-256, and loads the actual generated ZIP archives from
`../resource-search-providers/dist`. It covers the complete 13-provider
published set: `arxiv`, `biorxiv`, `crossref`, `europepmc`, `medrxiv`,
`openalex`, `patentstar`, `pmc`, `pubmed`, `scopus`, `semantic`, `wos`, and
`zjusummon`.

The probe checks source-specific paging, query, parsing, credential, and detail
semantics with stubbed transport. Every provider also receives an HTTP 429 and
must reject the search instead of returning a successful empty result. No live
network calls are made. Use `--provider-root <path>` or
`PAPER_SEARCH_PROVIDER_SOURCE` only when testing another compatible provider
release tree containing `registry.json` and `dist/*.zip`.

Run the full release gate with:

```bash
npm run verify:release
```

This runs type checking, all Vitest layers, the 13-ZIP compatibility matrix, and
the ungated smoke command. The smoke command must report a skipped summary unless
`PAPER_SEARCH_RUN_SMOKE=1` is explicitly set.

## Smoke Gates

Smoke tests are not part of `npm test`. Running `npm run test:smoke` without a
gate exits successfully with a skipped summary.

To run live smoke cases, build first and enable the gate:

```bash
npm run build
PAPER_SEARCH_RUN_SMOKE=1 npm run test:smoke
```

The default live search cases are:

- `crossref-live`: bundles the local Crossref provider source and searches the
  live Crossref API.
- `arxiv-live`: bundles the local arXiv provider source and searches the live
  arXiv Atom API.

Additional selectable search-provider cases (not in the default list):

- `openalex-live`: live works search against `https://api.openalex.org/works`
  (optional `PAPER_SEARCH_SMOKE_OPENALEX_MAILTO`).
- `pmc-live`: live PMC search via NCBI E-utilities (optional
  `PAPER_SEARCH_SMOKE_PMC_EMAIL` / `PAPER_SEARCH_SMOKE_PMC_API_KEY`).
- `europepmc-live`: live Europe PMC REST search (no API key).

`run-smoke.mjs` resolves its default provider root to `../resource-search-providers`
relative to this repository. Use `--provider-root <path>` or
`PAPER_SEARCH_PROVIDER_SOURCE` when the compatible provider source tree lives
elsewhere.

Material-provider live checks follow the same rule: the default suite may
validate manifests, config, cache behavior, command shaping, and mocked result
parsing, but real network extraction or real credentials must stay behind an
explicit smoke gate. The selectable MinerU material case is not in the default
live case list:

```bash
PAPER_SEARCH_RUN_SMOKE=1 \
PAPER_SEARCH_SMOKE_CASES=material-mineru-live \
MINERU_TOKEN="<token>" \
PAPER_SEARCH_SMOKE_MINERU_URL="https://example.org/paper.pdf" \
npm run test:smoke
```

`MINERU_API_TOKEN` may be used instead of `MINERU_TOKEN`. Optional MinerU
configuration can be supplied with `MINERU_API_BASE` or `MINERU_ENDPOINT`;
`PAPER_SEARCH_SMOKE_MINERU_TIMEOUT_MS`, `PAPER_SEARCH_SMOKE_MINERU_POLL_INTERVAL_MS`,
`PAPER_SEARCH_SMOKE_MINERU_MODEL_VERSION`, `PAPER_SEARCH_SMOKE_MINERU_LANGUAGE`,
and `PAPER_SEARCH_SMOKE_MINERU_PAGE_RANGES`. By default the case loads
`tests/fixtures/material-provider-packages/mineru-extractor`; use
`--material-provider-package <path>` or `PAPER_SEARCH_SMOKE_MATERIAL_PROVIDER_PACKAGE`
for another compatible package. Without `PAPER_SEARCH_RUN_SMOKE=1`, selecting
`material-mineru-live` still prints the skipped smoke summary and performs no
build, credential, or network checks. With the gate enabled, missing MinerU
credentials or source URL are reported as configuration errors before the live
material provider is loaded.

The selectable `material-unpaywall-live` case resolves a DOI through the
distributable unpaywall resolver package against the live Unpaywall API:

```bash
PAPER_SEARCH_RUN_SMOKE=1 \
PAPER_SEARCH_SMOKE_CASES=material-unpaywall-live \
PAPER_SEARCH_SMOKE_UNPAYWALL_EMAIL="you@example.org" \
npm run test:smoke
```

`UNPAYWALL_EMAIL` may be used instead of `PAPER_SEARCH_SMOKE_UNPAYWALL_EMAIL`;
one of them is required when the gate is enabled and the case is selected, and
a missing email is reported as a configuration error before the provider
loads. Optional settings: `PAPER_SEARCH_SMOKE_UNPAYWALL_DOI` (default
`10.1038/nature12373`), `PAPER_SEARCH_SMOKE_UNPAYWALL_PROVIDER_PACKAGE` or
`--unpaywall-provider-package` (default `../material-providers/dist/unpaywall`
relative to this repository, produced by the `material-providers` build), and
`PAPER_SEARCH_SMOKE_UNPAYWALL_TIMEOUT_MS`. Without the gate, selecting the
case still emits the skipped summary.

## Documentation Checks

Documentation that describes the command surface should stay aligned with the
machine contracts. Before publishing command-surface docs, search README and
`docs/` for retired milestone wording and run `npm run typecheck` so examples
stay connected to the exported TypeScript contracts.
