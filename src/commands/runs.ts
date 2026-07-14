import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { Io } from "../runtime/io.js";
import { failEnvelope, okEnvelope } from "../surface/resultEnvelope.js";
import {
  RUN_KINDS,
  RUN_STATUSES,
  type ResearchRunKind,
  type ResearchRunStatus,
  type ResearchRunStore,
} from "../runs/index.js";
import {
  openRunStoreFromResolvedConfig,
  type ConfiguredRunStoreResolver,
} from "../runs/config.js";

export interface RegisterRunsCommandOptions {
  resolveStore?: ConfiguredRunStoreResolver;
}

function parseKind(value: string | undefined): ResearchRunKind | undefined {
  if (value === undefined) return undefined;
  if (!(RUN_KINDS as readonly string[]).includes(value)) {
    throw new Error(`kind must be one of: ${RUN_KINDS.join(", ")}`);
  }
  return value as ResearchRunKind;
}

function parseStatus(value: string | undefined): ResearchRunStatus | "corrupt" | undefined {
  if (value === undefined) return undefined;
  if (value !== "corrupt" && !(RUN_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`status must be one of: ${[...RUN_STATUSES, "corrupt"].join(", ")}`);
  }
  return value as ResearchRunStatus | "corrupt";
}

function parseMaxAgeDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/u.test(value)) throw new Error("max-age-days must be -1 or a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed === 0 || parsed < -1) {
    throw new Error("max-age-days must be -1 or a positive integer");
  }
  return parsed;
}

function errorEnvelope(tool: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const reason = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "run_management_failed";
  return failEnvelope({
    capability: "operate",
    tool,
    errors: [message],
    diagnostics: { reason },
  });
}

export function registerRunsCommand(
  program: Command,
  io: Io,
  options: RegisterRunsCommandOptions = {},
): void {
  const resolveStore = options.resolveStore ?? openRunStoreFromResolvedConfig;
  const runs = program
    .command("runs")
    .description("Inspect, export, pin, and explicitly prune private local durable runs.");

  async function configuredStore(command: Command): Promise<ResearchRunStore> {
    const globalOptions = command.optsWithGlobals<{ config?: string }>();
    const config = await loadConfig({ explicitConfigPath: globalOptions.config });
    return resolveStore(config);
  }

  runs
    .command("list")
    .description("List validated durable-run headers without following symlinks.")
    .option("--kind <kind>", `filter by kind: ${RUN_KINDS.join(", ")}`)
    .option("--status <status>", `filter by status: ${[...RUN_STATUSES, "corrupt"].join(", ")}`)
    .action(async (options: { kind?: string; status?: string }, command: Command) => {
      try {
        const store = await configuredStore(command);
        const entries = await store.list({
          kind: parseKind(options.kind),
          status: parseStatus(options.status),
        });
        io.writeJson(okEnvelope({
          capability: "operate",
          tool: "run_list",
          data: { runs: entries, count: entries.length },
        }));
      } catch (error) {
        io.writeJson(errorEnvelope("run_list", error));
      }
    });

  runs
    .command("show <run-id>")
    .description("Show one validated durable run record.")
    .action(async (runId: string, _options: unknown, command: Command) => {
      try {
        const store = await configuredStore(command);
        io.writeJson(okEnvelope({
          capability: "operate",
          tool: "run_show",
          data: { run: await store.read(runId) },
        }));
      } catch (error) {
        io.writeJson(errorEnvelope("run_show", error));
      }
    });

  runs
    .command("export <run-id>")
    .description("Export one sanitized run record to an explicit path without overwriting.")
    .requiredOption("--out <path>", "explicit export path; relative paths use the caller's working directory")
    .action(async (runId: string, options: { out: string }, command: Command) => {
      try {
        const store = await configuredStore(command);
        io.writeJson(okEnvelope({
          capability: "operate",
          tool: "run_export",
          data: await store.export(runId, options.out),
        }));
      } catch (error) {
        io.writeJson(errorEnvelope("run_export", error));
      }
    });

  for (const pinned of [true, false] as const) {
    const commandName = pinned ? "pin" : "unpin";
    runs
      .command(`${commandName} <run-id>`)
      .description(`${pinned ? "Pin" : "Unpin"} one run for age-based retention.`)
      .action(async (runId: string, _options: unknown, command: Command) => {
        const tool = pinned ? "run_pin" : "run_unpin";
        try {
          const store = await configuredStore(command);
          const record = await store.setPinned(runId, pinned);
          io.writeJson(okEnvelope({
            capability: "operate",
            tool,
            data: { runId: record.runId, pinned: record.pinned, updatedAt: record.updatedAt },
          }));
        } catch (error) {
          io.writeJson(errorEnvelope(tool, error));
        }
      });
  }

  runs
    .command("prune")
    .description("Plan age pruning; pass --apply to quarantine and delete eligible run records only.")
    .option("--max-age-days <days>", "override configured retention with -1 or a positive integer")
    .option("--apply", "apply the exact eligibility rules after re-reading each candidate under lock")
    .action(async (options: { maxAgeDays?: string; apply?: boolean }, command: Command) => {
      try {
        const store = await configuredStore(command);
        const result = await store.prune({
          apply: options.apply === true,
          maxAgeDays: parseMaxAgeDays(options.maxAgeDays),
        });
        const tool = options.apply === true ? "run_prune" : "run_prune_plan";
        io.writeJson(okEnvelope({
          capability: "operate",
          tool,
          planned: result.planned,
          data: result,
        }));
      } catch (error) {
        io.writeJson(errorEnvelope(options.apply === true ? "run_prune" : "run_prune_plan", error));
      }
    });
}
