# ADR-0003: Promote `assess` as a Transparent Evidence Workflow

- Status: accepted
- Date: 2026-07-15
- Supersedes: the 2026-07-08 pre-implementation decision in this ADR

## Context

The original decision withheld a public `assess` surface until it had an
independent, executable workflow. Paper Search CLI X now has one: it can
validate an exact work or venue identity, ingest an immutable checksum-bound
local observation snapshot, preserve conflicts and missing coverage, apply an optional explicit
policy, and persist or replay the complete trace in the common durable-run
store.

This workflow must remain separate from search ranking and deduplication. It
reports provider-backed observations rather than turning heterogeneous evidence
into an opaque universal score.

## Decision

Promote `assess` as an implemented capability with these public surfaces:

- CLI: `assess plan`, `assess run`, `assess show`, and `assess list`;
- canonical/MCP: `assessment_run`, `assessment_show`, and `assessment_list`;
- batch: `assessment_run` through the shared schema.

`assess plan` evaluates without creating a durable run. `assess run` requires a
local snapshot path and its exact lowercase SHA-256, then persists observations,
conflicts, provenance, and any policy trace. `assess show` replays stored
evidence without rereading the snapshot and may apply a replacement explicit
policy.

Without a policy there is no disposition. A policy may return `include`,
`exclude`, or `review`, but must cite the exact rule and observation ids used.
Missing or conflicting required evidence remains visible. Assessment must not
claim universal paper quality, misconduct, legality, scientific truth, or a
user-independent acceptance decision, and it must not alter discovery order or
deduplication.

## Consequences

- Offline assessment is useful and reproducible without requiring a live
  network provider.
- Snapshot checksums, source/version/time fields, raw-evidence digests, coverage
  outcomes, and conflict groups remain auditable.
- Users may encode their own transparent policy while retaining responsibility
  for the decision.
- Future live assessment providers must preserve the same observation and
  provenance contract rather than hiding a score inside a search provider.
