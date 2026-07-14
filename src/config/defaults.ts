import { resolveDefaultUserConfigPath } from "./paths.js";
import { resolvePaperSearchPaths } from "./home.js";
import type { ResolvedConfig } from "./schema.js";

export function createDefaultConfig(
  env: NodeJS.ProcessEnv = process.env,
): Omit<ResolvedConfig, "meta"> {
  const paths = resolvePaperSearchPaths(env);
  return {
    providers: {
      registryUrl: "https://github.com/X-T-E-R/resource-search-providers",
      installDir: paths.providersRoot,
      autoUpdate: false,
      allowReleaseFallback: true,
    },
    workspace: {
      root: paths.workspaceRoot,
      defaultSink: "workspace",
      defaultCollection: "inbox",
    },
    storage: {
      artifactRoot: paths.artifactRoot,
      extractionRoot: paths.extractionRoot,
      exportRoot: paths.exportRoot,
    },
    runs: {
      root: paths.runsRoot,
      maxAgeDays: -1,
    },
    zotero: {
      enabled: false,
      endpoint: "http://127.0.0.1:23120/mcp",
      timeoutMs: 15_000,
      unavailable: "error",
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
      defaultAcademicPresets: ["general"],
      defaultPatentPresets: ["patents"],
      classifications: {},
      presets: {},
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
}

/** Compatibility snapshot for call sites that do not perform environment-aware loading. */
export const DEFAULT_CONFIG: Omit<ResolvedConfig, "meta"> = createDefaultConfig();

export function describeDefaultConfigPaths(cwd: string): {
  userConfigPath: string;
  projectConfigCandidates: string[];
} {
  return {
    userConfigPath: resolveDefaultUserConfigPath(),
    projectConfigCandidates: [`${cwd}/paper-search.toml`, `${cwd}/.paper-search.toml`],
  };
}
