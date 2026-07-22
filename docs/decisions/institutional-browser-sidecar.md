# Institutional browser acquisition sidecar

## Decision

Paper Search owns institutional jobs, artifact commits, workspace selection,
Paperflow-root bindings, and optional Zotero projection. A bundled, replaceable
Python adapter is launched only by local CLI `institutional continue`: either a
human interactive TTY or an agent-assisted attempt authorized by conventional
user policy.
It targets InstSci commit `836cd6b65ad74136b7a1ff17672816a3b8b789aa` and
invokes only the single-DOI publisher batch workflow.

The adapter uses a versioned one-request/one-response JSON protocol over
stdin/stdout. The host supplies a fixed adapter, an absolute regular Python
executable, a small environment allowlist, and no caller-defined arguments or
working directory. Probe is browser-free; acquisition scratch is always removed.

Agent policy defaults to `ask`. A one-attempt grant is an ACL-restricted atomic
receipt bound to job, profile, context digest, next attempt, and expiry, and is
consumed before the sidecar starts. Durable `allow` applies only to explicitly
listed profiles; `off` blocks agent-assisted attempts without affecting human
TTY continuation. Neither configuration, a grant, an environment variable, nor
a caller claim supplies browser-control capability. Canonical/MCP expose none of
the continuation, grant, policy-mutation, or agent authority fields.

Each job preallocates its artifact commit identity and persists the first commit
start time. Recovery validates and reuses matching bytes, artifact metadata,
selection, and only a durable Zotero receipt correlated by exact institutional
job id, artifact id, and storage digest. Item/time heuristics are not recovery
authority. Conflicting bytes or metadata fail closed instead of allocating a
second artifact.

## Consequences

- The feature is user-global, disabled by default, and opted into per DOI after
  ordinary acquisition fails.
- Canonical and MCP can create and inspect jobs but cannot launch the browser or
  mutate/consume agent authorization.
- Only a contained, regular, non-reparse, size-bounded PDF with matching header,
  size, and SHA-256 enters the existing artifact store.
- InstSci search, OA fallback, jobs, broker, cache, extraction, and diagnostics
  remain outside Paper Search authority.
