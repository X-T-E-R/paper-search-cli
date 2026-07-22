import { Command } from "commander";
import { registerArtifactCommands } from "./commands/artifact.js";
import { registerAssessmentCommands } from "./commands/assessment.js";
import { registerBatchCommands } from "./commands/batch.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerConfigureCommand } from "./commands/configure.js";
import { registerContextCommands } from "./commands/context.js";
import { registerCitationCommands } from "./commands/citation.js";
import { registerDiscoveryCommands } from "./commands/discovery.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerExtractCommand } from "./commands/extract.js";
import { registerMaterialCommands } from "./commands/material.js";
import { registerMcpCommands } from "./commands/mcp.js";
import { registerMigrateCommand } from "./commands/migrate.js";
import { registerPdfCommands } from "./commands/pdf.js";
import { registerPathsCommand } from "./commands/paths.js";
import { registerProviderCommands } from "./commands/providers.js";
import { registerRegistriesCommands } from "./commands/registries.js";
import { registerRunCommand } from "./commands/run.js";
import { registerRunsCommand } from "./commands/runs.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSelfCommands } from "./commands/self.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerWebCommands } from "./commands/web.js";
import { registerWorkspaceCommands } from "./commands/workspace.js";
import { registerZoteroCommands } from "./commands/zotero.js";
import { createIo, type IoStreams } from "./runtime/io.js";
import { getSystemVersion } from "./runtime/version.js";

export function buildProgram(streams: IoStreams = {}): Command {
  const io = createIo(streams);
  const program = new Command();

  program
    .name("paper-search")
    .description(
      "Paper Search CLI X: extensible discovery, citation expansion, and transparent assessment.",
    )
    .version(getSystemVersion(), "--version", "show the Paper Search CLI X version")
    .option("--config <path>", "explicit TOML config path")
    .helpCommand(false)
    .showHelpAfterError();

  registerStatusCommand(program, io);
  registerPathsCommand(program, io);
  registerSetupCommand(program, io);
  registerSelfCommands(program, io);
  registerDoctorCommand(program, io);
  registerConfigCommands(program, io);
  registerConfigureCommand(program, io);
  registerContextCommands(program, io);
  registerMigrateCommand(program, io);
  registerRegistriesCommands(program, io);
  registerDiscoveryCommands(program, io);
  registerProviderCommands(program, io);
  registerSearchCommands(program, io);
  registerWebCommands(program, io);
  registerCitationCommands(program, io);
  registerAssessmentCommands(program, io);
  registerArtifactCommands(program, io);
  registerBatchCommands(program, io);
  registerWorkspaceCommands(program, io);
  registerPdfCommands(program, io);
  registerExtractCommand(program, io);
  registerMaterialCommands(program, io);
  registerZoteroCommands(program, io);
  registerRunCommand(program, io);
  registerRunsCommand(program, io);
  registerMcpCommands(program, io);

  return program;
}
