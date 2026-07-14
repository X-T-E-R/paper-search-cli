import { resolveDefaultUserConfigPath } from "./paths.js";
import type { ResolvedConfig } from "./schema.js";

export const DEFAULT_CONFIG: Omit<ResolvedConfig, "meta"> = {
  providers: {
    registryUrl: "https://github.com/X-T-E-R/resource-search-providers",
    installDir: "~/.paper-search/providers",
    autoUpdate: false,
    allowReleaseFallback: true,
  },
  workspace: {
    root: "./.paper-search/workspace",
    defaultSink: "workspace",
    defaultCollection: "inbox",
  },
  server: {
    enabled: false,
    transport: "http",
    host: "127.0.0.1",
    port: 23121,
  },
  defaults: {
    timeoutMs: 30_000,
    maxResults: 10,
  },
  output: {
    format: "table",
    locale: "zh-CN",
    prettyJson: true,
  },
  smoke: {
    enabled: true,
    envVar: "PAPER_SEARCH_RUN_SMOKE",
  },
  search: {
    selection: {
      mode: "defaults",
      includeIds: [],
      excludeIds: [],
      includeDomains: [],
      excludeDomains: [],
      includeContentKinds: [],
      excludeContentKinds: [],
      includeAccess: [],
      excludeAccess: [],
    },
  },
  platform: {},
  api: {},
};

export function describeDefaultConfigPaths(cwd: string): {
  userConfigPath: string;
  projectConfigCandidates: string[];
} {
  return {
    userConfigPath: resolveDefaultUserConfigPath(),
    projectConfigCandidates: [`${cwd}/paper-search.toml`, `${cwd}/.paper-search.toml`],
  };
}
