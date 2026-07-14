import type { ResolvedConfig } from "../config/schema.js";
import { listInstalledProviders } from "../providers/registry/sync.js";
import { getTools } from "../surface/tools.js";
import { createPlatformStatusSnapshot } from "../surface/status.js";
import { handleMcpToolCall } from "./toolHandlers.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpHttpResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

interface PaperSearchMcpServerOptions {
  name?: string;
  version?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PaperSearchMcpServer {
  private isInitialized = false;
  private readonly serverInfo: { name: string; version: string };
  private endpointBaseUrl?: string;

  constructor(
    private readonly config: ResolvedConfig,
    options: PaperSearchMcpServerOptions = {},
  ) {
    this.serverInfo = {
      name: options.name ?? "paper-search-cli-mcp",
      version: options.version ?? "0.1.0",
    };
  }

  async handleMcpRequest(requestBody: string): Promise<McpHttpResult> {
    let parsedRequest: unknown;
    try {
      parsedRequest = JSON.parse(requestBody);
    } catch {
      return this.toHttpResult(this.createError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(parsedRequest)) {
      return this.toHttpResult(
        this.createError(null, -32600, "Batch requests are not supported"),
        400,
      );
    }

    if (!isRecord(parsedRequest)) {
      return this.toHttpResult(this.createError(null, -32600, "Invalid Request"), 400);
    }

    const request = parsedRequest as unknown as JsonRpcRequest;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || !request.method.trim()) {
      return this.toHttpResult(
        this.createError(
          typeof request.id === "string" || typeof request.id === "number" ? request.id : null,
          -32600,
          "Invalid Request: jsonrpc=2.0 and method are required",
        ),
        400,
      );
    }

    const response = await this.processRequest(request);
    if (response === null) {
      return {
        status: 202,
        statusText: "Accepted",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: "",
      };
    }

    const status = response.error && (response.error.code === -32600 || response.error.code === -32700)
      ? 400
      : 200;
    return this.toHttpResult(response, status);
  }

  async getStatus(): Promise<unknown> {
    const endpointBaseUrl = this.endpointBaseUrl ?? `http://${this.config.server.host}:${this.config.server.port}`;
    return {
      endpoint: `${endpointBaseUrl}/mcp`,
      helpEndpoint: `${endpointBaseUrl}/mcp/help`,
      statusEndpoint: `${endpointBaseUrl}/mcp/status`,
      protocolVersion: "2024-11-05",
      initialized: this.isInitialized,
      serverInfo: this.serverInfo,
      platform: await createPlatformStatusSnapshot(this.config),
    };
  }

  setEndpointBaseUrl(endpointBaseUrl: string): void {
    this.endpointBaseUrl = endpointBaseUrl.replace(/\/+$/u, "");
  }

  private async processRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = Object.prototype.hasOwnProperty.call(request, "id") ? request.id ?? null : null;
    const isNotification =
      !Object.prototype.hasOwnProperty.call(request, "id") ||
      request.id === null ||
      request.id === undefined;

    if (isNotification) {
      if (request.method === "initialized" || request.method === "notifications/initialized") {
        this.isInitialized = true;
        return null;
      }
      if (request.method.startsWith("notifications/")) {
        return null;
      }
      return this.createError(null, -32600, `Invalid Request: id is required for method ${request.method}`);
    }

    try {
      switch (request.method) {
        case "initialize":
          return this.handleInitialize(id);

        case "initialized":
        case "notifications/initialized":
          this.isInitialized = true;
          return this.createResponse(id, { success: true });

        case "tools/list":
          return await this.handleToolsList(id);

        case "tools/call":
          return await this.handleToolsCall(id, request.params);

        case "resources/list":
          return this.createResponse(id, { resources: [] });

        case "prompts/list":
          return this.createResponse(id, { prompts: [] });

        case "ping":
          return this.createResponse(id, {});

        default:
          return this.createError(id, -32601, `Method not found: ${request.method}`);
      }
    } catch (error) {
      return this.createError(
        id,
        -32603,
        `Internal error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleInitialize(id: string | number | null): JsonRpcResponse {
    return this.createResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: { listChanged: false },
        logging: {},
        prompts: {},
        resources: {},
      },
      serverInfo: this.serverInfo,
    });
  }

  private async handleToolsList(id: string | number | null): Promise<JsonRpcResponse> {
    const installed = await listInstalledProviders(this.config.providers.installDir);
    return this.createResponse(id, { tools: getTools(installed) });
  }

  private async handleToolsCall(
    id: string | number | null,
    params: unknown,
  ): Promise<JsonRpcResponse> {
    if (!isRecord(params)) {
      return this.createError(id, -32602, "Invalid params: expected object with name and arguments");
    }
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) {
      return this.createError(id, -32602, "Invalid params: name is required");
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const result = await handleMcpToolCall(this.config, name, args);
    return this.createResponse(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      ...(isRecord(result) && result.ok === false ? { isError: true } : {}),
    });
  }

  private createResponse(id: string | number | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private createError(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
  ): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message, data } };
  }

  private toHttpResult(response: JsonRpcResponse, status: number): McpHttpResult {
    return {
      status,
      statusText: status === 400 ? "Bad Request" : "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(response),
    };
  }
}
