import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ResolvedConfig } from "../config/schema.js";
import { createHelpSnapshot } from "../surface/help.js";
import { PaperSearchMcpServer } from "./jsonRpc.js";

export interface RunningMcpHttpServer {
  server: Server;
  endpoint: string;
  helpEndpoint: string;
  statusEndpoint: string;
  close(): Promise<void>;
}

export interface StartMcpHttpServerOptions {
  host?: string;
  port?: number;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

function getQuery(request: IncomingMessage): URLSearchParams {
  const host = request.headers.host ?? "127.0.0.1";
  return new URL(request.url ?? "/", `http://${host}`).searchParams;
}

export async function startMcpHttpServer(
  config: ResolvedConfig,
  options: StartMcpHttpServerOptions = {},
): Promise<RunningMcpHttpServer> {
  const mcp = new PaperSearchMcpServer(config);
  const host = options.host ?? config.server.host;
  const requestedPort = options.port ?? config.server.port;

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`).pathname;
      if (request.method === "GET" && path === "/ping") {
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end("pong");
        return;
      }

      if (path === "/mcp") {
        if (request.method === "GET") {
          writeJson(response, 200, {
            endpoint: "/mcp",
            helpEndpoint: "/mcp/help",
            statusEndpoint: "/mcp/status",
            protocol: "MCP (Model Context Protocol)",
            transport: "Streamable HTTP",
            version: "2024-11-05",
            description: "POST MCP JSON-RPC 2.0 requests to this endpoint",
            status: "available",
          });
          return;
        }
        if (request.method === "POST") {
          const result = await mcp.handleMcpRequest(await readRequestBody(request));
          response.statusCode = result.status;
          for (const [name, value] of Object.entries(result.headers)) {
            response.setHeader(name, value);
          }
          response.end(result.body);
          return;
        }
      }

      if (request.method === "GET" && path === "/mcp/status") {
        writeJson(response, 200, await mcp.getStatus());
        return;
      }

      if (request.method === "GET" && path === "/mcp/help") {
        const query = getQuery(request);
        writeJson(response, 200, await createHelpSnapshot(config, {
          topic: query.get("topic") ?? undefined,
          tool: query.get("tool") ?? undefined,
          provider: query.get("provider") ?? undefined,
          locale: query.get("locale") ?? undefined,
        }));
        return;
      }

      writeJson(response, 404, { error: `Not found: ${path}` });
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const endpoint = `http://${host}:${port}/mcp`;
  mcp.setEndpointBaseUrl(`http://${host}:${port}`);
  return {
    server,
    endpoint,
    helpEndpoint: `http://${host}:${port}/mcp/help`,
    statusEndpoint: `http://${host}:${port}/mcp/status`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
