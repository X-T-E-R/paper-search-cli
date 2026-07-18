import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { Io } from "../runtime/io.js";
import { runCanonicalTool } from "../surface/toolRunner.js";
import { acceptAlwaysJsonFlag } from "./alwaysJson.js";

interface AssessmentInputOptions {
  snapshot: string;
  sha256: string;
  policy?: string;
}

async function readPolicy(filePath: string | undefined): Promise<unknown> {
  if (!filePath) return undefined;
  const text = await readFile(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Assessment policy must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function inputOptions(command: Command): Command {
  return command
    .requiredOption("--snapshot <path>", "immutable assessment snapshot JSON path")
    .requiredOption("--sha256 <digest>", "exact lowercase SHA-256 of the snapshot bytes")
    .option("--policy <path>", "optional transparent policy JSON path");
}

export function registerAssessmentCommands(program: Command, io: Io): void {
  const assess = program
    .command("assess")
    .description("Inspect source-backed observations, conflicts, and explicit policy traces.");

  for (const mode of ["plan", "run"] as const) {
    acceptAlwaysJsonFlag(inputOptions(
      assess.command(mode).description(
        mode === "plan"
          ? "Validate and evaluate a snapshot without creating a durable run."
          : "Evaluate a snapshot and persist one durable assessment run.",
      ),
    )).action(async (options: AssessmentInputOptions, command: Command) => {
      try {
        const global = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: global.config });
        io.writeJson(await runCanonicalTool(config, "assessment_run", {
          mode,
          snapshotPath: options.snapshot,
          snapshotSha256: options.sha256,
          ...(options.policy ? { policy: await readPolicy(options.policy) } : {}),
        }));
      } catch (error) {
        io.writeJson({
          ok: false,
          capability: "assess",
          tool: "assessment_run",
          data: null,
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    });
  }

  acceptAlwaysJsonFlag(assess
    .command("show <run-id>")
    .description("Replay a completed assessment from stored observations without reading the snapshot."))
    .option("--policy <path>", "optional replacement transparent policy JSON path")
    .action(async (runId: string, options: { policy?: string }, command: Command) => {
      try {
        const global = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: global.config });
        io.writeJson(await runCanonicalTool(config, "assessment_show", {
          runId,
          ...(options.policy ? { policy: await readPolicy(options.policy) } : {}),
        }));
      } catch (error) {
        io.writeJson({
          ok: false,
          capability: "assess",
          tool: "assessment_show",
          data: null,
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    });

  acceptAlwaysJsonFlag(assess
    .command("list")
    .description("List durable assessment run headers."))
    .action(async (_options: unknown, command: Command) => {
      const global = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: global.config });
      io.writeJson(await runCanonicalTool(config, "assessment_list", {}));
    });
}
