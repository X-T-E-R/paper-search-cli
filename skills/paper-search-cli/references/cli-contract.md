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

## Canonical Tool Invocation

Use the precise `run <canonical_tool>` entrypoint for deterministic tool calls:

```bash
node scripts/paper-search.mjs run academic_search --json-args "{\"query\":\"retrieval augmented generation\",\"presets\":[\"general\",\"computer-science\"],\"maxResults\":5}"
node scripts/paper-search.mjs run resource_lookup --arg identifier=10.1145/3366423.3380130
node scripts/paper-search.mjs run material_ingest --json-args "{\"input\":\"./paper.pdf\",\"dryRun\":true}"
node scripts/paper-search.mjs run artifact_download --json-args "{\"input\":\"10.1038/nature12373\",\"resolverId\":\"unpaywall\",\"dryRun\":true}"
```

`--json-args` must be a JSON object. Repeated `--arg key=value` entries are merged with JSON args and parsed as booleans, numbers, or JSON when possible. The runner validates the argument schema and returns a `ResultEnvelope`.

The authoritative canonical names come from `node scripts/paper-search.mjs tools --json`. Current names are:

```text
mcp_help
academic_search
resource_lookup
patent_search
patent_detail
web_search
web_research
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
| `web_research` | `web-research`, `web_research` |
| `resource_add` | `resource-add`, `resource_add`, `add` |
| `collection_list` | `collection-list`, `collection_list`, `collections` |
| `workspace_export` | `workspace-export`, `resource-export`, `resource_export` |
| `resource_pdf` | `resource-pdf`, `resource_pdf`, `pdf` |
| `artifact_download` | `artifact download`, `run artifact_download` |
| `artifact_list` | `artifact list`, `run artifact_list` |
| `artifact_show` | `artifact show`, `run artifact_show` |
| `extract` | `extract`, `run extract` |
| `material_ingest` | `material ingest`, `run material_ingest` |
| `material_status` | `material status`, `run material_status` |
| `material_provider_list_installed` | `providers list-installed --kind material`, `material-providers list-installed` |
| `platform_status` | `platform-status`, `platform_status` |
| `mcp_help` | `help` |

## Dry-Run and Plan

Before write or network actions, prefer the plan path:

```bash
node scripts/paper-search.mjs providers install <id> --json
node scripts/paper-search.mjs providers update [id...] --json
node scripts/paper-search.mjs self mode self-update --json
node scripts/paper-search.mjs self update --json
node scripts/paper-search.mjs providers plan-registry <source> --kind search --json
node scripts/paper-search.mjs providers plan-registry <source> --kind material --json
node scripts/paper-search.mjs providers sync-registry <source> --kind material --json
node scripts/paper-search.mjs artifact download <url-or-itemKey-or-doi> --dry-run --json
node scripts/paper-search.mjs extract <input> --dry-run --json
node scripts/paper-search.mjs material ingest <input> --dry-run --json
node scripts/paper-search.mjs batch ./rows.jsonl --dry-run --out ./planned.jsonl
```

`planned: true` means the command selected policy/provider/paths and did not
perform the write or network action. `self mode <mode>`, `self update`,
`providers install`, `providers update`, and `providers sync-registry` are plans
unless `--apply` is present. Execute a change only after reviewing its blockers,
pinned source, digest, preconditions, and actions. The production self-update
policy is source-sealed to the official HTTPS `main` origin; config,
environment, and CLI values cannot add or override repository authority.

For DOI inputs, `artifact download` accepts `--resolver <id>` and the canonical tool accepts `resolverId`/`resolver_id`. DOI dry-run plans list the resolver steps (`load-resolver`, `run-resolver`) before the download steps, and resolver failures are typed as `no_resolver`, `no_candidates`, or `resolver_error` in envelope diagnostics.

## Batch JSONL

`batch` accepts CSV, JSONL, JSON, and YAML rows. Supported row tools include:

```text
academic_search
patent_search
patent_detail
web_search
web_research
resource_lookup
resource_add
resource_pdf
artifact_download
extract
material_ingest
```

Use `--dry-run` when rows mix search, local writes, or material actions. With `--out ./results.jsonl`, results are streamed in completion order; reconcile resumed runs by row `id` or `index`, not by line position.

## Workspace, Artifact, and Extraction Records

- The workspace root comes from resolved config and is visible in `status --json`.
- `resource_add` writes normalized resource items to the local workspace sink.
- `resource_pdf` uses a local attachment sink and treats `itemKey` as the workspace item id.
- `artifact_download` creates artifact records with source, attempts, policy, provider provenance, local/remote references, and optional workspace item links. DOI-resolved acquisitions also record `provenance.resolverProviderId`, `provenance.resolverSource`, the originating identifier in `resolvedFrom`, and per-candidate resolver attempts.
- `extract` creates extraction records with source, backend/provider id, options, outputs, cache status, and optional workspace item links.
- `material_status` reports related artifact and extraction ids for a workspace item, artifact, or extraction.
- `workspace_export` emits portable JSON, JSONL, CSV, or BibTeX files from local workspace records.

Do not claim host-application writes. The CLI writes to its configured local workspace and explicit export files.

## Secret and Config Boundary

The conventional bundle contains user non-secret `config.toml`, user-only
`subscriptions.toml`, and optional ACL-restricted plaintext
`credentials.toml`. Only `config.toml` is required. Plaintext credentials are
not encrypted.

Configuration layers resolve in this order: built-in defaults, user
`config.toml`, project config, explicit `--config`, `credentials.toml` for
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
- Web backend credentials live under `[api.<provider>]` or matching `PAPER_SEARCH_API__...` environment variables.
- Provider-specific config lives under the provider id section used by the runtime.

Never print raw API keys, tokens, passwords, or credentials. If a command needs live credentials, report only whether the required key is present or missing.
