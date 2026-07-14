# Paper Search CLI X

Paper Search CLI X is a standalone, extensible research-discovery CLI. The X
stands for extensibility and open possibilities: installed providers can add
source-specific search, citation-graph, artifact, and extraction behavior while
the core keeps one stable CLI, canonical-tool, MCP, batch, and Skill contract.

Use it to search literature and web sources, normalize known identifiers, store
local workspace records, expand citation graphs, inspect transparent assessment
signals, acquire and extract material through providers, and export portable
records. The command, package, configuration keys, canonical tool names, and MCP
identity remain `paper-search`/`paper-search-cli` compatible.

## Recommended workflow

1. Run `paper-search doctor` and
   `paper-search providers list-installed --kind search` to inspect local
   readiness.
2. Search one or more presets or sources. Repeated positive selectors form a
   union. A direct `academic`, `patent`, `lookup`, or optional `web` command is
   ephemeral; use `paper-search run <canonical-tool>` when you need a durable
   discovery record.
3. Plan citation expansion before starting it, keep traversal limits explicit,
   and resume an interrupted durable run by run id.
4. Add only the records you select to the local workspace. Search and citation
   results are not ingested automatically.
5. Plan artifact acquisition or extraction, then run it through installed
   material providers. Core does not contain a source-specific PDF downloader
   or network extractor.
6. If needed, export selected bibliographic data to Zotero with the CLI-only
   plan, preview, and digest-acknowledged apply flow. Paper Search does not claim
   Zotero PDF or Markdown attachment import.
7. Assess explicit, checksum-bound observation snapshots and inspect their
   provenance, conflicts, and policy trace. Paper Search does not choose which
   papers you should accept.

See [Paper Search CLI X workflows and storage](./docs/paper-search-cli-x.md) for
the durable-run, citation, assessment, storage, material-provider, and Zotero
contracts.

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
bundle. All conventional user state lives below `~/.paper-search/`; old
`%APPDATA%/paper-search`, `$XDG_CONFIG_HOME/paper-search`, and
`~/.config/paper-search` locations are migration inputs, not live authorities.

- `config.toml` stores user-owned, non-secret runtime settings.
- `subscriptions.toml` stores user-owned trusted registry definitions and is
  validated separately from runtime settings.
- `credentials.toml` optionally stores plaintext credentials with restricted
  filesystem access. It is not encrypted, so use environment variables instead
  when plaintext-at-rest is unsuitable.
- `external-search.toml` optionally grants External Search v1 process authority;
  it is not part of the layered config merge.

Only `config.toml` is required. An example lives at
[`paper-search.example.toml`](./paper-search.example.toml). Project settings are
read from `paper-search.toml` and `.paper-search.toml` in the current directory;
if both exist, they are merged in that order and the CLI reports a compatibility
warning. `--config <path>` selects an additional explicit config file (or a
directory containing `config.toml`).

Default local records and outputs are separated by purpose:

```text
~/.paper-search/
  config.toml              config.d/
  subscriptions.toml       credentials.toml
  external-search.toml     adapters/
  providers/               registries/
  cache/                   state/
  workspace/               runs/
  storage/artifacts/       storage/extractions/
  exports/
```

Override future output locations with `workspace.root`,
`storage.artifactRoot`, `storage.extractionRoot`, `storage.exportRoot`, and
`runs.root`. Existing legacy `path` fields keep their original
workspace-relative meaning. The default `runs.maxAgeDays = -1` disables
age-based eligibility; Paper Search never prunes runs opportunistically during
another command. Durable history is private local plaintext and may therefore
be retained indefinitely until you explicitly run `runs prune --apply`.

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

Use dedicated credential commands instead of generic `config set` for installed
academic, patent, or material providers:

