# paper-search-cli

`paper-search-cli` is a standalone paper search and material workflow CLI. It
combines a local command surface, an MCP server, a companion skill, search
provider packages, and material provider packages under one capability-routed
contract.

Use it to search literature and web sources, normalize known identifiers, store
local workspace records, acquire artifacts, extract Markdown or structured
outputs, export workspace data, and expose the same operations to AI clients.

## Install from a retained checkout

Paper Search uses a source-linked installation: clone the repository and keep
that checkout in place. The installer builds a verified runtime in the checkout,
projects the bundled skill into one or more agent skill roots, and creates the
`paper-search` command for terminal use. It plans changes by default.

The installer requires Node.js 20 or newer and npm 10 or newer. The tested
package-manager release is declared in `package.json`.

Clone the official repository and run the installer from its root:

```bash
git clone https://github.com/X-T-E-R/paper-search-cli.git
cd paper-search-cli
node scripts/install.mjs
node scripts/install.mjs --apply
```

Without `--target`, the skill is projected to `~/.agents/skills`. Repeat
`--target` to install it for more than one agent, and use `--bin-dir` to choose
where the human CLI shim is created:

```bash
node scripts/install.mjs \
  --target ~/.agents/skills \
  --target ~/.codex/skills \
  --bin-dir ~/.local/bin

node scripts/install.mjs \
  --target ~/.agents/skills \
  --target ~/.codex/skills \
  --bin-dir ~/.local/bin \
  --apply
```

The installer reports whether the bin directory is on `PATH`; it does not edit
your environment. Once that directory is on `PATH`, use the human-facing shim:

```bash
paper-search --version
paper-search paths
paper-search self status
paper-search status --json
```

`paper-search setup` invokes the same plan-first installer to inspect or repair
the verified build, skill projections, and CLI shim. Add `--apply` only after
reviewing the plan. `self status` also reports the retained checkout's Git and
upstream state, selected bundle, source-management mode, projections, shims, and
any pending update recovery.

```bash
paper-search setup
paper-search setup --target ~/.agents/skills --target ~/.codex/skills --apply
```

### Manage the retained checkout

New installations default to `user-managed`: Paper Search never treats an
installer-owned checkout as permission to update its source. Inspect the mode or
review a mode-change plan before applying it:

```bash
paper-search self mode
paper-search self mode user-managed
paper-search self mode user-managed --apply
paper-search self mode self-update
paper-search self update
```

`self mode` and `self update` are plan-first. A write occurs only when the plan
passes its safety checks and you repeat the command with `--apply`. Self-update
requires an installer-owned, clean, attached checkout with a matching official
upstream and a fast-forward-only target; local-only or diverged commits block the
operation.

The production build seals its official origin to
`https://github.com/X-T-E-R/paper-search-cli.git` on `main`. Configuration
files, environment variables, and command-line flags cannot add or override an
origin. An SSH clone, fork, different branch, dirty checkout, or local-only
commit remains `user-managed`; update it with normal Git commands and then run
`paper-search setup`. An installer-owned clean clone using the exact HTTPS
origin may explicitly opt into `self-update` after reviewing the mode plan.

Agents should enter through the projected skill's local launcher,
`skills/paper-search-cli/scripts/paper-search.mjs`. Both that launcher and the
`paper-search` shim resolve back to the retained checkout, so no runtime is
copied into the skill directory.

### Repository development and debugging

Direct `node dist/cli.js ...` invocation is for work inside the repository, not
normal installed use. Contributors can build and probe the checkout with:

```bash
npm ci
npm run build
npm run check
node dist/cli.js status --json
node dist/cli.js tools --json
```

## Configure Paper Search

Run `paper-search config path --all` to show the conventional configuration
bundle:

- `config.toml` stores user-owned, non-secret runtime settings.
- `subscriptions.toml` stores user-owned trusted registry definitions and is
  validated separately from runtime settings.
