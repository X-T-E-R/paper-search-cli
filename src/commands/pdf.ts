import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { Io } from "../runtime/io.js";
import { failEnvelope } from "../surface/resultEnvelope.js";
import { planResourcePdfCompatibility, runResourcePdfCompatibility } from "../material/resourcePdf.js";

export function registerPdfCommands(program: Command, io: Io): void {
  program
    .command("resource-pdf <itemKey>")
    .alias("resource_pdf")
    .alias("pdf")
    .description("Acquire or record a PDF through material providers and link it to a workspace item.")
    .option("--url <url>", "explicit PDF URL to attach instead of discovering one from the item/detail payload")
    .option("--filename <name>", "preferred local filename")
    .option("--provider <id>", "material artifact downloader provider id")
    .option("--resolver <id>", "material artifact resolver provider id for DOI inputs")
    .option("--policy <name>", "policy label recorded on the acquisition")
    .option("--download", "download the PDF into configured local artifact storage", true)
    .option("--no-download", "record a provider-attributed PDF request without downloading bytes")
    .option("--dry-run", "plan the provider-mediated acquisition without network or writes")
    .option("--json", "emit machine-readable JSON")
    .action(async (itemKey: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      try {
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        const materialOptions = {
          config,
          itemKey,
          url: typeof options.url === "string" ? options.url : undefined,
          filename: typeof options.filename === "string" ? options.filename : undefined,
          providerId: typeof options.provider === "string" ? options.provider : undefined,
          resolverProviderId: typeof options.resolver === "string" ? options.resolver : undefined,
          policy: typeof options.policy === "string" ? options.policy : undefined,
          download: options.download !== false,
        };
        const envelope = options.dryRun
          ? await planResourcePdfCompatibility(materialOptions)
          : await runResourcePdfCompatibility(materialOptions);
        io.writeJson(envelope);
      } catch (error) {
        io.writeJson(failEnvelope({
          capability: "acquire",
          tool: "resource_pdf",
          errors: [error instanceof Error ? error.message : String(error)],
        }));
      }
    });
}
