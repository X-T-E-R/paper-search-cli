# Management Layer

Use the management layer for readiness, configuration, provider inventory, provider installation planning, MCP serving, help/catalog discovery, and smoke gates. Keep it separate from research/material results.

## Readiness Probes

Start with:

```bash
node scripts/paper-search.mjs --version
node scripts/paper-search.mjs paths --json
node scripts/paper-search.mjs self status --json
node scripts/paper-search.mjs status --json
node scripts/paper-search.mjs doctor --json
node scripts/paper-search.mjs platform-status --json
node scripts/paper-search.mjs tools --json
node scripts/paper-search.mjs help
```

- `paths --json` reports the independent repository, config, data, bin, state,
  and build paths, plus whether the managed bin root is on `PATH`.
- `self status --json` inspects source/build freshness, installer identity,
  source-management mode, Git/upstream state, skill projections, shim health,
  and pending update recovery. It does not update the checkout.
- `setup` uses the same installer as the retained checkout. It plans build,
  projection, and shim repair by default; add `--apply` only after review.
- `status --json` is informational. Alongside config, workspace, server, output,
  and smoke state, it reports the authoritative kind-separated provider
  inventory, receipt/binding state, subscription snapshot freshness, pending
  recovery journals, and observable lifecycle locks. The configured legacy
  provider directory remains a compatibility view, not the authoritative one.
- `doctor --json` adds actionable warnings for duplicate global provider ids,
  missing/malformed/mismatched receipts, orphaned or rebind-pending bindings,
  missing/invalid registry snapshots, and pending or corrupt recovery state. It
  also retains registry reachability, workspace, MCP, smoke, and masked-key
  readiness checks.
- `platform-status --json` reports enabled/configured/available provider states and current canonical tool availability.
- `tools --json` reports canonical tools, capability annotations, CLI aliases, and CLI-only management commands.
- `help [topic]` reports local help and provider usage notes as JSON.

## Retained-Checkout Management

Installations default to `user-managed`. Inspect the current mode, then review a
plan before any mode or checkout change:

```bash
node scripts/paper-search.mjs self mode --json
node scripts/paper-search.mjs self mode user-managed --json
node scripts/paper-search.mjs self mode user-managed --apply --json
node scripts/paper-search.mjs self mode self-update --json
node scripts/paper-search.mjs self update --json
```

`self mode <mode>` and `self update` are plan-first; `--apply` is the explicit
write boundary. A self-update plan also requires an installer-owned, clean,
attached checkout, a matching official upstream, no local-only or diverged
commits, and a fast-forward target.

The production build seals official-origin authority to the exact HTTPS
`X-T-E-R/paper-search-cli` `main` upstream. Config, environment variables, and
CLI arguments cannot add or override authority. SSH clones, forks, other
branches, and dirty or locally advanced checkouts remain user-managed. Report
the blocker from the plan instead of attempting an apply. A user-managed
checkout can be updated with the user's normal Git
workflow and repaired or rebuilt through the plan-first `setup` command.

## Config Commands

Config commands emit `operate` envelopes and mask secret-like values by default:

```bash
node scripts/paper-search.mjs config path
node scripts/paper-search.mjs config path --all
node scripts/paper-search.mjs config validate
node scripts/paper-search.mjs config explain providers.installDir
node scripts/paper-search.mjs config keys
node scripts/paper-search.mjs config list
node scripts/paper-search.mjs config get defaults.maxResults
node scripts/paper-search.mjs config set defaults.maxResults 25
node scripts/paper-search.mjs config unset defaults.maxResults
node scripts/paper-search.mjs config credentials set api.tavily.apiKey --from-env TAVILY_API_KEY
node scripts/paper-search.mjs config credentials get api.tavily.apiKey
node scripts/paper-search.mjs config credentials unset api.tavily.apiKey
node scripts/paper-search.mjs config import-env ./.env
node scripts/paper-search.mjs config import-env ./.env --apply
```

Search-source aggregation uses the same layered configuration:

```bash
node scripts/paper-search.mjs config set search.selection.excludeDomains '["biomedicine"]'
node scripts/paper-search.mjs config set search.selection.includeIds '["pubmed"]'
node scripts/paper-search.mjs config set search.selection.mode allowlist
```

`platform.<id>.enabled` is the provider hard switch. `search.selection` only
controls runnable sources selected by `platform=all`. Explicit provider ids and
unique inventory aliases bypass the aggregate policy, but not installation,
enablement, or required configuration. Views are always excluded from `all`.
Profiles reuse explicit configuration directories such as
`<config-root>/profiles/biomed/config.toml` with `--config
<config-root>/profiles/biomed`; do not create another profile registry.

`config import-env` is a plan unless `--apply` is present. It sends non-secret
values to `config.toml`, secrets to ACL-restricted plaintext
`credentials.toml`, and skips values already present in the shell environment.
`subscriptions.toml` is a separately validated user-only file for trusted
registry definitions. Use `--raw` only when the user explicitly needs to inspect
an unmasked legacy value locally. Do not echo raw secrets in the final answer.