- `credentials.toml` optionally stores plaintext credentials with restricted
  filesystem access. It is not encrypted, so use environment variables instead
  when plaintext-at-rest is unsuitable.

Only `config.toml` is required. An example lives at
[`paper-search.example.toml`](./paper-search.example.toml). Project settings are
read from `paper-search.toml` and `.paper-search.toml` in the current directory;
if both exist, they are merged in that order and the CLI reports a compatibility
warning. `--config <path>` selects an additional explicit config file (or a
directory containing `config.toml`).

Effective values use this precedence, from lowest to highest:

1. built-in defaults
2. user `config.toml`
3. project config
4. explicit `--config`
5. user `credentials.toml` for credential keys
6. `PAPER_SEARCH_*` environment variables
7. command-specific flags, where a command provides them

Project and explicit config may override ordinary runtime values but are not
promoted into trusted subscriptions. Use `paper-search config explain <key>` to
see the winning value and origin, and `paper-search config validate` to validate
the conventional, project, and explicit files against their owning schemas.

Use dedicated credential commands instead of generic `config set`:

```bash
printf '%s' "$TAVILY_API_KEY" | paper-search config credentials set api.tavily.apiKey --stdin
paper-search config credentials set api.tavily.apiKey --from-env TAVILY_API_KEY
paper-search config credentials get api.tavily.apiKey
paper-search config credentials unset api.tavily.apiKey
```

Credential values are never accepted as positional arguments, and `get` masks
stored values. `config import-env` also plans by default: it classifies supported
entries, routes non-secrets to `config.toml` and secrets to `credentials.toml`,
and masks secrets in its output. Review the plan before applying it:

```bash
paper-search config import-env ./.env
paper-search config import-env ./.env --apply
```

Entries already set in the current shell are skipped, so importing a file does
not silently override the environment that currently wins.

### Search source selection

Provider enablement and aggregate selection are separate. `platform.<id>.enabled`
is a hard runtime switch. `[search.selection]` controls only which runnable
sources participate in `--platform all`; an explicitly named source bypasses
that aggregate policy but still must be installed, enabled, and configured.

```toml
[search.selection]
mode = "defaults" # or "allowlist"
includeIds = []
excludeIds = []
includeDomains = []
excludeDomains = ["biomedicine"]
includeContentKinds = []
excludeContentKinds = []
includeAccess = []
excludeAccess = ["institutional"]
```

Specific ids override classification rules, with `excludeIds` taking final
precedence. Arrays replace lower-precedence arrays rather than merging them.
The same settings can be written with `config set`, for example:

```bash
paper-search config set search.selection.excludeDomains '["biomedicine"]'
paper-search config set search.selection.includeIds '["pubmed"]'
paper-search config explain search.selection.excludeDomains
```

Reusable profiles need no second configuration system. Put ordinary files at,
for example, `<config-root>/profiles/general/config.toml` and
`<config-root>/profiles/biomed/config.toml`, then select one with
`paper-search --config <profile-directory> ...`.

Legacy single-file configuration and flat provider directories are migration
inputs, not a second supported write layout. `migrate` plans the config and
provider-directory work together, uses the same config transactions and provider
replacement checks as normal writes, and applies only with `--apply`:

```bash
paper-search migrate
paper-search migrate --apply
paper-search migrate --legacy-install-dir /path/to/custom/providers --apply
```

An explicit `--legacy-install-dir` is required before a custom/project/env
provider root may be moved. Migration never rewrites project configuration.

Manage more than one trusted registry through `registries`. Trust changes are
plans until `--apply`; `refresh` validates metadata and writes a digest-addressed
snapshot, but does not install or update providers:

```bash
paper-search registries add official-search https://github.com/X-T-E-R/resource-search-providers/releases/download/providers-registry-latest/registry.json --kind search
paper-search registries add official-search https://github.com/X-T-E-R/resource-search-providers/releases/download/providers-registry-latest/registry.json --kind search --apply
paper-search registries add official-material https://github.com/X-T-E-R/material-providers/releases/download/material-registry-latest/registry.json --kind material --apply
paper-search registries list
paper-search registries show official-search
paper-search registries refresh official-search
paper-search registries disable official-search --apply
```