```bash
printf '%s' "$WOS_API_KEY" | paper-search config credentials set platform.wos.apiKey --stdin
paper-search config credentials get platform.wos.apiKey
paper-search config credentials unset platform.wos.apiKey
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

Source classification, request selection, and runtime readiness are independent.
For example, Web of Science remains a multidisciplinary source when its
credentials are absent; it is selected by `general`, reported as skipped, and
starts running after valid configuration without a taxonomy edit.

Academic search without a positive selector uses `general`; patent search uses
`patents`. The built-in presets are `general`, `computer-science`, `biomedicine`,
`preprints`, `repositories`, `publishers`, and `patents`. With the current
published inventory, `general` contains these 11 multidisciplinary sources
before readiness filtering: `arxiv`, `core`, `crossref`, `openaire`, `openalex`,
`sciencedirect`, `scopus`, `semantic`, `springer`, `wos`, and `zjusummon`. DBLP
belongs to `computer-science`, not `general`.

CLI selectors are repeatable. Positive selectors form a canonical-id union; as
soon as one is present, the implicit command default is not added. Exact source
exclusions are final. Use `search-plan` to inspect expansion, alias
canonicalization, exclusions, and readiness without sending a search request:

```bash
paper-search academic "retrieval augmented generation"
paper-search academic "graph neural networks" --preset general --preset computer-science
paper-search academic "single-cell transcriptomics" --category domain:biomedicine --source crossref
paper-search academic "foundation models" --preset general --exclude-source wos
paper-search academic "formal verification" --platform all
paper-search search-plan --type academic --preset general --category domain:computer-science
```

Legacy singular `--platform` and `--provider` inputs remain valid. Literal
`--platform all` selects every installed, valid, configured, enabled, non-view
source for that command type. It does not mean `general`, and it does not select
unavailable sources. Views are selected only by exact id or by an explicit user
preset.

Validated snapshots from active search subscriptions supply taxonomy for
packages that are available but not installed. This keeps their preset
membership visible in `search-plan`: for example, an uninstalled `general`
member stays selected but is reported as skipped with `provider package is not
installed`. An installed manifest remains authoritative for its own runtime
classification, so a later registry snapshot cannot silently reclassify an
installed package.

Tags and presets live in the normal layered TOML configuration:

```toml
[search]
defaultAcademicPresets = ["my-general", "preprints"]
defaultPatentPresets = ["patents"]

[search.classifications.lab-preferred]
sources = ["crossref", "openalex"]

