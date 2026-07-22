import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { Io } from "../runtime/io.js";
import type { ResearchRunStore } from "../runs/index.js";
import {
  durableToolRejection,
  runDurableCanonicalTool,
} from "../runs/durable.js";
import {
  mergeToolArguments,
  ToolArgumentValidationError,
} from "../surface/toolArguments.js";
import {
  executeCanonicalToolWithinDurableRun,
  toolArgumentFailureEnvelope,
} from "../surface/toolRunner.js";
import { failEnvelope } from "../surface/resultEnvelope.js";
import {
  openRunStoreFromResolvedConfig,
  type ConfiguredRunStoreResolver,
} from "../runs/config.js";
import { acceptAlwaysJsonFlag } from "./alwaysJson.js";

export {
  DURABLE_DISCOVERY_TOOL_ALLOWLIST,
  durableToolRejection,
  runDurableCanonicalTool,
} from "../runs/durable.js";

interface RunCommandOptions {
  jsonArgs?: string;
  arg?: string[];
}

export interface RegisterRunCommandOptions {
  resolveStore?: ConfiguredRunStoreResolver;
}

function collectArg(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerRunCommand(
  program: Command,
  io: Io,
  registration: RegisterRunCommandOptions = {},
): void {
  const resolveStore = registration.resolveStore ?? openRunStoreFromResolvedConfig;
  acceptAlwaysJsonFlag(program
    .command("run <tool>")
    .description("Durably invoke one allowlisted, non-destructive discovery tool."))
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
      const rejection = durableToolRejection(tool, args);
      if (rejection) {
        io.writeJson(rejection);
        return;
      }

      let store: ResearchRunStore;
      try {
        store = await resolveStore(config);
      } catch (error) {
        io.writeJson(failEnvelope({
          capability: "orchestrate",
          tool,
          errors: [`Durable run persistence failed: ${error instanceof Error ? error.message : String(error)}`],
          diagnostics: { reason: "run_persistence_failed" },
        }));
        return;
      }
      io.writeJson(await runDurableCanonicalTool(
        config,
        store,
        tool,
        args,
        (name, input) => executeCanonicalToolWithinDurableRun(config, name, input),
      ));
    });
}

function createInvalidRunArgumentsEnvelope(tool: string, error: unknown) {
  const message = error instanceof ToolArgumentValidationError || error instanceof Error
    ? error.message
    : String(error);
  return toolArgumentFailureEnvelope(tool, message);
}
