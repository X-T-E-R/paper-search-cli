import type { Command } from "commander";
import type { Io } from "../runtime/io.js";
import { failEnvelope, okEnvelope } from "../surface/resultEnvelope.js";
import {
  executeSubscriptionMutation,
  listSubscriptions,
  refreshSubscriptions,
  showSubscription,
} from "../subscriptions/service.js";
import type { RegistryRuntimeKind } from "../subscriptions/types.js";
import { acceptAlwaysJsonFlag } from "./alwaysJson.js";

interface ApplyOptions { apply?: boolean }
interface AddOptions extends ApplyOptions { kind: string }
interface OrphanOptions extends ApplyOptions { orphanDependents?: boolean }

function kind(value: string): RegistryRuntimeKind {
  if (value !== "search" && value !== "material") {
    throw new Error(`Registry kind must be search or material: ${value}`);
  }
  return value;
}

async function emit(io: Io, tool: string, action: () => Promise<unknown>, planned?: boolean) {
  try {
    const data = await action();
    const values = Array.isArray(data) ? data : [data];
    const warnings = values.flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const auditWarnings = (value as { auditWarnings?: unknown }).auditWarnings;
      return Array.isArray(auditWarnings)
        ? auditWarnings.filter((entry): entry is string => typeof entry === "string")
        : [];
    });
    io.writeJson(okEnvelope({
      capability: "operate",
      tool,
      data,
      ...(planned === undefined ? {} : { planned }),
      ...(warnings.length > 0 ? { warnings } : {}),
    }));
  } catch (error) {
    io.writeJson(failEnvelope({
      capability: "operate",
      tool,
      errors: [error instanceof Error ? error.message : String(error)],
    }));
  }
}

export function registerRegistriesCommands(program: Command, io: Io): void {
  const registries = program.command("registries").description("Manage trusted registry subscriptions.");

  acceptAlwaysJsonFlag(registries.command("list"))
    .action(() => emit(io, "registries_list", listSubscriptions));
  acceptAlwaysJsonFlag(registries.command("show <name>"))
    .action((name: string) =>
    emit(io, "registries_show", () => showSubscription(name)));

  acceptAlwaysJsonFlag(registries
    .command("add <name> <url>"))
    .requiredOption("--kind <kind>", "search or material")
    .option("--apply", "apply the displayed trust-change plan")
    .action((name: string, url: string, options: AddOptions) =>
      emit(
        io,
        "registries_add",
        () => executeSubscriptionMutation({ operation: "add", id: name, url, runtimeKind: kind(options.kind) }, Boolean(options.apply)),
        !options.apply,
      ));

  acceptAlwaysJsonFlag(registries
    .command("rebind <name> <url>"))
    .option("--orphan-dependents", "retain dependent providers as orphaned")
    .option("--apply", "apply the displayed trust-change plan")
    .action((name: string, url: string, options: OrphanOptions) =>
      emit(
        io,
        "registries_rebind",
        () => executeSubscriptionMutation({
          operation: "rebind",
          id: name,
          url,
          orphanDependents: options.orphanDependents,
        }, Boolean(options.apply)),
        !options.apply,
      ));

  for (const operation of ["enable", "disable"] as const) {
    acceptAlwaysJsonFlag(registries
      .command(`${operation} <name>`))
      .option("--apply", "apply the displayed trust-change plan")
      .action((name: string, options: ApplyOptions) =>
        emit(
          io,
          `registries_${operation}`,
          () => executeSubscriptionMutation({ operation, id: name }, Boolean(options.apply)),
          !options.apply,
        ));
  }

  acceptAlwaysJsonFlag(registries
    .command("remove <name>"))
    .option("--orphan-dependents", "retain dependent providers as orphaned")
    .option("--apply", "apply the displayed trust-change plan")
    .action((name: string, options: OrphanOptions) =>
      emit(
        io,
        "registries_remove",
        () => executeSubscriptionMutation({
          operation: "remove",
          id: name,
          orphanDependents: options.orphanDependents,
        }, Boolean(options.apply)),
        !options.apply,
      ));

  acceptAlwaysJsonFlag(registries
    .command("refresh [name]")
    .description("Explicitly fetch, validate, and snapshot registry metadata without installing providers."))
    .action((name?: string) => emit(io, "registries_refresh", () => refreshSubscriptions(name), false));
}
