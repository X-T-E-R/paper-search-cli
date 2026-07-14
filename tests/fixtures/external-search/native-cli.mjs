#!/usr/bin/env node
const behavior = process.argv[2] ?? "normal";

if (behavior === "exit") {
  process.stderr.write("fixture failed api_key=fixture-secret\n");
  process.exit(7);
}
if (behavior === "timeout") {
  setTimeout(() => {}, 60_000);
} else if (behavior === "overflow") {
  process.stdout.write("x".repeat(5 * 1024 * 1024));
} else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (behavior === "malformed") {
    process.stdout.write("not-json");
  } else {
    const requestId = behavior === "request-mismatch" ? "wrong-request" : request.requestId;
    const version = behavior === "version-mismatch" ? 2 : request.version;
    if (request.operation === "probe") {
      process.stdout.write(JSON.stringify({
        protocol: request.protocol,
        version,
        requestId,
        operation: "probe",
        ok: true,
        status: "ready",
        data: {
          tool: { name: "fixture-native", version: "1.0.0" },
          protocolVersions: [1],
          modes: ["fast", "deep", "answer"],
          intents: ["factual", "exploratory"],
          freshness: ["pd", "pw", "pm", "py"],
        },
        warnings: [],
      }));
    } else {
      process.stdout.write(JSON.stringify({
        protocol: request.protocol,
        version,
        requestId,
        operation: "search",
        ok: true,
        status: "succeeded",
        data: {
          query: request.query,
          answer: "fixture answer",
          results: [{
            title: "Fixture result",
            url: "https://example.test/result",
            snippet: "offline fixture",
            publishedAt: "2026-07-14",
            score: 0.9,
            providers: ["fixture"],
          }],
          citations: [{ url: "https://example.test/result", title: "Fixture result", providers: ["fixture"] }],
        },
        provenance: {
          tool: { name: "fixture-native", version: "1.0.0" },
          providerAttempts: [{ provider: "fixture", status: "succeeded", resultCount: 1, durationMs: 1 }],
          artifacts: [],
          semanticVerification: false,
        },
        warnings: [],
      }));
    }
  }
}
