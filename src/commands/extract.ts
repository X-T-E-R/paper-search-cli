import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import {
  planMaterialExtraction,
  runMaterialExtraction,
  type MaterialExtractionData,
} from "../material/extract.js";
import type { Io } from "../runtime/io.js";
import { failEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import type { PlannedOperationData } from "../surface/plan.js";

interface ExtractCommandOptions {
  attachTo?: string;
  provider?: string;
  policy?: string;
  dryRun?: boolean;
  json?: boolean;
}

type ExtractCommandEnvelope =
  | ResultEnvelope<MaterialExtractionData>
  | ResultEnvelope<PlannedOperationData>
  | ResultEnvelope<null>;

export function registerExtractCommand(program: Command, io: Io): void {
  program
    .command("extract <input>")
    .description("Extract Markdown from an artifact id, local file path, or URL through a material provider.")
    .option("--attach-to <itemId>", "attach the extraction record to a local workspace item id")
    .option("--provider <id>", "material extractor provider id; defaults to the first usable extractor")
    .option("--policy <name>", "policy label recorded on the extraction run")
    .option("--dry-run", "return the shared extraction plan without writing outputs or records")
    .option("--json", "emit machine-readable JSON envelope")
    .action(async (input: string, options: ExtractCommandOptions, command: Command) => {
      const started = Date.now();
      let envelope: ExtractCommandEnvelope;
      try {
        const globalOptions = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        const materialOptions = {
          config,
          input,
          attachTo: options.attachTo,
          providerId: options.provider,
          policy: options.policy,
        };
        envelope = options.dryRun
          ? await planMaterialExtraction(materialOptions)
          : await runMaterialExtraction(materialOptions);
      } catch (error) {
        envelope = failEnvelope({
          capability: "extract",
          tool: "extract",
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
