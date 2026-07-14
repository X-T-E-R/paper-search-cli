# ADR-0002: Separate Material Provider Repository

- Status: accepted
- Date: 2026-07-08

## Context

Search providers are also consumed by a Zotero integration whose registry has
its own compatibility contract. Material resolvers, downloaders, extractors,
converters, and enrichers use a different manifest schema and a CLI-version
gate. Publishing both package families from one registry would couple their
release cadence and overload the meaning of existing search-provider fields.

## Decision

Publish material providers from the independent
[`X-T-E-R/material-providers`](https://github.com/X-T-E-R/material-providers)
repository. Its registry uses `kind`, `downloadUrl`, `sha256`, and
`minCliVersion`; Paper Search accepts `minPluginVersion` only as a compatibility
alias. Search providers remain in
[`X-T-E-R/resource-search-providers`](https://github.com/X-T-E-R/resource-search-providers).

Paper Search treats the two registries as independent subscriptions and writes
installed packages to kind-separated directories. Both repositories publish
immutable archive releases. The material repository's mutable release is
strictly registry-only. Paper Search also consumes only `registry.json` from the
search repository's mutable release, while that release retains legacy ZIP
assets so previously published URLs keep working.

## Consequences

- The Zotero-facing search registry keeps its existing schema and release
  cadence.
- Material providers can evolve their capabilities without search-host
  compatibility risk.
- Operators configure two subscription URLs, while the CLI presents one
  provider lifecycle surface.
- Maintaining two release workflows is an accepted cost; any later merge needs
  a new compatibility decision.
