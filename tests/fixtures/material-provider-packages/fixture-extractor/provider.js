var __material_provider_exports = {
  createProvider() {
    return {
      inspect() {
        return {
          canExtract: true,
          outputs: ["markdown", "json"]
        };
      },
      async extract(input) {
        return {
          input,
          markdown: "# Fixture Extraction",
          metadata: { fixture: true }
        };
      }
    };
  }
};
globalThis.__material_provider_exports = __material_provider_exports;