[search.presets.my-general]
extends = ["general"]
include = ["tag:lab-preferred", "source:pubmed"]
exclude = ["source:semantic"]
```

Built-in preset names are reserved; customize one by extending it under a new
name. Supported selector namespaces are `source:`, `tag:`, `type:`, `domain:`,
`content:`, `access:`, and `transport:`. Arrays replace lower-precedence arrays.
A higher-priority definition of the same tag or preset replaces that complete
definition; use `extends` for intentional composition.

`config set` stores known provider aliases as canonical ids when writing tag
source arrays or preset `source:*` selectors. Unknown ids remain unchanged so a
portable config can refer to a provider from a subscription not active on the
current machine. Hand-edited TOML should prefer canonical provider ids.

Keep a small `config.toml` and split optional settings into its adjacent
`config.d/*.toml` directory. Files load in lexical order after the main file and
use the same schema; the main file must exist. Project files use matching names
such as `paper-search.toml` plus `paper-search.d/*.toml`, and an explicit
`--config /path/to/config.toml` uses `/path/to/config.d/*.toml`.

```text
config.toml
config.d/
  10-tags.toml
  20-presets.toml
  30-provider-settings.toml
```

The old `[search.selection]` block remains a compatibility adjustment for the
implicit command default. It no longer defines `all`. `platform.<id>.enabled`
is still a hard runtime switch, and no selector bypasses installation,
validation, required configuration, or enablement. Existing keys remain
writable with `config set`, for example:

```bash
paper-search config set search.selection.excludeDomains '["biomedicine"]'
paper-search config set search.selection.includeIds '["pubmed"]'
paper-search config explain search.selection.excludeDomains
```

For entirely separate reusable profiles, put an ordinary `config.toml` (and
optional `config.d`) under each profile directory, then select the directory
with `paper-search --config <profile-directory> ...`.

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
- `PAPER_SEARCH_STORAGE_ARTIFACT_ROOT`
- `PAPER_SEARCH_STORAGE_EXTRACTION_ROOT`
- `PAPER_SEARCH_STORAGE_EXPORT_ROOT`
- `PAPER_SEARCH_RUNS_ROOT`
- `PAPER_SEARCH_RUNS_MAX_AGE_DAYS`
- `PAPER_SEARCH_ZOTERO_ENABLED`
- `PAPER_SEARCH_ZOTERO_ENDPOINT`
- `PAPER_SEARCH_PLATFORM__PATENTSTAR__LOGIN_NAME`
- `PAPER_SEARCH_PLATFORM__PATENTSTAR__PASSWORD`

## Capability Map

Every command and canonical tool belongs to one stable capability group. The
capability map is the routing contract used by the CLI, MCP tools, and companion
skill.

| Capability | What it does | Common entrypoints |
| --- | --- | --- |
| `discover` | Search academic and patent sources, plus optional generic external web search. | `academic`, `patent`, `web` |
| `identify` | Resolve a known identifier, URL, or provider-native id to normalized metadata. | `lookup`, `patent-detail` |
| `assess` | Inspect checksum-bound observations, provenance, conflicts, and an optional explicit policy trace without an implicit universal verdict. | `assess plan`, `assess run`, `assess show`, `assess list` |
| `acquire` | Fetch or record artifacts with provenance and attempt history. | `artifact download`, `artifact list`, `artifact show`, `resource-pdf` |
| `extract` | Turn an artifact, URL, or file into Markdown, JSON, or assets through extractor providers. | `extract` |
| `organize` | Store, tag, collect, and export workspace records. | `resource-add`, `collection-list`, `workspace-export` |
| `orchestrate` | Run durable discovery, citation expansion, and multi-step material workflows over primitives. | `run`, `citation`, `batch`, `material ingest`, `material status` |
| `operate` | Inspect readiness, paths, durable runs, and config; manage registries/providers and server surfaces. | `status`, `doctor`, `paths`, `runs`, `config`, `registries`, `providers`, `platform-status`, `tools`, `help`, `mcp serve` |

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
domains, content kinds, access classes, `general` membership, legacy
`defaultInAll` metadata, and entries without classification. Without `source`,
it uses the configured search registry URL. Views such as ACM over Crossref do
not inflate the source count or enter automatic presets, categories, or literal
`all`, but remain available by explicit id or an explicit user preset.

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
paper-search web "latest RAG evaluation benchmarks" --mode deep --freshness pm --max-results 5
paper-search lookup "10.1145/3366423.3380130"
paper-search resource-add --item-file ./search.json --index 0 --collection-path Research/Inbox --tags rag --json
paper-search resource-pdf <workspace-item-id> --url https://example.org/paper.pdf --filename paper.pdf --json
paper-search collection-list --flat --json
paper-search workspace-export --collection-path Research --include-children --out ./paper-search-export.bib --json
```

`lookup` is the recommended step before `resource-add` when you already have a
DOI, PMID, arXiv ID, ISBN, or URL. `patent-detail` is the recommended step
before `resource-add` when patent claims, legal status, PDF URLs, or image URLs
matter. `resource-pdf` and `pdf` remain compatibility entrypoints for existing
workspace item ids. They use the same installed material-provider path as
`artifact download`; core does not fetch the URL directly. New material
workflows should prefer artifact and extraction records.

## Artifact and Extraction Records

Material workflows store auditable metadata records under the configured
workspace root. Artifact bytes and extracted outputs use the independently
configured `storage.artifactRoot` and `storage.extractionRoot`.

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
- versioned output references into the configured extraction storage root

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

[storage]
artifactRoot = "$tmp/storage/artifacts"
extractionRoot = "$tmp/storage/extractions"
exportRoot = "$tmp/exports"

[runs]
root = "$tmp/runs"
maxAgeDays = -1

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

The generated workspace contains artifact and extraction metadata records.
Artifact bytes are written below `$tmp/storage/artifacts`; extracted Markdown,
structured output, and assets are written below `$tmp/storage/extractions`.

## Batch and Precise Tool Calls

`batch` accepts CSV, JSONL, JSON, and YAML task files. Supported rows include
search, lookup, workspace, artifact, extract, material ingest,
`citation_expand`, and `assessment_run`. With
`--resume-from ./results.jsonl --out ./results.jsonl`, rows append JSONL results
and keep both row `index` and row `id`.

Use `run <tool>` when an agent or script needs a durable, schema-validated
discovery call. It accepts only `academic_search`, `patent_search`,
`resource_lookup`, `patent_detail`, and optional `web_search`:

```bash
paper-search run academic_search \
  --json-args '{"query":"retrieval augmented generation","presets":["general","computer-science"],"maxResults":5}'
paper-search run resource_lookup --arg identifier=10.1145/3366423.3380130
```

Use the friendly material commands shown above for local writes. Citation and
assessment have their own plan/run commands and durable records.

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

External `web_search` is advertised only when the dedicated user-level
`external-search.toml` passes static checks. `status` never starts the process;
`doctor` runs the protocol-defined no-network probe. See
`external-search.example.toml`. Project and `--config` files cannot grant
execution authority. The configured executable and trusted `.mjs` adapters
under `<configRoot>/adapters/` run in child processes with bounded I/O and
deadlines; trusted adapter code is fault-isolated, not sandboxed.

Version 0.4 removes the built-in Tavily, Firecrawl, Exa, xAI, and MySearch Web
adapters and removes `web_research`. Existing retired `[api.*]` values are not
deleted; doctor may report populated secret-like values as masked and unused.
No workspace or provider data migration is required. See
[Migrating to 0.4](./docs/migration-0.4.md).

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

Paper Search CLI X is available under the [MIT License](./LICENSE).
