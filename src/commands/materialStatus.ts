import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import { runMaterialStatus, type MaterialStatusData } from "../material/status.js";
import type { Io } from "../runtime/io.js";
import { failEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";

interface MaterialStatusCommandOptions {
  json?: boolean;
}

type MaterialStatusCommandEnvelope = ResultEnvelope<MaterialStatusData> | ResultEnvelope<null>;

export function registerMaterialStatusCommand(material: Command, io: Io): void {
  material
    .command("status <target>")
    .description("Report artifact and extracted-output status for a workspace item, artifact, or extraction.")
    .option("--json", "emit machine-readable JSON envelope")
    .action(async (target: string, _options: MaterialStatusCommandOptions, command: Command) => {
      const started = Date.now();
      let envelope: MaterialStatusCommandEnvelope;
      try {
        const globalOptions = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        envelope = await runMaterialStatus({ config, input: target });
      } catch (error) {
        envelope = failEnvelope({
          capability: "orchestrate",
          tool: "material_status",
          errors: [formatError(error)],
          diagnostics: { elapsedMs: Date.now() - started },
        });
      }

      io.writeJson(envelope);
    });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
