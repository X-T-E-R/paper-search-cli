import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ResolvedConfig } from "../config/schema.js";
import { PaperSearchMcpServer } from "./jsonRpc.js";

export interface RunMcpStdioServerOptions {
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
}

export async function runMcpStdioServer(
  config: ResolvedConfig,
  options: RunMcpStdioServerOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const mcp = new PaperSearchMcpServer(config);
  const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const result = await mcp.handleMcpRequest(line);
      if (result.status !== 202 && result.body) {
        output.write(`${result.body}\n`);
      }
    } catch (error) {
      errorOutput.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