Direct edits that change a subscription URL leave it `rebind-pending`. Use
`registries rebind` to reconfirm the canonical source or accept a new source
identity. Removing a subscription, or rebinding it to a different source
fingerprint, is blocked while bound provider receipts exist unless the explicit
`--orphan-dependents` acknowledgement is present.

Common environment overrides use `PAPER_SEARCH_*` names:

- `PAPER_SEARCH_PROVIDERS_INSTALL_DIR`
- `PAPER_SEARCH_WORKSPACE_ROOT`
- `PAPER_SEARCH_PLATFORM__PATENTSTAR__LOGIN_NAME`
- `PAPER_SEARCH_PLATFORM__PATENTSTAR__PASSWORD`
- `PAPER_SEARCH_API__TAVILY__API_KEY`
- `PAPER_SEARCH_API__FIRECRAWL__API_KEY`

## Capability Map

Every command and canonical tool belongs to one stable capability group. The
capability map is the routing contract used by the CLI, MCP tools, and companion
skill.

| Capability | What it does | Common entrypoints |
| --- | --- | --- |
| `discover` | Search academic, patent, and web sources with per-source diagnostics. | `academic`, `patent`, `web`, `web-research` |
| `identify` | Resolve a known identifier, URL, or provider-native id to normalized metadata. | `lookup`, `patent-detail` |
| `assess` | **Reserved** — rank, dedupe, and source/journal-level metrics (no shipped tools; promotion criteria in [ADR-0003](./docs/decisions/ADR-0003-assess-capability-group-disposition.md)). | — |
| `acquire` | Fetch or record artifacts with provenance and attempt history. | `artifact download`, `artifact list`, `artifact show`, `resource-pdf` |
| `extract` | Turn an artifact, URL, or file into Markdown, JSON, or assets through extractor providers. | `extract` |
| `organize` | Store, tag, collect, and export workspace records. | `resource-add`, `collection-list`, `workspace-export` |
| `orchestrate` | Run multi-step workflows over primitives. | `batch`, `material ingest`, `material status` |
| `operate` | Inspect readiness and config, manage registries/providers, and run the server surface. | `status`, `doctor`, `config`, `registries`, `providers`, `platform-status`, `tools`, `help`, `mcp serve` |

`operate` is a management layer. It is intentionally separate from research and
material work so readiness checks, configuration, provider management, and MCP
server operations do not look like literature tasks.

## Result Envelope

Machine-readable commands and canonical tools return a `ResultEnvelope`. Human
formatting may be layered on top, but AI clients and tests should parse this
shape:

