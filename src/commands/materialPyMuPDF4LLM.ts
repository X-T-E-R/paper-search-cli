import type { Command } from "commander";
import {
  setupPyMuPDF4LLMRuntime,
  type SetupPyMuPDF4LLMRuntimeResult,
} from "../material/pymupdf4llm/setup.js";
import type { Io } from "../runtime/io.js";
import { failEnvelope, okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";

interface SetupOptions {
  python?: string;
  apply?: boolean;
  json?: boolean;
}

export function registerMaterialPyMuPDF4LLMCommand(material: Command, io: Io): void {
  material
    .command("setup-local-pymupdf4llm")
    .description("Plan or install the pinned Python 3.11 PyMuPDF4LLM runtime used by the explicit local extractor.")
    .option("--python <absolute-path>", "absolute Python 3.11 executable used only to create the isolated runtime")
    .option("--apply", "create and verify the isolated runtime")
    .option("--json", "emit a machine-readable JSON envelope")
    .action(async (options: SetupOptions) => {
      const started = Date.now();
      let envelope: ResultEnvelope<SetupPyMuPDF4LLMRuntimeResult> | ResultEnvelope<null>;
      try {
        const result = await setupPyMuPDF4LLMRuntime({
          apply: Boolean(options.apply),
          basePython: options.python,
        });
        envelope = okEnvelope({
          capability: "operate",
          tool: "material_setup_local_pymupdf4llm",
          planned: !options.apply,
          data: result,
          diagnostics: { elapsedMs: Date.now() - started },
          provenance: { providerIds: ["local-pymupdf4llm"] },
        });
      } catch (error) {
        envelope = failEnvelope({
          capability: "operate",
          tool: "material_setup_local_pymupdf4llm",
          errors: [error instanceof Error ? error.message : String(error)],
          diagnostics: { elapsedMs: Date.now() - started },
          provenance: { providerIds: ["local-pymupdf4llm"] },
        });
      }

      if (options.json) {
        io.writeJson(envelope);
        return;
      }
      if (!envelope.ok || !envelope.data) {
        throw new Error(envelope.errors?.join("; ") || "PyMuPDF4LLM setup failed");
      }
      io.writeLine(`runtime: ${envelope.data.runtimeRoot}`);
      io.writeLine(`Python: ${envelope.data.pythonRequirement}`);
      io.writeLine(
        `dependencies: pymupdf4llm ${envelope.data.dependencies.pymupdf4llm}, PyMuPDF ${envelope.data.dependencies.pymupdf}`,
      );
      io.writeLine(`license: ${envelope.data.license}`);
      io.writeLine(`status: ${envelope.data.status.ready ? "ready" : envelope.data.status.reason}`);
      if (!options.apply) io.writeLine("dry-run only; pass --apply and an absolute --python path for first-time setup.");
    });
}
