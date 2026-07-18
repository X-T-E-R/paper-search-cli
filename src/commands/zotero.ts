import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/schema.js";
import type { Io } from "../runtime/io.js";
import { failEnvelope, okEnvelope } from "../surface/resultEnvelope.js";
import { createZoteroHttpClient } from "../zotero/client.js";
import {
  applyZoteroSink,
  isZoteroUnavailable,
  planZoteroSink,
  previewZoteroSink,
} from "../zotero/sink.js";
import type { ZoteroResolvedSettings } from "../zotero/types.js";
import { resolveZoteroSelectionBinding } from "../zotero/binding.js";
import { syncSelectedItemToZotero } from "../zotero/autoSync.js";
import { acceptAlwaysJsonFlag } from "./alwaysJson.js";

interface ZoteroSinkCommandOptions {
  extraction?: string;
  collectionKey?: string[];
  zoteroItemKey?: string;
  attachmentMode?: "none" | "link" | "import";
  markdownMode?: "none" | "note" | "link" | "import";
  endpoint?: string;
  timeoutMs?: string;
  preview?: boolean;
  apply?: boolean;
  ack?: string;
}

function appendOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function settingsFromCommand(config: ResolvedConfig, options: ZoteroSinkCommandOptions): ZoteroResolvedSettings {
  const explicitEndpoint = options.endpoint?.trim();
  const enabledOrigin = config.meta.origins?.["zotero.enabled"]?.kind;
  const endpointOrigin = config.meta.origins?.["zotero.endpoint"]?.kind;
  if (!explicitEndpoint && config.zotero.enabled && enabledOrigin !== "user") {
    throw new Error("forbidden_config_authority: only conventional user configuration may enable the Zotero writer");
  }
  if (!explicitEndpoint && endpointOrigin !== undefined && endpointOrigin !== "default" && endpointOrigin !== "user") {
    throw new Error("forbidden_config_authority: only conventional user configuration or --endpoint may select the Zotero endpoint");
  }
  const timeoutMs = options.timeoutMs === undefined ? config.zotero.timeoutMs : Number(options.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new Error("--timeout-ms must be an integer from 100 through 300000");
  }
  return {
    enabled: config.zotero.enabled || Boolean(explicitEndpoint),
    endpoint: explicitEndpoint || config.zotero.endpoint,
    timeoutMs,
    unavailable: config.zotero.unavailable,
  };
}

