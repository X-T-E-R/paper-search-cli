import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import { listInstalledMaterialProviders } from "../material/registry/plan.js";
import { listInstalledProviders } from "../providers/registry/sync.js";
import { resolveSmokePolicy } from "../testing/smokePolicy.js";
import type { Io } from "../runtime/io.js";
import { formatInstallHealthWarnings, inspectInstallHealth } from "../runtime/installLayout.js";
import {
  buildZeroProviderWarnings,
  sanitizeRegistrySource,
  summarizeOnboardingInstallCounts,
} from "../surface/providerInstallHints.js";
import { okEnvelope } from "../surface/resultEnvelope.js";
import { inspectProviderLifecycleHealth } from "./doctor.js";
import { inspectExternalSearchStatic } from "../external-search/config.js";

interface StatusOptions {
  json?: boolean;
}

export function registerStatusCommand(program: Command, io: Io): void {
  program
    .command("status")
    .description("Show resolved config paths, provider defaults, and smoke gating state.")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: StatusOptions, command: Command) => {
      const globalOptions = command.optsWithGlobals<{ config?: string }>();
      const config = await loadConfig({ explicitConfigPath: globalOptions.config });
      const smoke = resolveSmokePolicy(config.smoke, process.env);
      const [searchProviders, materialProviders, installation, providerLifecycle, externalSearch] = await Promise.all([
        listInstalledProviders(config.providers.installDir),
        listInstalledMaterialProviders(config.providers.installDir),
        inspectInstallHealth(),
        inspectProviderLifecycleHealth(config.providers.installDir),
        inspectExternalSearchStatic(),
      ]);
      const compatibilityCounts = summarizeOnboardingInstallCounts(searchProviders, materialProviders);
      const installCounts = {
        search: providerLifecycle.inventory.byKind.search.total > 0
          ? {
              total: providerLifecycle.inventory.byKind.search.total,
              valid: providerLifecycle.inventory.byKind.search.healthy,
            }
          : compatibilityCounts.search,
        material: providerLifecycle.inventory.byKind.material.total > 0
          ? {
              total: providerLifecycle.inventory.byKind.material.total,
              valid: providerLifecycle.inventory.byKind.material.healthy,
            }
          : compatibilityCounts.material,
      };
      const registrySource = sanitizeRegistrySource(config.providers.registryUrl);
      const warnings = [
        ...buildZeroProviderWarnings(registrySource, installCounts),
        ...formatInstallHealthWarnings(installation),
      ];
      const payload = {
        cwd: config.meta.cwd,
        loadedFiles: config.meta.loadedFiles,
        appliedEnvOverrides: config.meta.appliedEnvOverrides,
        providers: { ...config.providers, registryUrl: registrySource },
        workspace: config.workspace,
        server: {
          ...config.server,
          endpoint:
            config.server.transport === "http"
              ? `http://${config.server.host}:${config.server.port}/mcp`
              : "stdio",
        },
        defaults: config.defaults,
        output: config.output,
        smoke,
        externalSearch,
        providerLifecycle,
        installation: {
          checkout: installation.paths.repoRoot,
          packageVersion: installation.build?.packageVersion ?? null,
          buildInputDigest: installation.build?.buildInputDigest?.value ?? null,
          sourceManagementMode: installation.install?.sourceManagementMode ?? "unmanaged",
          projectionHealth: {
            healthy: installation.projections.filter((entry) => entry.healthy).length,
            total: installation.projections.length,
          },
          shimHealth: {
            healthy: installation.shims.filter((entry) => entry.healthy).length,
            total: installation.shims.length,
          },
          binRoot: installation.path.binRoot,
          binOnPath: installation.path.onPath,
          health: installation.summary,
          checks: installation.checks,
        },
      };
      const envelope = okEnvelope({
        capability: "operate",
        tool: "status",
        data: payload,
        diagnostics: {
          workspaceRoot: payload.workspace.root,
          providerInstallDir: payload.providers.installDir,
          configPaths: payload.loadedFiles,
          installedProviderCounts: installCounts,
          installStatePath: installation.paths.installStatePath,
          installationHealth: installation.summary.status,
          providerLifecycleHealth: providerLifecycle.health.status,
          authoritativeProviderCounts: {
            search: providerLifecycle.inventory.byKind.search.total,
            material: providerLifecycle.inventory.byKind.material.total,
          },
        },
        ...(warnings.length > 0 ? { warnings } : {}),
        provenance: { configPaths: payload.loadedFiles },
      });

      if (options.json) {
        io.writeJson(envelope);
        return;
      }

      io.writeLine(`cwd: ${payload.cwd}`);
      io.writeLine(`loaded config files: ${payload.loadedFiles.length ? payload.loadedFiles.join(", ") : "(none)"}`);
      io.writeLine(
        `applied env overrides: ${payload.appliedEnvOverrides.length ? payload.appliedEnvOverrides.join(", ") : "(none)"}`,
      );
      io.writeLine(`provider registry: ${payload.providers.registryUrl}`);
      io.writeLine(`provider install dir: ${payload.providers.installDir}`);
      io.writeLine(`authoritative provider root: ${payload.providerLifecycle.paths.authoritativeRoot}`);
      io.writeLine(
        `authoritative providers: search ${payload.providerLifecycle.inventory.byKind.search.healthy}/${payload.providerLifecycle.inventory.byKind.search.total} healthy; material ${payload.providerLifecycle.inventory.byKind.material.healthy}/${payload.providerLifecycle.inventory.byKind.material.total} healthy`,
      );
      io.writeLine(`provider lifecycle health: ${payload.providerLifecycle.health.status}`);
      io.writeLine(`workspace root: ${payload.workspace.root}`);
      io.writeLine(`external search: ${payload.externalSearch.state}`);
      io.writeLine(`checkout: ${payload.installation.checkout}`);
      io.writeLine(`source management: ${payload.installation.sourceManagementMode}`);
      io.writeLine(`installation health: ${payload.installation.health.status}`);
      io.writeLine(`CLI bin on PATH: ${payload.installation.binOnPath ? "yes" : "no"}`);
      for (const issue of payload.installation.health.issues) {
        io.writeLine(
          `installation ${issue.check}: ${issue.status} - ${issue.message}${issue.action ? ` ${issue.action}` : ""}`,
        );
      }
      io.writeLine(`default sink: ${payload.workspace.defaultSink}`);
      io.writeLine(`server endpoint: ${payload.server.endpoint}`);
      io.writeLine(
        `smoke enabled now: ${payload.smoke.enabled ? "yes" : "no"} (env: ${payload.smoke.envVar})`,
      );
    });
}
