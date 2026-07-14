import type { Command } from "commander";
import type { Io } from "../runtime/io.js";
import { inspectInstallHealth } from "../runtime/installLayout.js";
import { okEnvelope } from "../surface/resultEnvelope.js";

interface PathsOptions {
  json?: boolean;
}

export function registerPathsCommand(program: Command, io: Io): void {
  program
    .command("paths")
    .description("Show the independent repository, config, data, bin, state, and build paths.")
    .option("--json", "emit a machine-readable envelope")
    .action(async (options: PathsOptions) => {
      const health = await inspectInstallHealth();
      const paths = {
        ...health.paths,
        managedBinRoot: health.path.binRoot,
        binOnPath: health.path.onPath,
      };
      if (options.json) {
        io.writeJson(okEnvelope({ capability: "operate", tool: "paths", data: paths }));
        return;
      }
      for (const [key, value] of Object.entries(paths)) io.writeLine(`${key}: ${value}`);
    });
}
