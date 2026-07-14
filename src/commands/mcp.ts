import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import { startMcpHttpServer } from "../mcp/httpServer.js";
import { runMcpStdioServer } from "../mcp/stdioServer.js";
import type { Io } from "../runtime/io.js";

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

export function registerMcpCommands(program: Command, io: Io): void {
  const mcp = program
    .command("mcp")
    .description("Run or inspect the paper-search-cli MCP surface.");

  mcp
    .command("serve")
    .description("Serve source-compatible paper-search MCP JSON-RPC tools over HTTP or stdio.")
    .option("--transport <transport>", "transport: http or stdio")
    .option("--host <host>", "HTTP host override")
    .option("--port <port>", "HTTP port override", parsePort)
    .option("--json", "emit machine-readable startup metadata")
    .action(async (options: Record<string, unknown>, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const transport =
        options.transport === "stdio" || options.transport === "http"
          ? options.transport
          : config.server.transport;

      if (transport === "stdio") {
        if (options.json) {
          io.writeJson({
            transport: "stdio",
            protocolVersion: "2024-11-05",
            toolsEndpoint: "stdio",
          });
        }
        await runMcpStdioServer(config);
        return;
      }

      const server = await startMcpHttpServer(config, {
        host: typeof options.host === "string" ? options.host : undefined,
        port: typeof options.port === "number" ? options.port : undefined,
      });
      const payload = {
        transport: "http",
        protocolVersion: "2024-11-05",
        endpoint: server.endpoint,
        helpEndpoint: server.helpEndpoint,
        statusEndpoint: server.statusEndpoint,
      };
      if (options.json) {
        io.writeJson(payload);
      } else {
        io.writeLine(`paper-search MCP server listening at ${server.endpoint}`);
        io.writeLine(`help: ${server.helpEndpoint}`);
        io.writeLine(`status: ${server.statusEndpoint}`);
      }

      await new Promise<void>((resolve) => {
        const stop = async () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          await server.close();
          resolve();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      });
    });
}
