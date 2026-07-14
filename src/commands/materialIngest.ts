import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import {
  planMaterialIngest,
  runMaterialIngest,
  type MaterialIngestExecutionData,
  type MaterialIngestPlanData,
} from "../material/ingest.js";
import type { Io } from "../runtime/io.js";
import { failEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";

export interface MaterialIngestCommandOptions {
  attachTo?: string;
  artifactProvider?: string;
  extractProvider?: string;
  provider?: string;
  policy?: string;
  dryRun?: boolean;
  json?: boolean;
}

type MaterialIngestCommandEnvelope =
  | ResultEnvelope<MaterialIngestPlanData>
  | ResultEnvelope<MaterialIngestExecutionData>
  | ResultEnvelope<null>;

export function registerMaterialIngestCommand(material: Command, io: Io): void {
  material
    .command("ingest <input>")
    .description("Run or plan a material workflow from a file, URL, or workspace item.")
    .option("--attach-to <itemId>", "attach records to a local workspace item id")
    .option("--artifact-provider <id>", "material artifact downloader provider id")
    .option("--extract-provider <id>", "material extractor provider id")
    .option("--provider <id>", "alias for --extract-provider")
    .option("--policy <name>", "policy label recorded on artifact and extraction steps")
    .option("--dry-run", "return the shared material ingest plan without writing files or records")
    .option("--json", "emit machine-readable JSON envelope")
    .action(async (input: string, options: MaterialIngestCommandOptions, command: Command) => {
      const started = Date.now();
      let envelope: MaterialIngestCommandEnvelope;
      try {
        const globalOptions = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        const materialOptions = {
          config,
          input,
          attachTo: options.attachTo,
          artifactProviderId: options.artifactProvider,
          extractProviderId: options.extractProvider ?? options.provider,
          policy: options.policy,
        };
        envelope = options.dryRun
          ? await planMaterialIngest(materialOptions)
          : await runMaterialIngest(materialOptions);
      } catch (error) {
        envelope = failEnvelope({
          capability: "orchestrate",
          tool: "material_ingest",
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
