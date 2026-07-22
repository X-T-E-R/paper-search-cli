import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import {
  listArtifactRecords,
  readArtifactRecord,
  type ArtifactRecord,
} from "../material/artifactStore.js";
import {
  planArtifactDownload,
  runArtifactDownloadWithInstitutionalFallback,
  AcquireResolverError,
  type ArtifactDownloadData,
} from "../material/artifactDownload.js";
import type { Io } from "../runtime/io.js";
import type { PlannedOperationData } from "../surface/plan.js";
import { failEnvelope, okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";

interface ArtifactDownloadOptions {
  attachTo?: string;
  provider?: string;
  resolver?: string;
  policy?: string;
  download?: boolean;
  dryRun?: boolean;
  json?: boolean;
  institutional?: boolean;
  institutionProfile?: string;
}

interface ArtifactListOptions {
  item?: string;
  json?: boolean;
}

interface ArtifactShowOptions {
  json?: boolean;
}

export interface ArtifactListData {
  records: ArtifactRecord[];
  count: number;
  itemId?: string;
}

export interface ArtifactShowData {
  record: ArtifactRecord;
}

type ArtifactDownloadEnvelope =
  | ResultEnvelope<ArtifactDownloadData>
  | ResultEnvelope<PlannedOperationData>
  | ResultEnvelope<null>;
type ArtifactListEnvelope = ResultEnvelope<ArtifactListData> | ResultEnvelope<null>;
type ArtifactShowEnvelope = ResultEnvelope<ArtifactShowData> | ResultEnvelope<null>;

export function registerArtifactCommands(program: Command, io: Io): void {
  const artifact = program
    .command("artifact")
    .description("Download, list, and inspect workspace artifact records.");

  artifact
    .command("download <input>")
    .description("Fetch or record an artifact through a material downloader provider.")
    .option("--attach-to <itemId>", "attach the artifact record to a local workspace item id")
    .option("--provider <id>", "material artifact downloader provider id; defaults to the first usable downloader")
    .option("--resolver <id>", "material artifact_resolver provider id used for DOI inputs; defaults to the first usable resolver")
    .option("--policy <name>", "policy label recorded on the acquisition run")
    .option("--download", "download artifact bytes into the local workspace", true)
    .option("--no-download", "record a requested artifact without fetching bytes")
    .option("--dry-run", "return the shared acquisition plan without writing files or records")
    .option("--institutional", "offer a local visible-browser continuation only if ordinary DOI acquisition fails")
    .option("--institution-profile <id>", "named local institutional session profile")
    .option("--json", "emit machine-readable JSON envelope")
    .action(async (input: string, options: ArtifactDownloadOptions, command: Command) => {
      const started = Date.now();
      let envelope: ArtifactDownloadEnvelope;
      try {
        const globalOptions = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        const materialOptions = {
          config,
          input,
          attachTo: options.attachTo,
          providerId: options.provider,
          resolverProviderId: options.resolver,
          policy: options.policy,
          download: options.download !== false,
          institutional: options.institutional === true,
          institutionProfile: options.institutionProfile,
        };
        envelope = options.dryRun
          ? await planArtifactDownload(materialOptions)
          : await runArtifactDownloadWithInstitutionalFallback(materialOptions);
      } catch (error) {
        envelope = failEnvelope({
          capability: "acquire",
          tool: "artifact_download",
          errors: [formatError(error)],
          diagnostics: {
            elapsedMs: Date.now() - started,
            ...(error instanceof AcquireResolverError
              ? { failureKind: error.failureKind, attempts: error.attempts }
              : {}),
          },
          ...(error instanceof AcquireResolverError && error.actions.length > 0
            ? { state: "action_required", actions: error.actions }
            : {}),
        });
      }

      io.writeJson(envelope);
    });

  artifact
    .command("list")
    .description("List artifact records, optionally filtered by workspace item id.")
    .option("--item <id>", "only return artifacts attached to this workspace item id")
    .option("--json", "emit machine-readable JSON envelope")
    .action(async (options: ArtifactListOptions, command: Command) => {
      const started = Date.now();
      let envelope: ArtifactListEnvelope;
      try {
        const globalOptions = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        const records = await listArtifactRecords(config.workspace.root, {
          itemId: options.item,
        });
        envelope = okEnvelope({
          capability: "acquire",
          tool: "artifact_list",
          data: {
            records,
            count: records.length,
            ...(options.item ? { itemId: options.item } : {}),
          },
          diagnostics: {
            workspaceRoot: config.workspace.root,
            sourceCounts: { artifacts: records.length },
            ...(options.item ? { itemId: options.item } : {}),
            elapsedMs: Date.now() - started,
          },
        });
      } catch (error) {
        envelope = failEnvelope({
          capability: "acquire",
          tool: "artifact_list",
          errors: [formatError(error)],
          diagnostics: { elapsedMs: Date.now() - started },
        });
      }

      io.writeJson(envelope);
    });

  artifact
    .command("show <artifactId>")
    .description("Show one artifact record by artifact id.")
    .option("--json", "emit machine-readable JSON envelope")
    .action(async (artifactId: string, _options: ArtifactShowOptions, command: Command) => {
      const started = Date.now();
      let envelope: ArtifactShowEnvelope;
      try {
        const globalOptions = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        const record = await readArtifactRecord(config.workspace.root, artifactId);
        envelope = record
          ? okEnvelope({
              capability: "acquire",
              tool: "artifact_show",
              data: { record },
              diagnostics: {
                workspaceRoot: config.workspace.root,
                artifactId,
                elapsedMs: Date.now() - started,
              },
              provenance: {
                providerIds: record.provenance.providerId ? [record.provenance.providerId] : undefined,
                policy: record.provenance.policy,
              },
            })
          : failEnvelope({
              capability: "acquire",
              tool: "artifact_show",
              errors: [`Artifact not found: ${artifactId}`],
              diagnostics: {
                workspaceRoot: config.workspace.root,
                artifactId,
                elapsedMs: Date.now() - started,
              },
            });
      } catch (error) {
        envelope = failEnvelope({
          capability: "acquire",
          tool: "artifact_show",
          errors: [formatError(error)],
          diagnostics: { artifactId, elapsedMs: Date.now() - started },
        });
      }

      io.writeJson(envelope);
    });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
