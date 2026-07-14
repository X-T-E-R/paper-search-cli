export const manifest = { moduleAbiVersion: 1, id: "fixture", version: "1.0.0" };

export async function handle(request, context) {
  if (request.operation === "probe") {
    const version = await context.execFile({ args: ["--version"] });
    return {
      status: "ready",
      data: {
        tool: { name: "fixture-cli", version: version.stdout.trim() },
        protocolVersions: [1],
        modes: ["fast"],
        intents: [],
        freshness: [],
      },
      warnings: [],
    };
  }
  if (request.query === "__stderr__") {
    const execution = await context.execFile({ args: ["secret-stderr"] });
    return {
      status: "failed",
      error: { code: "fixture_failure", message: execution.stderr, retryable: false },
      warnings: [],
    };
  }
  const execution = await context.execFile({
    args: request.query === "__hang__" ? ["hang"] : ["search", request.query],
  });
  const raw = JSON.parse(execution.stdout);
  return {
    status: "succeeded",
    data: {
      query: request.query,
      answer: null,
      results: [{ title: raw.title, url: "https://example.test/adapted", providers: ["fixture-cli"] }],
      citations: [{ title: raw.title, url: "https://example.test/adapted", providers: ["fixture-cli"] }],
    },
    provenance: {
      tool: { name: "fixture-cli", version: "2.0.0" },
      providerAttempts: [{ provider: "fixture-cli", status: "succeeded", resultCount: 1, durationMs: execution.durationMs }],
      artifacts: [],
      semanticVerification: false,
    },
    warnings: [],
  };
}