```ts
interface ResultEnvelope<T> {
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

The envelope identifies the capability and canonical tool, marks dry-run output
with `planned: true`, carries the payload under `data`, and keeps operational
details in `diagnostics`, `warnings`, `errors`, and `provenance`. Provider ids,
policies, config paths, source counts, failed sources, elapsed time, and target
paths belong in these envelope fields instead of ad-hoc command output.

## Providers

The CLI manages two provider runtimes through one command family:

- **Search providers** are compatible with the `resource-search-providers`
  package contract and power academic and patent search/detail commands.
- **Material providers** acquire artifacts or extract material outputs. Resolver
  providers (`kind: "artifact_resolver"`) turn identifiers such as DOIs into
  ordered candidate download locations; downloader providers implement artifact
  acquisition; extractor providers produce Markdown, JSON, assets, or
  provider-specific files.

Use the subscription-bound commands for normal discovery, installation, and
updates:

```bash
paper-search providers available --json
paper-search providers available mineru --json
paper-search providers inventory --json
paper-search providers inventory ./registry.json --json
paper-search providers install mineru --json
paper-search providers install mineru --from official-material --apply --json
paper-search providers update --json
paper-search providers update mineru --apply --json
```

`providers available` reads only the validated current snapshots of active
subscriptions; it does not refresh a registry. `install` and `update` are plans
unless `--apply` is present. If more than one active subscription publishes the
same provider id, `install` requires `--from <subscription-id>`. Bound installs
require a publisher SHA-256 and pin the subscription identity, registry digest,
archive digest, package identity, and installed-state precondition in the plan.
Applying a stale plan is rejected. Updates follow the source recorded in the
installed receipt rather than switching to another registry that happens to
publish a newer version.

`providers inventory [source]` reads a search registry and reports separately
the number of selectable entries, independently counted sources, source-backed
views, aliases, service families, retained-unpublished entries, source types,
domains, content kinds, access classes, default aggregate membership, and legacy
entries without classification. Without `source`, it uses the configured search
registry URL. Views such as ACM over Crossref do not inflate the source count or
enter `--platform all`, but remain available by explicit id.

The catalogue describes endpoints and technical configuration; it does not make
jurisdiction-specific legality, licence, entitlement, or authorization decisions.
Users decide which sources to enable and which local laws, institutional agreements,
provider terms, and copyright rules apply to their use.

Bound packages use kind-separated directories under the configured provider
root: `search/<id>` and `material/<id>`. Provider ids remain globally unique
across both kinds. Existing flat packages remain readable as a compatibility
fallback, but writes and updates are blocked until `paper-search migrate` moves
them into the kind-separated layout.

Use `providers --kind search|material` for low-level inspection and compatibility
installation workflows:

```bash
paper-search providers list-installed --kind search --json
paper-search providers list-installed --kind material --json
paper-search providers inspect-package ./tests/fixtures/provider-packages/fixture-academic --kind search --json
paper-search providers inspect-package ./tests/fixtures/material-extractors/fixture-markdown-extractor --kind material --json
paper-search providers validate-manifest ./tests/fixtures/material-extractors/fixture-markdown-extractor/manifest.json --kind material --json
paper-search providers plan-registry ./tests/fixtures/material-provider-registries/local/registry.json --kind material --json
paper-search providers sync-registry ./tests/fixtures/material-provider-registries/local/registry.json --kind material --json
```

`material-providers` remains as a compatibility alias for
`providers --kind material`:

```bash
paper-search material-providers list-installed --json
paper-search material-providers inspect-package ./tests/fixtures/material-extractors/fixture-markdown-extractor --json
```

Registry sync is plan-first. `providers sync-registry` reports a planned
envelope by default; pass `--apply` only when you want to write provider changes.
`sync-registry` and `install-zip` are unbound compatibility workflows: their
receipts do not authorize subscription-bound updates.

Search-provider bundles are trusted extensions executed in the CLI process. The
compatibility `vm` wrapper is not a hostile-code sandbox; install search
providers only from registries or archives you trust. Registry id, version,
SHA-256, minimum-version, and ZIP-path checks protect release identity and
installation integrity, not against malicious provider code.

Distributable material packages are published from the separate
[`material-providers`](https://github.com/X-T-E-R/material-providers)
repository, as recorded in
[ADR-0002](./docs/decisions/ADR-0002-material-provider-distribution-channel.md).
Its `registry.json`
entries carry `id`, `version`, `kind`, `downloadUrl`, `sha256`, and
`minCliVersion`; the registry loader reads `minPluginVersion` as a
compatibility alias for the same min-version gate. The material registry loader
accepts both local files and exact HTTPS
`registry.json` URLs, including generated registries whose entries use
`downloadUrl` for local or HTTPS archives. Relative archive references are
resolved against the registry location. Use `providers plan-registry --kind
material` before `providers sync-registry --kind material --apply`; install a
standalone archive with `providers install-zip --kind material --apply`. GitHub
repository shorthand expansion remains a search-provider compatibility feature,
so material registries require the exact JSON URL.

## Search and Workspace Commands

```bash
paper-search academic "retrieval augmented generation"
paper-search patent "solid state battery" --platform patentstar --database CN --patent-type invention
paper-search patent-detail patentstar ANE123 --include legalStatus,claims,pdf
paper-search web "latest RAG evaluation benchmarks" --provider tavily --max-results 5
paper-search web-research "OpenAI API documentation updates" --mode docs --web-max-results 5 --scrape-top-n 2
paper-search lookup "10.1145/3366423.3380130"
paper-search resource-add --item-file ./search.json --index 0 --collection-path Research/Inbox --tags rag --json
paper-search resource-pdf <workspace-item-id> --url https://example.org/paper.pdf --filename paper.pdf --json
paper-search collection-list --flat --json
paper-search workspace-export --collection-path Research --include-children --out ./paper-search-export.bib --json
```

`lookup` is the recommended step before `resource-add` when you already have a
DOI, PMID, arXiv ID, ISBN, or URL. `patent-detail` is the recommended step
before `resource-add` when patent claims, legal status, PDF URLs, or image URLs
matter. `resource-pdf` and `pdf` remain compatibility entrypoints for local
workspace PDF attachments; new material workflows should prefer artifact and
extraction records.

## Artifact and Extraction Records

Material workflows store auditable records under the configured workspace root.

An artifact record describes a fetched, requested, resolved, or user-supplied
file/URL snapshot. It includes:

- `id`, `kind`, `status`, filename/content type, optional local path, optional
  remote URL, and size
- optional `itemId` linking the artifact to a workspace item
- `provenance` with origin, source URL, provider id, policy, and resolver link
- `attempts` with tier/source/provider/backend outcome, status, message, and
  timestamp

An extraction record describes Markdown, JSON, assets, or inline output derived
from an artifact, local path, or URL. It includes:

- `id`, `source`, `backend`, `status`, backend options, output paths, and
  `cacheHit`
- optional `itemId` linking the extraction to a workspace item
- optional message from the extractor
- output paths such as `material/extractions/<id>/content.md` and
  `material/extractions/<id>/result.json`

`artifact download` and `material ingest` also accept a DOI as input. The DOI
is resolved to ordered candidate locations through an installed
`artifact_resolver` provider — select one with `--resolver <id>` on the CLI or
`resolverId`/`resolver_id` on the `artifact_download` canonical tool — and each
candidate feeds the normal download path in order. Dry-run plans list the
`load-resolver` and `run-resolver` steps, resolver failures are typed as
`no_resolver`, `no_candidates`, or `resolver_error`, and resolved acquisitions
record `resolverProviderId` and `resolverSource` in artifact provenance.

```bash
paper-search artifact download 10.1038/nature12373 --resolver unpaywall --dry-run --json
```

Use these commands to inspect records:

```bash
paper-search artifact list --json
paper-search artifact list --item <workspace-item-id> --json
paper-search artifact show <artifact-id> --json
paper-search material status <workspace-item-id-or-artifact-id-or-extraction-id> --json
```

## Offline Material Fixture Workflow

The repository includes material provider fixtures that run without live network
access. The fixture downloader treats `https://example.test/...` as source
metadata and emits fixed bytes; the fixture extractor turns a local file,
artifact id, or URL into Markdown.

