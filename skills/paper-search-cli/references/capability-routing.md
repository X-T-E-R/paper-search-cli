# Capability Routing

Choose one capability group first, then choose the current CLI entrypoint or canonical tool. The live catalog through the installed skill launcher is authoritative:

```bash
node scripts/paper-search.mjs tools --json
node scripts/paper-search.mjs help
```

## Routing Map

| Intent | Group | CLI entrypoints | Canonical tool names |
| --- | --- | --- | --- |
| Search papers or scholarly records | `discover` | `academic`, `academic-search`, `academic_search` | `academic_search` |
| Search patents | `discover` | `patent`, `patent-search`, `patent_search` | `patent_search` |
| Search through configured External Search v1 | `discover` | `web`, `web-search`, `web_search` | `web_search` |
| Resolve DOI/PMID/arXiv/ISBN/URL metadata | `identify` | `lookup`, `resource-lookup`, `resource_lookup` | `resource_lookup` |
| Fetch patent detail blocks | `identify` | `patent-detail`, `patent_detail` | `patent_detail` |
| Rank, dedupe, or inspect source metrics | `assess` | Reserved group ([ADR-0003](../../../docs/decisions/ADR-0003-assess-capability-group-disposition.md)): no implemented tools or commands. Use live catalog output and result diagnostics only. | None; reserved. |
| Acquire or record an artifact from a URL, workspace item, or DOI | `acquire` | `artifact download`, `artifact list`, `artifact show` | `artifact_download`, `artifact_list`, `artifact_show` |
| Attach or record a PDF for a saved item | `acquire` | `resource-pdf`, `resource_pdf`, `pdf` | `resource_pdf` |
| Extract Markdown/JSON/assets from an artifact, URL, or file | `extract` | `extract` | `extract` |
| Add, list, or export local workspace records | `organize` | `resource-add`, `resource_add`, `add`, `collection-list`, `collection_list`, `collections`, `workspace-export`, `resource-export`, `resource_export` | `resource_add`, `collection_list`, `workspace_export` |
| Run row-based local flows | `orchestrate` | `batch` | Uses canonical row tool names. |
| Plan or run material ingest and status | `orchestrate` | `material ingest`, `material status` | `material_ingest`, `material_status` |
| Inspect source expansion/readiness, retained-checkout state, config, registries/providers, help, tools, or MCP | `operate` | `search-plan`, `status`, `doctor`, `paths`, `setup`, `self`, `config`, `registries`, `providers`, `material-providers`, `platform-status`, `platform_status`, `tools`, `help`, `mcp serve`, `run` | `mcp_help`, `material_provider_list_installed`, `platform_status` plus management command envelopes |

## Search and Identification

- Use `academic` for installed academic providers.
- Use `patent` for patent discovery, then `patent-detail` before saving detailed patent data.
- With no positive selector, academic search uses `general` and patent search uses `patents`. Repeat `--preset`, `--source`, or `--category` to union selections; request-level `--exclude-source` is final.
- Use `search-plan --type academic|patent` with the same selector flags to inspect canonical ids, preset/category expansion, skipped providers, and readiness without searching. Literal `--platform all` means command-scoped non-view sources, not `general`.
- Use `lookup` when the input is already a DOI, PMID, arXiv ID, ISBN, or URL that should become normalized metadata.
- Use `web` only when the user-level `external-search.toml` integration is configured. General web browsing belongs to the normal browser/search route unless the user explicitly wants paper-search.

Keep first passes small with `--max-results`. Use `platform-status --json` for static external-search readiness and `doctor --json` for its no-network probe.

## Material Acquisition, Extraction, and Ingest

For `artifact download`, `extract`, or `material ingest`, always route through discovery and planning before live network or write execution:

1. Discover installed material providers:
   ```bash
   node scripts/paper-search.mjs providers list-installed --kind material --json
   ```
   Compatibility alias:
   ```bash
   node scripts/paper-search.mjs material-providers list-installed --json
   ```
2. If a package or manifest is supplied, validate it with the material kind:
   ```bash
   node scripts/paper-search.mjs providers validate-manifest ./manifest.json --kind material --json
   node scripts/paper-search.mjs providers inspect-package ./provider-package --kind material --json
   ```
3. Plan the material action:
   ```bash
   node scripts/paper-search.mjs artifact download <itemKey-or-url-or-doi> --dry-run --json
   node scripts/paper-search.mjs extract <artifactId-or-path-or-url> --dry-run --json
   node scripts/paper-search.mjs material ingest <path-or-url-or-itemKey-or-doi> --dry-run --json
   ```
4. Execute only after the plan reports the expected provider, policy, source, and target paths.

### DOI Resolver Funnel

`artifact download` and `material ingest` accept a bare DOI as input. A DOI is resolved to ordered candidate URLs through an installed resolver provider (manifest `kind` `artifact_resolver`), then the existing download path tries each candidate in order:

- Select a specific resolver with `--resolver <id>`; otherwise the first usable installed resolver is used.
- The canonical tool `artifact_download` takes the same selection as `resolverId` (snake-case alias `resolver_id`).
- Dry-run plans list the resolver steps (`load-resolver`, `run-resolver`) before the download steps.
- Resolver failures are typed in envelope diagnostics as `no_resolver`, `no_candidates`, or `resolver_error`, with resolver attempts preserved.

Resolvers return candidate locations only; byte download stays in downloader providers.

No networked material resolver, downloader, or extractor is built into the core CLI. Installed material providers must be discovered and validated at runtime; do not infer that MinerU or any other network extractor exists just because `extract` is available.

## Local Workspace and Records

- `resource-add` stores selected metadata in the local workspace sink.
- `resource-pdf` records or downloads a PDF attachment for an existing workspace item and returns the workspace item id plus artifact id when available.
- `artifact download` creates artifact records with provenance and attempt history.
- `extract` creates extraction records with output paths and cache status.
- `material status` reads workspace item, artifact, or extraction status and reports related artifact/extraction ids.
- `workspace-export` writes portable local exports as JSON, JSONL, CSV, or BibTeX.

Do not claim host-application writes; this CLI writes to its configured local workspace and export paths.

## Operate Separately From Research Work

Use `operate` commands for readiness, configuration, provider inventory, MCP setup, and smoke gates. Do not present `doctor`, `config`, or provider installation as literature search results.
