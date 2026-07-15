import type { ResolvedConfig } from "../config/schema.js";
import {
  runCanonicalTool,
  type ToolArguments,
} from "../surface/toolRunner.js";

export async function handleMcpToolCall(
  config: ResolvedConfig,
  name: string,
  args: ToolArguments = {},
): Promise<unknown> {
  return runCanonicalTool(config, name, args, {
    allowLegacyAliases: true,
  });
}
