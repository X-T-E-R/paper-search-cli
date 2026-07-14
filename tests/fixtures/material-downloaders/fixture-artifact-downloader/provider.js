var __material_provider_exports = {
  createProvider(context) {
    return {
      async download(input) {
        const mode = context.config.get("mode", "fixture");
        const policy = input && input.policy ? input.policy : "default";
        const attachTo = input && input.attachTo ? input.attachTo : "standalone";
        const url = input && input.url ? input.url : "https://example.test/fixture.pdf";
        return {
          kind: "pdf",
          filename: "fixture-download.pdf",
          contentType: "application/pdf",
          remoteUrl: url,
          status: 200,
          bytesBase64: "Zml4dHVyZSBkb3dubG9hZGVyIGJ5dGVzCg==",
          message: `Fixture artifact download (${mode}, ${policy}, ${attachTo})`
        };
      }
    };
  }
};
globalThis.__material_provider_exports = __material_provider_exports;