This developer fixture uses files from the checkout but runs them through an
installed `paper-search` command. Run the setup from the repository root:

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
mode = "docs"

[platform.fixture-markdown-extractor]
mode = "docs"
EOF
```

Plan and execute URL ingest through both fixture providers:

```bash
paper-search --config "$tmp/paper-search.toml" material ingest \
  https://example.test/files/article.pdf \
  --attach-to item-123 \
  --policy docs-safe \
  --dry-run \
  --json

paper-search --config "$tmp/paper-search.toml" material ingest \
  https://example.test/files/article.pdf \
  --attach-to item-123 \
  --policy docs-safe \
  --json > "$tmp/ingest.json"
```

Acquire an artifact and extract a local file:

```bash
paper-search --config "$tmp/paper-search.toml" artifact download \
  https://example.test/files/article.pdf \
  --attach-to item-123 \
  --policy docs-safe \
  --json > "$tmp/artifact.json"

artifact_id="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).data.record.id)" "$tmp/artifact.json")"
paper-search --config "$tmp/paper-search.toml" artifact show "$artifact_id" --json

paper-search --config "$tmp/paper-search.toml" extract \
  "$tmp/inputs/paper.txt" \
  --provider fixture-markdown-extractor \
  --json > "$tmp/extract.json"

paper-search --config "$tmp/paper-search.toml" material status "$artifact_id" --json
```

The generated workspace contains artifact records under `material/artifacts/`,
artifact bytes under `material/files/`, extraction records under
`material/extractions/*.json`, and extracted Markdown/JSON under
`material/extractions/<extraction-id>/`.

## Batch and Precise Tool Calls

`batch` accepts CSV, JSONL, JSON, and YAML task files. Supported rows include
search, lookup, workspace, artifact, extract, and material ingest tools. With
`--resume-from ./results.jsonl --out ./results.jsonl`, rows append durable JSONL
results and keep both row `index` and row `id`.

Use `run <canonical_tool>` when an agent or script needs a deterministic,
schema-validated tool call:

```bash
paper-search run material_status --arg target=item-123
paper-search run artifact_download --json-args '{"input":"https://example.test/files/article.pdf","provider":"fixture-artifact-downloader","dry_run":true}'
```

## MCP Surface

Use `mcp serve` when an AI client needs JSON-RPC tools instead of terminal
commands. The server uses the same config, provider runtimes, result envelopes,
capability tags, and workspace sink as the CLI.

- default HTTP endpoint: `http://127.0.0.1:23121/mcp`
- help endpoint: `http://127.0.0.1:23121/mcp/help`
- status endpoint: `http://127.0.0.1:23121/mcp/status`
- supported JSON-RPC methods: `initialize`, `initialized`,
  `notifications/initialized`, `tools/list`, `tools/call`, `resources/list`,
  `prompts/list`, and `ping`
- `--transport stdio` is available for line-delimited JSON-RPC clients

The HTTP endpoints are a project-specific JSON-RPC bridge, not a complete MCP
HTTP+SSE transport. Use `--transport stdio` for standards-based MCP clients.

Live provider, web, and material network behavior follows the same explicit
smoke policy as CLI commands.

## Test Layers

- `npm run test:unit` - pure logic and shared contracts
- `npm run test:contract` - provider manifests, provider runtime contracts, and
  compatibility contracts
- `npm run test:integration` - CLI/config workflow checks with temporary config
  files and local fixtures
- `npm run test:compat:official` - builds and probes all 13 published provider
  ZIP archives with registry checksum verification
- `npm run test:smoke` - explicitly gated live checks
- `npm run verify:release` - full offline release gate plus the ungated smoke
  skip assertion

Default tests are deterministic and offline. Smoke checks are separate. Without
`PAPER_SEARCH_RUN_SMOKE=1`, `npm run test:smoke` exits with a skipped summary.
With the gate enabled, build first and then run the live cases:

```bash
npm run build
PAPER_SEARCH_RUN_SMOKE=1 npm run test:smoke
```

Use `PAPER_SEARCH_SMOKE_CASES=crossref-live` or
`node scripts/run-smoke.mjs --case arxiv-live` to run one live case. Beyond the
default `crossref-live, arxiv-live` list, the selectable cases are
`openalex-live`, `pmc-live`, `europepmc-live`, `material-mineru-live`, and
`material-unpaywall-live`; see [`docs/testing.md`](./docs/testing.md) for the
required environment variables.

## License

Paper Search CLI is available under the [MIT License](./LICENSE).
