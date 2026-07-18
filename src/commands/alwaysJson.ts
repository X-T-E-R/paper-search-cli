import type { Command } from "commander";

/**
 * Accept the conventional JSON request flag on commands whose only stdout
 * representation is already a ResultEnvelope JSON document.
 */
export function acceptAlwaysJsonFlag(command: Command): Command {
  return command.option("--json", "compatibility flag; output is always a JSON envelope");
}
