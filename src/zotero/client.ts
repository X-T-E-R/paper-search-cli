import { randomUUID } from "node:crypto";

export interface ZoteroToolClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
export class ZoteroUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoteroUnavailableError";
  }
}

export class ZoteroRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoteroRemoteError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapToolPayload(value: unknown): unknown {
  if (!isObject(value)) throw new ZoteroRemoteError("Zotero MCP returned an invalid JSON-RPC response");
  if (isObject(value.error)) {
    throw new ZoteroRemoteError(String(value.error.message ?? "Zotero MCP tool call failed"));
  }
  const result = value.result;
  if (!isObject(result) || !Array.isArray(result.content)) {
    throw new ZoteroRemoteError("Zotero MCP response did not contain tool content");
  }
  const text = result.content.find(
    (entry): entry is { type: string; text: string } =>
      isObject(entry) && entry.type === "text" && typeof entry.text === "string",
  )?.text;
  if (!text) throw new ZoteroRemoteError("Zotero MCP response did not contain JSON text content");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ZoteroRemoteError("Zotero MCP tool content was not valid JSON");
  }
  if (isObject(payload) && payload.ok === false) {
    throw new ZoteroRemoteError(String(payload.error ?? payload.message ?? payload.code ?? "Zotero tool rejected the request"));
  }
  return payload;
}

export function createZoteroHttpClient(options: {
  endpoint: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): ZoteroToolClient {
  const endpoint = new URL(options.endpoint).toString();
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async callTool(name, args) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: randomUUID(),
              method: "tools/call",
              params: { name, arguments: args },
            }),
            signal: controller.signal,
          });
        } catch (error) {
          throw new ZoteroUnavailableError(
            `Zotero endpoint unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!response.ok) {
          throw new ZoteroUnavailableError(`Zotero endpoint unavailable: HTTP ${response.status} ${response.statusText}`);
        }
        let rpc: unknown;
        try {
          rpc = await response.json();
        } catch {
          throw new ZoteroRemoteError("Zotero endpoint returned invalid JSON");
        }
        return unwrapToolPayload(rpc);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
