var __material_provider_exports = {
  createProvider(context) {
    return {
      async resolve(input) {
        const mode = context.config.get("mode", "multi");
        const identifier =
          input && input.identifier
            ? input.identifier
            : { scheme: "doi", value: "10.0000/fixture" };
        const provenance = {
          providerId: "fixture-artifact-resolver",
          source: "fixture-resolver",
          retrievedAt: new Date().toISOString(),
        };
        if (mode === "error") {
          throw new Error("fixture resolver intentional failure");
        }
        if (mode === "empty") {
          return { identifier, candidates: [], provenance };
        }
        const doiSuffix = identifier.value.replace(/[^a-zA-Z0-9]+/g, "-");
        return {
          identifier,
          candidates: [
            {
              url: `https://example.test/resolver/${doiSuffix}-primary.pdf`,
              host: "repository",
              version: "publishedVersion",
              contentType: "application/pdf",
              note: "fixture primary candidate",
            },
            {
              url: `https://example.test/resolver/${doiSuffix}-fallback.pdf`,
              host: "publisher",
              contentType: "application/pdf",
              note: "fixture fallback candidate",
            },
          ],
          provenance,
        };
      },
    };
  },
};
globalThis.__material_provider_exports = __material_provider_exports;