## Migration

Treat legacy v0 user configuration and flat provider folders as migration
inputs. The command plans both parts together and writes only with `--apply`:

```bash
node scripts/paper-search.mjs migrate
node scripts/paper-search.mjs migrate --apply
node scripts/paper-search.mjs migrate --legacy-install-dir <path> --apply
```

The migration reuses the split-config transaction journal, provider receipts,
replacement preconditions, kind-separated targets, and recovery journals. It
does not edit project config files. A custom/project/env provider root must be
selected explicitly with `--legacy-install-dir` before it can be moved.

## Registry Subscriptions

Use the lifecycle commands instead of editing subscription URLs in place:

```bash
node scripts/paper-search.mjs registries add official-search https://github.com/X-T-E-R/resource-search-providers/releases/download/providers-registry-latest/registry.json --kind search
node scripts/paper-search.mjs registries add official-search https://github.com/X-T-E-R/resource-search-providers/releases/download/providers-registry-latest/registry.json --kind search --apply
node scripts/paper-search.mjs registries add official-material https://github.com/X-T-E-R/material-providers/releases/download/material-registry-latest/registry.json --kind material --apply
node scripts/paper-search.mjs registries list
node scripts/paper-search.mjs registries show official-search
node scripts/paper-search.mjs registries refresh official-search
node scripts/paper-search.mjs registries disable official-search --apply
```

Add/rebind/enable/disable/remove are plan-first trust changes. Refresh writes a
validated registry snapshot but never installs providers. A URL changed by hand
is `rebind-pending`; use `registries rebind` to reconfirm its canonical source
or create a new identity. Removal, or a rebind that changes the canonical source
fingerprint, needs the separate `--orphan-dependents` acknowledgement when
dependent receipts exist. A canonical-equivalent rebind preserves its snapshot.

## Provider Management

Use active subscription snapshots for normal provider discovery and lifecycle
changes:

```bash
node scripts/paper-search.mjs providers available --json
node scripts/paper-search.mjs providers available <query> --json
node scripts/paper-search.mjs providers inventory --json
node scripts/paper-search.mjs providers inventory ./registry.json --json
node scripts/paper-search.mjs providers install <id> --json
node scripts/paper-search.mjs providers install <id> --from <subscription-id> --apply --json
node scripts/paper-search.mjs providers update --json
node scripts/paper-search.mjs providers update <id> --apply --json
```

`available` never refreshes registries. It reads only validated current snapshots
for active subscriptions. `install` and `update` are plans unless `--apply` is
present. When an id is published by multiple active subscriptions, pass
`--from <subscription-id>` to select one explicitly. A bound plan requires the
publisher's SHA-256 and pins its subscription identity, registry digest, archive
digest, package identity, and installed-state precondition. Application rejects
stale plans. Updates remain attached to the source recorded in the installed
receipt; they do not switch to another publisher automatically.

`providers inventory [source]` is search-registry-only. It reports declared
entries, independently counted sources, source-backed views, aliases, service
families, source types, domains, content kinds, access classes, default aggregate
membership, retained-unpublished entries, and legacy published entries without
an inventory classification. With no `source`, it reads the configured search
registry URL. A view never increments the source count or enters `platform=all`,
but the caller may select it explicitly.

Bound installs live below the provider root as `search/<id>` or `material/<id>`.
Ids are globally unique across both kinds. Flat legacy packages remain a read
fallback and must be moved with `migrate` before provider writes or updates.

Use `providers --kind search|material` for low-level inspection and compatibility
installation workflows:

```bash
node scripts/paper-search.mjs providers list-installed --kind search --json
node scripts/paper-search.mjs providers list-installed --kind material --json
node scripts/paper-search.mjs providers validate-manifest ./manifest.json --kind search --json
node scripts/paper-search.mjs providers validate-manifest ./manifest.json --kind material --json
node scripts/paper-search.mjs providers inspect-package ./provider-package --kind search --json
node scripts/paper-search.mjs providers inspect-package ./provider-package --kind material --json
node scripts/paper-search.mjs providers plan-registry ./registry.json --kind search --json
node scripts/paper-search.mjs providers plan-registry ./registry.json --kind material --json
node scripts/paper-search.mjs providers sync-registry ./registry.json --kind material --json
node scripts/paper-search.mjs providers sync-registry ./registry.json --kind material --apply --json
node scripts/paper-search.mjs providers install-zip ./provider.zip --kind material --json
node scripts/paper-search.mjs providers install-zip ./provider.zip --kind material --apply --json
```

`providers sync-registry` without `--apply` is a dry-run plan. Use `--apply` only
after reviewing the planned install/update/skip/blocked actions. `sync-registry`
and `install-zip` write unbound compatibility receipts, so later
subscription-bound updates do not treat them as registry-owned installations.

