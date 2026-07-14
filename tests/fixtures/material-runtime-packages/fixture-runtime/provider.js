var __material_provider_exports = {
  createProvider(context) {
    async function captureDenied(label, action) {
      try {
        await action();
        return { label, denied: false, message: "" };
      } catch (error) {
        return {
          label,
          denied: true,
          message: error && error.message ? String(error.message) : String(error)
        };
      }
    }

    return {
      async exercise() {
        const getResponse = await context.http.get("https://allowed.example/resource", {
          params: { q: "runtime" }
        });
        const postResponse = await context.http.post("https://allowed.example/submit", {
          id: "fixture-runtime"
        });

        const cacheWrite = await context.cache.writeJson("state/result.json", {
          ok: true,
          status: getResponse.status
        });
        const cacheValue = await context.cache.readJson("state/result.json");

        const workspaceWrite = await context.workspace.writeText(
          "material/fixture-runtime/result.md",
          "# Fixture Runtime\n"
        );

        return {
          getData: getResponse.data,
          postData: postResponse.data,
          secret: context.config.get("apiKey"),
          redactedApiKey: context.config.getRedacted("apiKey"),
          redactedConfig: context.config.getRedacted(),
          cacheWrite,
          cacheValue,
          policy: context.policy.get(),
          policyMode: context.policy.get("mode"),
          workspaceWrite
        };
      },
      async probeDenied() {
        return [
          await captureDenied("network", () => context.http.get("https://blocked.example/resource")),
          await captureDenied("cacheEscape", () => context.cache.writeText("../escape.txt", "bad")),
          await captureDenied("workspaceEscape", () => context.workspace.writeText("../escape.txt", "bad"))
        ];
      }
    };
  }
};
globalThis.__material_provider_exports = __material_provider_exports;
