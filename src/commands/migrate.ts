import type { Command } from "commander";
import { executeCombinedMigration } from "../config/migrateService.js";
import type { Io } from "../runtime/io.js";
import { failEnvelope, okEnvelope } from "../surface/resultEnvelope.js";

interface MigrateOptions {
  apply?: boolean;
  legacyInstallDir?: string;
  legacyConfigRoot?: string;
}

/** Command composition exported for the root program/catalog registration slice. */
export function registerMigrateCommand(program: Command, io: Io): void {
  program
    .command("migrate")
    .description("Plan or apply journaled config and provider-directory migration.")
    .option("--legacy-config-root <path>", "explicitly select one legacy config root when candidates differ")
    .option("--legacy-install-dir <path>", "explicitly select a custom legacy provider directory")
    .option("--apply", "apply the displayed migration plan")
    .action(async (options: MigrateOptions) => {
      try {
        const result = await executeCombinedMigration({
          apply: options.apply,
          legacyInstallDir: options.legacyInstallDir,
          legacyConfigRoot: options.legacyConfigRoot,
          explicitConfigPath: program.opts<{ config?: string }>().config,
        });
        const provenance = {
          configPaths: result.plan.config.targets.map((target) => target.path),
        };
        if (result.errors.length > 0) {
          io.writeJson(failEnvelope({
            capability: "operate",
            tool: "migrate",
            errors: result.errors,
            warnings: result.auditWarnings,
            diagnostics: { migration: result },
            provenance,
          }));
          return;
        }
        io.writeJson(okEnvelope({
          capability: "operate",
          tool: "migrate",
          planned: !options.apply,
          data: result,
          warnings: result.auditWarnings,
          provenance,
        }));
      } catch (error) {
        io.writeJson(failEnvelope({
          capability: "operate",
          tool: "migrate",
          errors: [error instanceof Error ? error.message : String(error)],
        }));
      }
    });
}