Material packages are distributed from the separate `material-providers`
repository, not from `resource-search-providers`. Its generated registry entries
carry `id`, `version`, `kind` (a material provider kind such as
`artifact_resolver` or `extractor`), `downloadUrl`, `sha256`, and
`minCliVersion` (`minPluginVersion` is accepted as a compatibility alias). The
loader accepts local files and exact HTTPS `registry.json` URLs; archive
references may be local or HTTPS and relative references resolve against the
registry location. Use `plan-registry`/`sync-registry` for generated registries,
or plan-first `install-zip` for a standalone archive; add `--apply` to write it.
Material sources require the exact
JSON URL; GitHub repository shorthand expansion remains search-only. Registry
SHA-256, manifest integrity, and the minimum-version gate block mismatched
installs.

`providers registry-candidates <input>` expands search-provider registry URLs or GitHub repository inputs into candidate `registry.json` URLs:

```bash
node scripts/paper-search.mjs providers registry-candidates https://github.com/X-T-E-R/resource-search-providers --json
```

The compatibility alias for material-provider management is:

```bash
node scripts/paper-search.mjs material-providers list-installed --json
node scripts/paper-search.mjs material-providers validate-manifest ./manifest.json --json
node scripts/paper-search.mjs material-providers inspect-package ./provider-package --json
node scripts/paper-search.mjs material-providers plan-registry ./registry.json --json
node scripts/paper-search.mjs material-providers sync-registry ./registry.json --json
node scripts/paper-search.mjs material-providers sync-registry ./registry.json --apply --json
node scripts/paper-search.mjs material-providers install-zip ./provider.zip --json
node scripts/paper-search.mjs material-providers install-zip ./provider.zip --apply --json
```

Prefer `providers --kind material` in new instructions. Use `material-providers` only for compatibility with callers that already depend on that namespace.

## Material Provider Checks

Before material acquisition, extraction, or ingest:

1. List installed material providers.
2. Validate any supplied material manifest with `--kind material`.
3. Inspect any supplied material package with `--kind material`.
4. Run the material command with `--dry-run --json`.

No networked material extractor is built into the core CLI. Treat networked extractors as installed material providers that must be discovered, validated, configured, and, when live behavior matters, smoke-tested explicitly.

## MCP Serve

Start the MCP server only when a JSON-RPC client surface is required:

```bash
node scripts/paper-search.mjs mcp serve --transport http --host 127.0.0.1 --port 23121
node scripts/paper-search.mjs mcp serve --transport stdio
```

Search-provider bundles are trusted in-process extensions. Manifest permissions
and the compatibility `vm` namespace are not a security sandbox; install only
from trusted registries or archives. Registry sync validates archive checksum,
provider id/version, minimum CLI version, and ZIP paths before replacement.

HTTP endpoints:

```text
http://127.0.0.1:23121/mcp
http://127.0.0.1:23121/mcp/help
http://127.0.0.1:23121/mcp/status
```

These HTTP endpoints are a project-specific JSON-RPC bridge, not a complete MCP
HTTP+SSE transport. Use stdio for standards-based MCP clients.

Initialize and list tools:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"agent","version":"1.0"}}}
```

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

Call a tool:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mcp_help","arguments":{"topic":"overview","locale":"en"}}}
```

Do not claim MCP behavior from CLI-only evidence. Use JSON-RPC unit/integration evidence or an actual `mcp serve` call.

## Smoke Gates

These commands are for repository development and validation, not normal
installed invocation. Smoke checks and live network validation are explicit.
The default test chain uses stubbed/local evidence and does not prove live
provider compatibility.

Gate check:

```bash
npm run test:smoke
```

Live smoke:

```bash
npm run build
PAPER_SEARCH_RUN_SMOKE=1 npm run test:smoke
```

Run one selected live case:

```bash
PAPER_SEARCH_RUN_SMOKE=1 PAPER_SEARCH_SMOKE_CASES=crossref-live npm run test:smoke
```

The default case list is `crossref-live, arxiv-live`. Additional selectable cases are `openalex-live` (optional `PAPER_SEARCH_SMOKE_OPENALEX_MAILTO`), `pmc-live` (optional `PAPER_SEARCH_SMOKE_PMC_EMAIL` / `PAPER_SEARCH_SMOKE_PMC_API_KEY`), `europepmc-live` (no key), `material-mineru-live` (requires MinerU token and source URL), and `material-unpaywall-live` (requires `PAPER_SEARCH_SMOKE_UNPAYWALL_EMAIL` or `UNPAYWALL_EMAIL`; optional `PAPER_SEARCH_SMOKE_UNPAYWALL_DOI`, `PAPER_SEARCH_SMOKE_UNPAYWALL_PROVIDER_PACKAGE`, `PAPER_SEARCH_SMOKE_UNPAYWALL_TIMEOUT_MS`, and the `--unpaywall-provider-package` flag). With the gate enabled, material cases fail early with a configuration error when required credentials or inputs are missing. The smoke provider root defaults to the sibling `resource-search-providers` source tree resolved relative to the repository; override with `--provider-root` or `PAPER_SEARCH_PROVIDER_SOURCE`.

When smoke is run, report the enabled state, selected cases, provider root, and result summary. If smoke was not run, say so plainly.
