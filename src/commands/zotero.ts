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

interface ZoteroSinkCommandOptions {
  extraction?: string;
  collectionKey?: string;
  endpoint?: string;
  timeoutMs?: string;
  preview?: boolean;
  apply?: boolean;
  ack?: string;
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
    .description("Plan and explicitly export local bibliographic records through Zotero MCP Neo.");

  zotero
    .command("sink <itemId>")
    .description("Plan by default; use --preview before a digest-acknowledged --apply.")
    .option("--extraction <id>", "render one local extraction as a Zotero child note")
    .option("--collection-key <key>", "existing Zotero collection key; collections are never created")
    .option("--endpoint <url>", "explicit per-invocation Zotero MCP endpoint and write authority")
    .option("--timeout-ms <ms>", "endpoint timeout override")
    .option("--preview", "probe readiness and issue exact remote dry-run calls without writes")
    .option("--apply", "perform writes only after the current preview digest is acknowledged")
    .option("--ack <sha256>", "acknowledged preview digest required by --apply")
    .action(async (itemId: string, options: ZoteroSinkCommandOptions, command: Command) => {
      try {
        if (options.apply && options.preview) throw new Error("Choose either --preview or --apply");
        const globalOptions = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        const plan = await planZoteroSink({
          workspaceRoot: config.workspace.root,
          itemId,
          extractionId: options.extraction,
          collectionKey: options.collectionKey,
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
