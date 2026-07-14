import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Command } from "commander";
import type { Io } from "../runtime/io.js";
import { resolveInstallPaths } from "../runtime/installLayout.js";

interface SetupOptions {
  target: string[];
  binDir?: string;
  apply?: boolean;
  json?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerSetupCommand(program: Command, io: Io): void {
  program
    .command("setup")
    .description("Plan or repair the source-linked skill projections, CLI shim, and verified runtime.")
    .option("--target <skills-dir>", "skills root; repeat for multiple agent roots", collect, [])
    .option("--bin-dir <dir>", "human CLI shim directory")
    .option("--apply", "execute the displayed plan")
    .option("--json", "request JSON output from the installer")
    .action(async (options: SetupOptions) => {
      const paths = resolveInstallPaths();
      const installerPath = path.join(paths.repoRoot, "scripts", "install.mjs");
      const args = [installerPath];
      for (const target of options.target) args.push("--target", target);
      if (options.binDir) args.push("--bin-dir", options.binDir);
      if (options.apply) args.push("--apply");
      if (options.json) args.push("--json");
      const result = spawnSync(process.execPath, args, {
        cwd: paths.repoRoot,
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        io.writeError(`setup failed with exit code ${result.status ?? "unknown"}`);
        process.exitCode = result.status ?? 1;
        return;
      }
    });
}
