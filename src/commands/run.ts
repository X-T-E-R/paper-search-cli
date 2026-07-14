import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { Io } from "../runtime/io.js";
import { mergeToolArguments, ToolArgumentValidationError } from "../surface/toolArguments.js";
import { runCanonicalTool, toolArgumentFailureEnvelope } from "../surface/toolRunner.js";

interface RunCommandOptions {
  jsonArgs?: string;
  arg?: string[];
}

function collectArg(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerRunCommand(program: Command, io: Io): void {
  program
    .command("run <tool>")
    .description("Invoke one canonical tool with schema-validated JSON arguments.")
    .option("--json-args <json>", "canonical tool arguments as a JSON object")
    .option(
      "--arg <key=value>",
      "single canonical tool argument; values parse as booleans, numbers, or JSON when possible",
      collectArg,
      [],
    )
    .action(async (tool: string, options: RunCommandOptions, command: Command) => {
      let args: Record<string, unknown>;
      try {
        args = mergeToolArguments({
          jsonArgs: options.jsonArgs,
          argAssignments: options.arg ?? [],
        });
      } catch (error) {
        io.writeJson(createInvalidRunArgumentsEnvelope(tool, error));
        return;
      }

      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const envelope = await runCanonicalTool(config, tool, args, {
        validateArguments: true,
      });
      io.writeJson(envelope);
    });
}

function createInvalidRunArgumentsEnvelope(tool: string, error: unknown) {
  const message = error instanceof ToolArgumentValidationError || error instanceof Error
    ? error.message
    : String(error);
  return toolArgumentFailureEnvelope(tool, message);
}
