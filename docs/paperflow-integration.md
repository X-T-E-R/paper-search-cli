# Paperflow integration boundary

Paper Search owns discovery and durable search-run records. Paperflow owns the
research workspace, semantic path roles, and later promotion of selected
records. The integration shares one run directory; it does not copy every
search through a second import database.

## Context discovery

Paper Search walks upward from the invocation directory and loads the nearest
`paper-search.toml` or `.paper-search.toml`. It reads only this Paper Search
configuration and never parses `paperflow.yaml`.

A fresh Paperflow workspace contains both:

```yaml
roles:
  search_runs: sources/search/runs
  paper_search_workspace: sources/search/workspace
  paper_artifacts: sources/literature/artifacts
  paper_extractions: sources/literature/extractions
  paper_exports: sources/search/exports
```

```toml
schemaVersion = 1

[context]
id = "<paperflow-project-id>"
kind = "paperflow"

[workspace]
root = "sources/search/workspace"
defaultCollection = "selected"

[storage]
artifactRoot = "sources/literature/artifacts"
extractionRoot = "sources/literature/extractions"
exportRoot = "sources/search/exports"

[material]
downloadDisposition = "selected"

[zoteroBinding]
mode = "inherit"

[runs]
root = "sources/search/runs"
recordByDefault = true
```

The role and TOML path resolve to the same directory. A direct call from any
workspace descendant therefore needs no wrapper or destination option:

```bash
paper-search academic "retrieval augmented generation"
paper-search patent "solid-state battery"
paper-search lookup 10.1145/3366423.3380130
```

Each recorded call writes one full run under `search_runs`. Downloads and
extractions use the other generated roles without a wrapper, import command, or
destination flag. Paper Search also
writes a small private locator under its user-level state so `paper-search runs
show <run-id>` can find the run from another directory. It does not duplicate
the full payload in the global run root.

## Paperflow consumption

Paperflow reads the mounted files directly:

```bash
paperflow search history
paperflow search show <run-id>
paperflow search candidates <run-id>
```

The existing bounded decoder validates run and result envelopes before exposing
them. `paperflow search backfill` is reserved for adopting legacy or external
JSON input; it is not part of the normal search loop.

Mounted history is still search history, not an accepted bibliography. A later
Paperflow/project workflow may select candidates for its catalog, evidence
records, or Zotero collections. Ordinary search hits do not become accepted
evidence or Zotero items automatically.

A successful download is selected by default, which means its artifact and
workspace item are linked under the Paperflow paths above. This is later than a
search hit and earlier than Paperflow evidence verification. Use
`material.downloadDisposition = "materialized"` when a workspace needs
downloaded files without selecting their records.

The generated `zoteroBinding.mode = "inherit"` follows the user's global
selected-item policy. A workspace can set `off`, or use `bound` with multiple
exact collection keys and link/import modes. Zotero receives a projection; PDF,
Markdown, metadata, receipts, and Paperflow evidence status remain authoritative
in the workspace. Zotero unavailability therefore records a pending projection
instead of failing the local download or extraction.

## Global fallback

Outside a configured context, Paper Search remains fully standalone and writes
to `~/.paper-search/runs`. A recorded discovery reports only compact persistence
facts:

```json
{
  "historyRecorded": true,
  "runId": "...",
  "context": { "id": "global", "kind": "global" },
  "savedTo": "...",
  "hint": "No local context; saved to global history."
}
```

The hint is omitted inside a configured context. `--no-history` is the explicit
per-call opt-out and creates neither a run nor a locator.

## Ownership

| Concern | Owner |
| --- | --- |
| Provider selection, search, lookup, citation traversal, assessment, normalization, and run persistence | Paper Search |
| Workspace root, Paper Search path roles, research-runtime invariants, and later candidate workflow | Paperflow |
| Long-lived personal library, annotations, and configured collection projections | Zotero when selected by the user/workspace |
| Source-specific PDF retrieval and extraction | External material providers or libraries |

Paper Search can change its providers without changing Paperflow layout, and
Paperflow can change its role mapping by regenerating its Paper Search config.
Neither package imports the other's internal modules.
