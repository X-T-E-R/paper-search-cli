# ADR-0003: Keep `assess` Reserved Until It Has an Independent Workflow

- Status: accepted
- Date: 2026-07-08

## Context

The capability map includes `assess` for ranking, deduplication, and source or
journal metrics. No independent CLI command, canonical tool, or MCP operation
currently owns that workflow. Adding a placeholder command only to fill the map
would expand the public contract without a real user action or durable output.

## Decision

Keep `assess` as a documented reserved capability group. The tool catalog must
not advertise an `assess` tool until at least one of these conditions exists:

- a standalone offline workflow for ranking or deduplicating stored records;
- a provider-backed source or journal metrics report; or
- a concrete MCP or skill consumer that needs an independent assess entry.

The contract test keeps the capability map and reader-facing documentation in
sync. Implementing a real assess workflow requires removing the reserved label
and updating that test in the same change.

## Consequences

- The public tool catalog lists only executable capabilities.
- Agents receive an explicit signal not to route work to a nonexistent tool.
- The capability can be promoted without redesigning the surrounding map once
  an independent workflow exists.
