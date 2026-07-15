# Paperflow integration boundary

Paper Search is the discovery engine. Paperflow resolves the project directory
and semantic path roles. A project-side bibliography/catalog skill owns selected
records. The systems integrate through machine-readable adapters; neither system
imports the other's internal modules or treats the other's configuration file as
its own authority.

| Concern | Owner |
| --- | --- |
| Provider selection, search, lookup, citation traversal, assessment, normalization, provenance, and search history | Paper Search |
| Project root discovery, semantic path roles, and research-runtime invariants | Paperflow |
| Selected-source catalog and bibliography/material records | A project-side bibliography/catalog skill, optionally using Zotero |
| Long-lived personal reference library, annotations, and library-wide duplicate management | Zotero when the user chooses it |
| Source-specific PDF retrieval and extraction | External material providers or libraries |

The Paper Search compatibility workspace is not a second Paperflow project.
Existing workspace/material/Zotero commands remain usable for older and small
headless workflows, but new project integrations should not mirror a Paperflow
directory tree below `~/.paper-search/`.

## Adapter direction

The integration is bidirectional at the adapter boundary:

1. **Paperflow to Paper Search:** a Paperflow-side adapter invokes a canonical
   Paper Search tool through the CLI or MCP and supplies only that tool's JSON
   arguments. It may resolve Paperflow roles before or after the call, but Paper
   Search does not read `paperflow.yaml`.
2. **Paper Search to the project:** the adapter consumes the returned
   `ResultEnvelope`, lets the user or calling workflow select records, resolves
   the relevant Paperflow roles, and hands those records to the chosen
   bibliography/catalog skill. Paper Search does not write project files.

The stable return boundary is:

```json
{
  "ok": true,
  "capability": "discover",
  "tool": "academic_search",
  "data": {},
  "diagnostics": {
    "historyRecorded": true,
    "runId": "..."
  },
  "provenance": {
    "providerIds": ["..."]
  }
}
```

Consumers must read `data`, `diagnostics`, and `provenance`; they must not parse
human terminal text or derive project paths from Paper Search storage paths. A
production adapter should version its own import payload and validate the
tool-specific `data` schema. `paper-search runs export` is suitable for audit or
manual transport, but its bounded run record is not the long-term catalog-import
contract.

## History and project references

Real discovery calls record a private local run by default. A project-side
record may retain the Paper Search `runId`, canonical tool, provider provenance,
and selected item identity as origin metadata. The adapter should not copy every
global search run into the project or treat an unselected search result as a
project source.

Opting out is explicit:

```bash
paper-search academic "query" --no-history
```

Canonical and MCP callers use `recordHistory: false`. A user can also set
`runs.recordByDefault = false`; `paper-search run <tool>` remains explicitly
durable. Search plans and dry-runs write no history.

## Recommended project flow

```text
Paperflow project/query context
  -> Paper Search canonical invocation
  -> ResultEnvelope + run id
  -> explicit record selection
  -> Paperflow-side path adapter
  -> selected bibliography/catalog skill
  -> optional external material provider or Zotero handoff
```

This keeps the search engine independently installable and lets Paperflow change
its directory layout by updating path roles without requiring a Paper Search
release.
