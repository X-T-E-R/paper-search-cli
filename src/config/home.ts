import os from "node:os";
import path from "node:path";

export interface PaperSearchPaths {
  home: string;
  configRoot: string;
  configPath: string;
  configFragmentsRoot: string;
  subscriptionsPath: string;
  credentialsPath: string;
  externalSearchPath: string;
  adaptersRoot: string;
  binRoot: string;
  providersRoot: string;
  registriesRoot: string;
  cacheRoot: string;
  stateRoot: string;
  runsRoot: string;
  workspaceRoot: string;
  artifactRoot: string;
  extractionRoot: string;
  exportRoot: string;
}

/**
 * Resolve the sole conventional Paper Search authority without loading config.
 * PAPER_SEARCH_TEST_DATA_ROOT is deliberately inert outside install test mode.
 */
export function resolvePaperSearchHome(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = os.homedir(),
): string {
  const explicit = env.PAPER_SEARCH_HOME?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error("PAPER_SEARCH_HOME must be an absolute path");
    }
    return path.normalize(explicit);
  }

  const testRoot = env.PAPER_SEARCH_TEST_DATA_ROOT?.trim();
  if (env.PAPER_SEARCH_INSTALL_TEST_MODE === "1" && testRoot) {
    return path.resolve(testRoot);
  }

  return path.join(userHome, ".paper-search");
}

export function resolvePaperSearchPaths(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = os.homedir(),
): PaperSearchPaths {
  const home = resolvePaperSearchHome(env, userHome);
  return {
    home,
    configRoot: home,
    configPath: path.join(home, "config.toml"),
    configFragmentsRoot: path.join(home, "config.d"),
    subscriptionsPath: path.join(home, "subscriptions.toml"),
    credentialsPath: path.join(home, "credentials.toml"),
    externalSearchPath: path.join(home, "external-search.toml"),
    adaptersRoot: path.join(home, "adapters"),
    binRoot: path.join(home, "bin"),
    providersRoot: path.join(home, "providers"),
    registriesRoot: path.join(home, "registries"),
    cacheRoot: path.join(home, "cache"),
    stateRoot: path.join(home, "state"),
    runsRoot: path.join(home, "runs"),
    workspaceRoot: path.join(home, "workspace"),
    artifactRoot: path.join(home, "storage", "artifacts"),
    extractionRoot: path.join(home, "storage", "extractions"),
    exportRoot: path.join(home, "exports"),
  };
}