export function registerZoteroCommands(program: Command, io: Io): void {
  const zotero = program
    .command("zotero")
    .description("Inspect, sync, or explicitly project selected records through Zotero MCP Neo.");

  acceptAlwaysJsonFlag(zotero
    .command("status")
    .description("Show the compact effective Zotero connection and selection policy."))
    .action(async (_options: unknown, command: Command) => {
      try {
        const globalOptions = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        const binding = resolveZoteroSelectionBinding(config);
        io.writeJson(okEnvelope({
          capability: "organize",
          tool: "zotero_status",
          data: {
            connectionConfigured: config.zotero.enabled,
            selectionSyncRequested: binding.requested,
            origin: binding.origin,
            collectionKeys: binding.collectionKeys,
            attachmentMode: binding.attachmentMode,
            markdownMode: binding.markdownMode,
          },
        }));
      } catch (error) {
        io.writeJson(failEnvelope({
          capability: "organize",
          tool: "zotero_status",
          errors: [error instanceof Error ? error.message : String(error)],
        }));
      }
    });

  acceptAlwaysJsonFlag(zotero
    .command("sync <itemId>")
    .description("Retry the durably configured selected-item projection."))
    .option("--extraction <id>", "include one selected extraction")
    .action(async (itemId: string, options: { extraction?: string }, command: Command) => {
      try {
        const globalOptions = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        const result = await syncSelectedItemToZotero({
          config,
          itemId,
          extractionId: options.extraction,
        });
        io.writeJson(okEnvelope({
          capability: "organize",
          tool: "zotero_sync",
          data: result,
        }));
      } catch (error) {
        io.writeJson(failEnvelope({
          capability: "organize",
          tool: "zotero_sync",
          errors: [error instanceof Error ? error.message : String(error)],
        }));
      }
    });

  acceptAlwaysJsonFlag(zotero
    .command("sink <itemId>")
    .description("Plan by default; use --preview before a digest-acknowledged --apply."))
    .option("--extraction <id>", "render one local extraction as a Zotero child note")
    .option("--collection-key <key>", "existing Zotero collection key; repeat for multiple collections", appendOption, [])
    .option("--zotero-item-key <key>", "bind the local item to an existing Zotero item on first sync")
    .option("--attachment-mode <mode>", "local artifact handling: none, link, or import")
    .option("--markdown-mode <mode>", "extraction handling: none, note, link, or import")
    .option("--endpoint <url>", "explicit per-invocation Zotero MCP endpoint and write authority")
    .option("--timeout-ms <ms>", "endpoint timeout override")
    .option("--preview", "probe readiness and issue exact remote dry-run calls without writes")
    .option("--apply", "perform writes only after the current preview digest is acknowledged")
    .option("--ack <sha256>", "acknowledged preview digest required by --apply")
    .action(async (itemId: string, options: ZoteroSinkCommandOptions, command: Command) => {
      try {
        if (options.apply && options.preview) throw new Error("Choose either --preview or --apply");
        if (options.attachmentMode && !["none", "link", "import"].includes(options.attachmentMode)) {
          throw new Error("--attachment-mode must be none, link, or import");
        }
        if (options.markdownMode && !["none", "note", "link", "import"].includes(options.markdownMode)) {
          throw new Error("--markdown-mode must be none, note, link, or import");
        }
        const globalOptions = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        const binding = resolveZoteroSelectionBinding(config);
        const plan = await planZoteroSink({
          workspaceRoot: config.workspace.root,
          itemId,
          extractionId: options.extraction,
          collectionKeys: options.collectionKey?.length ? options.collectionKey : binding.collectionKeys,
          existingZoteroItemKey: options.zoteroItemKey,
          attachmentMode: options.attachmentMode ?? binding.attachmentMode,
          markdownMode: options.markdownMode ?? binding.markdownMode,
        });
        if (!options.preview && !options.apply) {
          io.writeJson(okEnvelope({
            capability: "organize",
            tool: "zotero_sink",
            planned: true,
            data: { status: "planned", plan },
            diagnostics: { remoteRequests: 0, localWrites: 0, omissions: plan.omissions },
          }));
          return;
        }

        const settings = settingsFromCommand(config, options);
        const client = createZoteroHttpClient(settings);
        if (options.preview) {
          const preview = await previewZoteroSink({ plan, settings, client });
          io.writeJson(okEnvelope({
            capability: "organize",
            tool: "zotero_sink",
            planned: true,
            data: { status: "previewed", preview },
            diagnostics: { remoteWrites: 0, omissions: plan.omissions },
          }));
          return;
        }

        if (!options.ack || !/^[a-f0-9]{64}$/u.test(options.ack)) {
          throw new Error("--apply requires --ack <previewDigest>");
        }
        const applied = await applyZoteroSink({
          plan,
          settings,
          acknowledgedPreviewDigest: options.ack,
          client,
        });
        io.writeJson(okEnvelope({
          capability: "organize",
          tool: "zotero_sink",
          data: { status: applied.receipt.status, ...applied },
          diagnostics: { omissions: plan.omissions },
          warnings: applied.receipt.status === "partial"
            ? [
                `Zotero export was partial after ${applied.receipt.failedPhase}; returned item key ${applied.receipt.zoteroItemKey}`,
                ...(applied.receiptError ? [`Local receipt write failed: ${applied.receiptError}`] : []),
              ]
            : undefined,
        }));
      } catch (error) {
        const unavailable = isZoteroUnavailable(error);
        let policy: "error" | "warn" = "error";
        try {
          const globalOptions = command.optsWithGlobals<{ config?: string }>();
          const config = await loadConfig({ explicitConfigPath: globalOptions.config });
          policy = config.zotero.unavailable;
        } catch {
          // Preserve the original failure when configuration cannot be loaded.
        }
        if (unavailable && policy === "warn") {
          io.writeJson(okEnvelope({
            capability: "organize",
            tool: "zotero_sink",
            data: { status: "zotero_unavailable", zoteroWriteOccurred: false },
            warnings: [error.message, "Local Paper Search records remain unchanged"],
          }));
          return;
        }
        io.writeJson(failEnvelope({
          capability: "organize",
          tool: "zotero_sink",
          errors: [error instanceof Error ? error.message : String(error)],
          diagnostics: unavailable ? { failureKind: "zotero_unavailable", zoteroWriteOccurred: false } : undefined,
        }));
      }
    });
}
