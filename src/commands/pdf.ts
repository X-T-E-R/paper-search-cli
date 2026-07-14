import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { Io } from "../runtime/io.js";
import { fetchPdfForWorkspaceItem, type WorkspacePdfResult } from "../workspace/store.js";
import { failEnvelope, okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";

function resourcePdfEnvelope(
  data: WorkspacePdfResult,
  workspaceRoot: string,
): ResultEnvelope<WorkspacePdfResult> | ResultEnvelope<null> {
  if (!data.ok) {
    return failEnvelope({
      capability: "acquire",
      tool: "resource_pdf",
      errors: [data.message ?? "PDF attachment failed"],
      diagnostics: { workspaceRoot, rawPayload: data },
    });
  }
  return okEnvelope({
    capability: "acquire",
    tool: "resource_pdf",
    data,
    diagnostics: { workspaceRoot },
    provenance: { providerIds: data.sourceUrl ? [data.sourceUrl] : undefined },
  });
}

export function registerPdfCommands(program: Command, io: Io): void {
  program
    .command("resource-pdf <itemKey>")
    .alias("resource_pdf")
    .alias("pdf")
    .description("Fetch or record a PDF attachment for a local workspace item.")
    .option("--url <url>", "explicit PDF URL to attach instead of discovering one from the item/detail payload")
    .option("--filename <name>", "preferred local filename")
    .option("--download", "download the PDF into the local attachment sink", true)
    .option("--no-download", "record a requested PDF attachment without downloading it")
    .option("--json", "emit machine-readable JSON")
    .action(async (itemKey: string, options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const result = await fetchPdfForWorkspaceItem(config.workspace.root, {
        itemKey,
        url: typeof options.url === "string" ? options.url : undefined,
        filename: typeof options.filename === "string" ? options.filename : undefined,
        download: options.download !== false,
      });
      const envelope = resourcePdfEnvelope(result, config.workspace.root);
      if (options.json) {
        io.writeJson(envelope);
        return;
      }
      io.writeLine(result.message ?? (result.ok ? "PDF attachment updated" : "PDF attachment failed"));
      io.writeJson(envelope);
    });
}
