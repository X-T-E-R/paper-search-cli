import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import { expandHome } from "../config/paths.js";
import { ProjectContextConfigSchema, type UserConfig } from "../config/schema.js";
import {
  atomicCreateConfigFile,
  serializeUserConfigFile,
  withConfigFileLocks,
} from "../config/userConfig.js";
import type { Io } from "../runtime/io.js";
import { failEnvelope, okEnvelope } from "../surface/resultEnvelope.js";

type ContextKind = "standalone" | "paperflow";

interface ContextInitOptions {
  id?: string;
  kind?: string;
  runsRoot?: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function defaultContextId(directory: string): string {
  const normalized = path.basename(directory)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 128);
  return normalized || "paper-search-context";
}

function parseContextKind(value: string | undefined): ContextKind {
  const kind = value ?? "standalone";
  if (kind !== "standalone" && kind !== "paperflow") {
    throw new Error("context kind must be one of: standalone, paperflow");
  }
  return kind;
}

function failure(tool: string, error: unknown) {
  return failEnvelope({
    capability: "operate",
    tool,
    errors: [error instanceof Error ? error.message : String(error)],
  });
}

export function registerContextCommands(program: Command, io: Io): void {
  const context = program
    .command("context")
    .description("Inspect or initialize the nearest Paper Search persistence context.");

  context
    .command("status")
    .description("Show the effective context and durable-run destination.")
    .action(async (_options: unknown, command: Command) => {
      try {
        const config = await loadConfig({
          explicitConfigPath: command.optsWithGlobals<{ config?: string }>().config,
        });
        const contextOrigin = config.meta.origins?.["context.id"];
        io.writeJson(okEnvelope({
          capability: "operate",
          tool: "context_status",
          data: {
            context: config.context,
            runsRoot: config.runs.root,
            configPath: contextOrigin?.kind === "default" ? null : contextOrigin?.source ?? null,
          },
        }));
      } catch (error) {
        io.writeJson(failure("context_status", error));
      }
    });

  context
    .command("init [directory]")
    .description("Create a non-overwriting project context config for direct nested-directory use.")
    .option("--id <id>", "stable context id; defaults to the directory name")
    .option("--kind <kind>", "context kind: standalone or paperflow", "standalone")
    .option("--runs-root <path>", "run directory relative to the context config or an absolute path")
    .action(async (directory: string | undefined, options: ContextInitOptions) => {
      try {
        const root = path.resolve(directory ?? process.cwd());
        const kind = parseContextKind(options.kind);
        const identity = ProjectContextConfigSchema.parse({
          id: options.id ?? defaultContextId(root),
          kind,
        });
        if (options.runsRoot !== undefined && options.runsRoot.trim() === "") {
          throw new Error("runs-root must not be blank");
        }
        const configuredRoot = options.runsRoot?.trim() ??
          (kind === "paperflow" ? "sources/search/runs" : ".paper-search/runs");
        const expandedRoot = expandHome(configuredRoot);
        const runsRoot = path.isAbsolute(expandedRoot)
          ? path.resolve(expandedRoot)
          : path.resolve(root, expandedRoot);
        const target = path.join(root, "paper-search.toml");
        const alternate = path.join(root, ".paper-search.toml");
        const document: UserConfig = {
          context: identity,
          runs: { root: configuredRoot, recordByDefault: true },
        };

        await mkdir(root, { recursive: true });
        await withConfigFileLocks([target, alternate], async () => {
          const existing = (await Promise.all(
            [target, alternate].map(async (candidate) =>
              await exists(candidate) ? candidate : null
            ),
          )).find((candidate): candidate is string => candidate !== null);
          if (existing) throw new Error(`Context config already exists: ${existing}`);
          await atomicCreateConfigFile(target, serializeUserConfigFile(document));
        }, { command: "context init" });

        io.writeJson(okEnvelope({
          capability: "operate",
          tool: "context_init",
          data: { context: identity, configPath: target, runsRoot },
        }));
      } catch (error) {
        io.writeJson(failure("context_init", error));
      }
    });
}
