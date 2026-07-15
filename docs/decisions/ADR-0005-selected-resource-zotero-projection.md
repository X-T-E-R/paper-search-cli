# ADR-0005: Project Selected Resources to Zotero MCP Neo

Status: accepted; supersedes ADR-0004 where this decision differs.

## Context

Paper Search search hits are candidates, while workspace items are selected
records and Paperflow evidence is a later verified state. Downloads need a
predictable default destination, Paperflow needs its project files without a
wrapper command, and Zotero may be used globally or for exact workspace
collections. Zotero must not become the authoritative copy of project material.

## Decision

1. Successful downloads use `material.downloadDisposition = "selected"` by
   default. Selection occurs only after bytes commit and reuses DOI, source-id,
   or URL identity. `"materialized"` retains standalone artifacts.
2. Paperflow generates Paper Search roots for run history, selected metadata,
   artifacts, extractions, and exports. Users still invoke `paper-search`
   directly; Paperflow is the directory and research-workflow layer.
3. Zotero connection and global defaults are user-level. Project
   `zoteroBinding.mode` is `inherit`, `off`, or `bound`; a bound workspace owns
   an exact list of existing collection keys plus attachment/Markdown modes.
4. Search hits never trigger Zotero. Explicit selection and selected downloads
   may project when durably configured.
5. Paper Search stores item/attachment mappings and complete, partial, or
   pending receipts locally. Zotero unavailability never rolls back local
   selection, download, or extraction.
6. Zotero MCP Neo may create/update mapped items and notes, and link/import
   durable local files. Collections are referenced but never created.
7. The explicit `zotero sink` plan/preview/apply surface remains for manual
   control and first-time binding to an existing Zotero item.
8. A first-time attachment whose parent item does not exist yet is previewed in
   two stages: the acknowledged digest binds its action/path/mode template, and
   apply performs the remote attachment dry-run after the parent key is created
   but before the attachment write.

## Consequences

- Local Paper Search/Paperflow paths remain the recovery authority.
- Repeated sync avoids recreating mapped items and attachments.
- Import mode copies a file into Zotero storage; link mode depends on the
  workspace file remaining reachable.
- Multi-step host writes are not atomic. Receipts expose pending or partial
  state instead of claiming rollback.
- If Zotero returns an attachment key but post-write verification fails, the
  mapping records that key as unverified. A retry asks Zotero MCP Neo to verify
  that exact attachment instead of creating another one.
- If a remote write succeeds but the canonical mapping write fails, the partial
  receipt carries a recovery mapping. Planning reads that receipt before it can
  create another remote item, then persists the canonical mapping on a
  successful retry.
