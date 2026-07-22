import type { Command } from "commander";
import type { Io } from "../runtime/io.js";
import { inspectInstallHealth } from "../runtime/installLayout.js";
import { okEnvelope } from "../surface/resultEnvelope.js";
import { resolvePaperSearchPaths } from "../config/home.js";
import { planConfigLocationMigration } from "../config/locationMigration.js";

interface PathsOptions {
  json?: boolean;
}

export function registerPathsCommand(program: Command, io: Io): void {
  program
    .command("paths")
    .description("Show the authoritative Paper Search home and every conventional runtime path.")
    .option("--json", "emit a machine-readable envelope")
    .action(async (options: PathsOptions) => {
      const [health, migration] = await Promise.all([
        inspectInstallHealth(),
        planConfigLocationMigration(),
      ]);
      const conventional = resolvePaperSearchPaths();
      const paths = {
        ...health.paths,
        paperSearchHome: conventional.home,
        config: conventional.configPath,
        configFragments: conventional.configFragmentsRoot,
        subscriptions: conventional.subscriptionsPath,
        credentials: conventional.credentialsPath,
        externalSearch: conventional.externalSearchPath,
        adapters: conventional.adaptersRoot,
        providers: conventional.providersRoot,
        registries: conventional.registriesRoot,
        cache: conventional.cacheRoot,
        state: conventional.stateRoot,
        runs: conventional.runsRoot,
        workspace: conventional.workspaceRoot,
        artifactStorage: conventional.artifactRoot,
        extractionStorage: conventional.extractionRoot,
        exports: conventional.exportRoot,
        managedBinRoot: health.path.binRoot,
        binOnPath: health.path.onPath,
        configLocationMigration: migration,
      };
      if (options.json) {
        io.writeJson(okEnvelope({ capability: "operate", tool: "paths", data: paths }));
        return;
      }
      for (const [key, value] of Object.entries(paths)) {
        io.writeLine(`${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
      }
    });
}
