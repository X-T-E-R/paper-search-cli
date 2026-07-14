import type { Command } from "commander";
import type { Io } from "../runtime/io.js";
import { registerMaterialIngestCommand } from "./materialIngest.js";
import { registerMaterialStatusCommand } from "./materialStatus.js";

export function registerMaterialCommands(program: Command, io: Io): void {
  const material = program
    .command("material")
    .description("Plan and inspect material artifact/extraction workflows.");

  registerMaterialIngestCommand(material, io);
  registerMaterialStatusCommand(material, io);
}
