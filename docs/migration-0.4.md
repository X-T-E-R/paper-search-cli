# Migrating to 0.4

Paper Search 0.4 removes the built-in Tavily, Firecrawl, Exa, xAI, and MySearch
Web adapters and the `web_research` command/tool. The remaining `web_search`
surface uses External Search v1 and is optional.

1. Install an External Search v1 implementation independently. The provided
   native implementation is search-layer's `scripts/paper_search_external.py`.
2. Copy `external-search.example.toml` to the conventional Paper Search user
   config root as `external-search.toml` and update the executable, fixed args,
   and working directory.
3. Run `paper-search status --json` for static checks, then
   `paper-search doctor --json` for the protocol-defined no-network probe.
4. Replace `web-research` calls with `web`/`web_search` and the v1 fields:
   `query`, `mode`, optional `intent`/`freshness`, and `maxResults`.

Project config, project fragments, and `--config` files cannot authorize an
executable or adapter. Custom adapters must be trusted `.mjs` files at
`<configRoot>/adapters/<name>.mjs`; they execute in a child process and are not
sandboxed.

Retired `[api.tavily]`, `[api.firecrawl]`, `[api.exa]`, `[api.xai]`, and
`[api.mysearch]` values are left untouched. They no longer authorize Web
execution; doctor reports populated secret-like values only as masked, unused
legacy settings. No workspace, subscription, provider package, or paper data
migration is required. Rollback is a code/config revert or simply setting
`enabled = false` in `external-search.toml`.
