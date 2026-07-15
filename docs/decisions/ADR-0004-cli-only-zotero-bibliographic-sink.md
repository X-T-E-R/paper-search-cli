# ADR-0004: Permit a CLI-only Zotero Bibliographic Sink

Status: superseded by ADR-0005 for selected-item automation and attachments;
retained as the history of the original explicit sink boundary.

- Status: accepted
- Date: 2026-07-15

## Context

The architecture previously prohibited every host-application bridge or profile
writer. Paper Search CLI X needs an optional bibliographic handoff while keeping
local workspace and material records authoritative. Zotero MCP Neo can create
items and notes and can target an existing collection, but it does not advertise
an attachment-import operation. Its multi-step writes are neither atomic nor
idempotent.

## Decision

Permit one narrow host-writer boundary: an explicitly invoked, CLI-only Zotero
sink that talks to a user-authorized Zotero MCP Neo endpoint. It is not a
workspace default sink and is not exposed through canonical tools, MCP, batch,
search, material ingest, or extraction.

The public command is `zotero sink <itemId>`. With no mode flag it produces the
local plan. `--preview` performs the remote dry-run, and
`--apply --ack <previewDigest>` is the only write path. The endpoint must be
enabled in the user-owned Zotero configuration or supplied explicitly for the
invocation; project config does not grant host-write authority.

The operation is plan-first. A local plan makes no remote request or local
mutation. Preview probes Zotero and sends the exact intended writes with
`dryRun: true`. Apply requires an acknowledgement of the preview digest, repeats
the dry-run checks, performs bounded writes, verifies returned keys, and stores a
local receipt. An unavailable endpoint follows the configured error-or-warning
policy and always states that no Zotero write occurred. Partial completion
returns the created item key and is neither retried nor rolled back
automatically.

Version 1 may create a lossy bibliographic item, an optional rendered note, and
membership in one explicit existing collection. It may not create collections,
launch or configure Zotero, access a Zotero profile/database directly, or claim
that local PDF, Markdown, JSON, or asset files were attached.

## Consequences

- Paper Search remains useful and complete without Zotero; local records and
  bytes stay authoritative.
- Host writes require user configuration or an explicit CLI endpoint plus a
  preview acknowledgement. Project configuration cannot silently grant this
  authority.
- The adapter reports omitted metadata and attachment limitations.
- Canonical/MCP or attachment-import exposure requires a later ADR and verified
  adapter capabilities.
