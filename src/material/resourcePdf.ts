import type { ResolvedConfig } from "../config/schema.js";
import type { PlannedOperationData } from "../surface/plan.js";
import type { ResultEnvelope } from "../surface/resultEnvelope.js";
import {
  readWorkspaceItemRecord,
  recordArtifactAsWorkspaceAttachment,
  type WorkspacePdfResult,
} from "../workspace/store.js";
import {
  planArtifactDownload,
  runArtifactDownload,
  type ArtifactDownloadData,
} from "./artifactDownload.js";

export interface ResourcePdfCompatibilityOptions {
  config: ResolvedConfig;
  itemKey: string;
  url?: string;
  filename?: string;
  download?: boolean;
  providerId?: string;
  resolverProviderId?: string;
  policy?: string;
}

function artifactOptions(options: ResourcePdfCompatibilityOptions) {
  return {
    config: options.config,
    input: options.url ?? options.itemKey,
    attachTo: options.itemKey,
    filename: options.filename,
    download: options.download !== false,
    providerId: options.providerId,
    resolverProviderId: options.resolverProviderId,
    policy: options.policy ?? "resource-pdf-compatibility",
  };
}

export async function planResourcePdfCompatibility(
  options: ResourcePdfCompatibilityOptions,
): Promise<ResultEnvelope<PlannedOperationData>> {
  const item = await readWorkspaceItemRecord(options.config.workspace.root, options.itemKey);
  if (!item) throw new Error(`Item not found: ${options.itemKey}`);
  const envelope = await planArtifactDownload(artifactOptions(options));
  return {
    ...envelope,
    tool: "resource_pdf",
    diagnostics: {
      ...envelope.diagnostics,
      compatibilityAlias: true,
      itemId: options.itemKey,
    },
  };
}

export async function runResourcePdfCompatibility(
  options: ResourcePdfCompatibilityOptions,
): Promise<ResultEnvelope<WorkspacePdfResult | ArtifactDownloadData>> {
  const item = await readWorkspaceItemRecord(options.config.workspace.root, options.itemKey);
  if (!item) throw new Error(`Item not found: ${options.itemKey}`);
  const existing = (item.attachments ?? []).find(
      (attachment) =>
      (attachment.contentType === "application/pdf" || /\.pdf$/iu.test(attachment.filename)) &&
      attachment.status === "attached",
  );
  if (existing?.artifactId) {
    return {
      ok: true,
      capability: "acquire",
      tool: "resource_pdf",
      data: {
        ok: true,
        itemKey: item.id,
        itemId: item.id,
        attachmentId: existing.id,
        artifactId: existing.artifactId,
        filename: existing.filename,
        path: existing.path,
        storage: existing.storage,
        sourceUrl: existing.sourceUrl,
        attachment: existing,
        message: existing.status === "attached" ? "PDF already attached" : "PDF already requested",
      },
      diagnostics: { workspaceRoot: options.config.workspace.root, compatibilityAlias: true },
    };
  }

  const artifactEnvelope = await runArtifactDownload(artifactOptions(options));
  if (!artifactEnvelope.ok || !artifactEnvelope.data || !("record" in artifactEnvelope.data)) {
    return { ...artifactEnvelope, tool: "resource_pdf" };
  }
  const compatibility = await recordArtifactAsWorkspaceAttachment(
    options.config.workspace.root,
    artifactEnvelope.data.record,
  );
  if (!compatibility.ok) {
    return {
      ok: false,
      capability: "acquire",
      tool: "resource_pdf",
      data: artifactEnvelope.data,
      diagnostics: {
        ...artifactEnvelope.diagnostics,
        compatibilityAlias: true,
        partial: true,
        itemId: options.itemKey,
      },
      warnings: [compatibility.message ?? "Artifact was created but the legacy attachment projection failed"],
      errors: [compatibility.message ?? "Legacy attachment projection failed"],
      provenance: artifactEnvelope.provenance,
    };
  }
  return {
    ...artifactEnvelope,
    tool: "resource_pdf",
    data: compatibility,
    diagnostics: {
      ...artifactEnvelope.diagnostics,
      compatibilityAlias: true,
      itemId: options.itemKey,
    },
  };
}
