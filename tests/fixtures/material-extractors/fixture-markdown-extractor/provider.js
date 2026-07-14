var __material_provider_exports = {
  createProvider(context) {
    return {
      async extract(input) {
        const source = input && input.source ? input.source : {};
        const sourceValue = source.path || source.url || source.artifactId || "unknown";
        const attachment = input && input.attachTo ? input.attachTo : "standalone";
        const policy = input && input.policy ? input.policy : "default";
        const mode = context.config.get("mode", "fixture");
        return {
          markdown: [
            "# Fixture Markdown Extraction",
            "",
            `Source kind: ${source.kind || "unknown"}`,
            `Source: ${sourceValue}`,
            `Attachment: ${attachment}`,
            `Policy: ${policy}`,
            `Mode: ${mode}`
          ].join("\n") + "\n",
          metadata: {
            fixture: true,
            sourceKind: source.kind || "unknown",
            attachment,
            policy,
            mode
          },
          cacheHit: false
        };
      }
    };
  }
};
globalThis.__material_provider_exports = __material_provider_exports;
