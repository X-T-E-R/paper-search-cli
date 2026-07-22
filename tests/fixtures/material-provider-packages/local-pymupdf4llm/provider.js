globalThis.__material_provider_exports = {
  createProvider(runtimeContext) {
    return {
      async extract(input) {
        if (!input || typeof input !== "object") {
          throw new Error("local-pymupdf4llm input must be an object");
        }
        const source = input.source;
        const localPathInput = source?.kind === "path" && typeof source.path === "string";
        const artifactInput =
          source?.kind === "artifact" &&
          input.artifact &&
          typeof input.artifact === "object" &&
          typeof input.artifact.path === "string";
        if (!localPathInput && !artifactInput) {
          throw new Error(
            "local-pymupdf4llm requires a managed artifact or explicit local PDF path",
          );
        }

        const ocr = runtimeContext.config.get("ocr", false);
        const timeoutMs = runtimeContext.config.get("timeoutMs", 300000);
        if (typeof ocr !== "boolean") {
          throw new Error("local-pymupdf4llm config ocr must be a boolean");
        }
        if (typeof timeoutMs !== "number") {
          throw new Error("local-pymupdf4llm config timeoutMs must be a number");
        }
        const result = await runtimeContext.sidecar.pymupdf4llm.toMarkdown({
          ocr,
          timeoutMs,
        });
        return {
          markdown: result.markdown,
          metadata: result.metadata,
          cacheHit: false,
          message: `Local PyMuPDF4LLM extracted ${result.metadata.pageCount} PDF page(s).`,
        };
      },
    };
  },
};
