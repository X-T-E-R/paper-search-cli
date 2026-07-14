import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  listProviderPackageDirectories,
  resolveProviderPackageDirectory,
} from "../providers/paths.js";
import type { ResolvedConfig } from "../config/schema.js";
import { createPlanEnvelope, type PlannedOperationData } from "../surface/plan.js";
import { okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import {
  ARTIFACT_RECORDS_DIR,
  createArtifactRecord,
} from "./artifactStore.js";
import { loadMaterialProviderPackage, type LoadedMaterialProviderPackage } from "./package/load.js";
import {
  AcquireResolverError,
  planResolverProvider,
  resolveAcquireCandidates,
  type ResolverProviderSummary,
} from "./acquireResolver.js";
import { tryParseDoiIdentifier } from "./resolverResult.js";
import type { MaterialIdentifierInput, MaterialResolverCandidateLocation } from "./types.js";
import type { ArtifactAttempt, ArtifactKind, ArtifactRecord } from "./records.js";
import { createMaterialRuntimeContext } from "./runtime/createContext.js";
import { invokeMaterialProviderFactoryInNode } from "./runtime/invokeNodeFactory.js";
import type { WorkspaceItemRecord } from "../workspace/store.js";

export interface ArtifactDownloadOptions {
  config: ResolvedConfig;
  input: string;
  attachTo?: string;
  providerId?: string;
  resolverProviderId?: string;
  policy?: string;
  download?: boolean;
}

export interface ArtifactDownloadProviderSummary {
  id: string;
  name: string;
  version: string;
  packagePath: string;
}

export interface ArtifactDownloadInputSummary {
  kind: "url" | "workspace_item" | "identifier";
  value: string;
  url?: string;
  identifier?: MaterialIdentifierInput;
  itemId?: string;
  attachedItemId?: string;
}

export interface ArtifactDownloadData {
  record: ArtifactRecord;
  provider: ArtifactDownloadProviderSummary;
  input: ArtifactDownloadInputSummary;
  download: boolean;
  artifactPath?: string;
}

interface ResolvedArtifactDownloadInput {
  summary: ArtifactDownloadInputSummary;
  sourceUrl?: string;
  identifier?: MaterialIdentifierInput;
  resolverRequired: boolean;
  attachedItemId?: string;
}

interface ProviderDownloadResult {
  kind: ArtifactKind;
  filename: string;
  contentType?: string;
  bytes: Buffer;
  remoteUrl: string;
  status?: number;
  message?: string;
}

export { AcquireResolverError } from "./acquireResolver.js";

export class ArtifactDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactDownloadError";
  }
}

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const ARTIFACT_KINDS = ["pdf", "html", "office", "image", "bytes", "auto"] as const;
const WORKSPACE_ITEMS_DIR = "items";

function fail(message: string): never {
  throw new ArtifactDownloadError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeProviderId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) fail("--provider must be a non-empty provider id");
  if (!PROVIDER_ID_RE.test(trimmed)) {
    fail("--provider must be a material provider id, not a path");
  }
  return trimmed;
}

function normalizePolicy(value: string | undefined): string {
  if (value === undefined) return "default";
  const trimmed = value.trim();
  if (!trimmed) fail("--policy must be a non-empty policy name");
  return trimmed;
}

function normalizeAttachTo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) fail("--attach-to must be a non-empty workspace item id");
  return assertWorkspaceItemId(trimmed);
}

function assertWorkspaceItemId(itemId: string): string {
  if (!ARTIFACT_ID_RE.test(itemId) || itemId === "." || itemId === "..") {
    fail(`Invalid workspace item id: ${itemId}`);
  }
  return itemId;
}

function workspaceItemPath(workspaceRoot: string, itemId: string): string {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_ITEMS_DIR, `${assertWorkspaceItemId(itemId)}.json`);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

async function readWorkspaceItem(
  workspaceRoot: string,
  itemId: string,
): Promise<WorkspaceItemRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(workspaceItemPath(workspaceRoot, itemId), "utf8")) as WorkspaceItemRecord;
    if (parsed.id !== itemId) {
      fail(`Workspace item id mismatch in record: ${itemId}`);
    }
    return parsed;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function extractFirstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFirstString(item);
      if (found) return found;
    }
  }
  return undefined;
}

function firstHttpUrl(values: unknown[]): string | undefined {
  for (const value of values) {
    const found = extractFirstString(value);
    if (found && isHttpUrl(found)) return found;
  }
  return undefined;
}

function sourceUrlFromWorkspaceItem(record: WorkspaceItemRecord): string | undefined {
  const looseItem = record.item as unknown as Record<string, unknown>;
  const detailPdf = isPlainObject(record.detail) ? record.detail.pdf : undefined;
  const detailPdfUrls = isPlainObject(detailPdf) ? detailPdf.urls : undefined;
  return firstHttpUrl([
    record.url,
    record.item.url,
    looseItem.URL,
    looseItem.sourceUrl,
    detailPdfUrls,
  ]);
}

function doiFromWorkspaceItem(record: WorkspaceItemRecord): string | undefined {
  const looseItem = record.item as unknown as Record<string, unknown>;
  const doi = extractFirstString([record.item.DOI, looseItem.DOI]);
  if (!doi) return undefined;
  const parsed = tryParseDoiIdentifier(doi);
  return parsed?.value;
}

async function resolveDownloadInput(
  config: ResolvedConfig,
  input: string,
  attachTo: string | undefined,
): Promise<ResolvedArtifactDownloadInput> {
  const trimmed = input.trim();
  if (!trimmed) fail("artifact download input must be non-empty");

  const doiIdentifier = tryParseDoiIdentifier(trimmed);
  if (doiIdentifier) {
    const attachedItemId = normalizeAttachTo(attachTo);
    return {
      identifier: doiIdentifier,
      resolverRequired: true,
      attachedItemId,
      summary: {
        kind: "identifier",
        value: trimmed,
        identifier: doiIdentifier,
        ...(attachedItemId ? { attachedItemId } : {}),
      },
    };
  }

  if (isHttpUrl(trimmed)) {
    const attachedItemId = normalizeAttachTo(attachTo);
    return {
      sourceUrl: trimmed,
      resolverRequired: false,
      attachedItemId,
      summary: {
        kind: "url",
        value: trimmed,
        url: trimmed,
        ...(attachedItemId ? { attachedItemId } : {}),
      },
    };
  }

  const item = await readWorkspaceItem(config.workspace.root, trimmed);
  if (!item) {
    fail(`Input is not an http(s) URL, DOI, or known workspace item id: ${input}`);
  }
  const sourceUrl = sourceUrlFromWorkspaceItem(item);
  const attachedItemId = normalizeAttachTo(attachTo) ?? item.id;
  if (sourceUrl) {
    return {
      sourceUrl,
      resolverRequired: false,
      attachedItemId,
      summary: {
        kind: "workspace_item",
        value: trimmed,
        itemId: item.id,
        url: sourceUrl,
        attachedItemId,
      },
    };
  }

  const itemDoi = doiFromWorkspaceItem(item);
  if (!itemDoi) {
    fail(`Workspace item has no http(s) artifact URL or DOI: ${item.id}`);
  }
  const identifier = tryParseDoiIdentifier(itemDoi);
  if (!identifier) {
    fail(`Workspace item DOI is not valid for resolver input: ${itemDoi}`);
  }
  return {
    identifier,
    resolverRequired: true,
    attachedItemId,
    summary: {
      kind: "workspace_item",
      value: trimmed,
      itemId: item.id,
      identifier,
      attachedItemId,
    },
  };
}

async function providerPackageDirectories(installDir: string): Promise<string[]> {
  return (await listProviderPackageDirectories(installDir, "material"))
    .sort((left, right) => left.localeCompare(right));
}

function providerSupportsDownload(providerPackage: LoadedMaterialProviderPackage): boolean {
  return (
    providerPackage.manifest.kind === "artifact_downloader" &&
    providerPackage.manifest.capabilities.inputs.includes("url") &&
    providerPackage.manifest.capabilities.outputs.includes("bytes")
  );
}

async function selectDownloaderProvider(options: {
  installDir: string;
  providerId?: string;
}): Promise<LoadedMaterialProviderPackage> {
  const installDir = path.resolve(options.installDir);
  const providerId = normalizeProviderId(options.providerId);
  const packageDirs = providerId
    ? [await resolveProviderPackageDirectory(installDir, "material", providerId)]
    : await providerPackageDirectories(installDir);

  const loadErrors: string[] = [];
  for (const packageDir of packageDirs) {
    try {
      const providerPackage = await loadMaterialProviderPackage(packageDir);
      if (providerId && providerPackage.manifest.id !== providerId) {
        fail(
          `Selected provider id ${providerId} does not match manifest id ${providerPackage.manifest.id}`,
        );
      }
      if (providerSupportsDownload(providerPackage)) {
        return providerPackage;
      }
      loadErrors.push(`${providerPackage.manifest.id}: does not support URL -> bytes artifact download`);
    } catch (error) {
      loadErrors.push(`${path.basename(packageDir)}: ${formatError(error)}`);
    }
  }

  fail(
    [
      providerId
        ? `Material artifact downloader provider not usable: ${providerId}`
        : `No usable material artifact downloader provider found in ${installDir}`,
      ...loadErrors.map((entry) => `- ${entry}`),
    ].join("\n"),
  );
}

function providerSummary(providerPackage: LoadedMaterialProviderPackage): ArtifactDownloadProviderSummary {
  return {
    id: providerPackage.manifest.id,
    name: providerPackage.manifest.name,
    version: providerPackage.manifest.version,
    packagePath: providerPackage.packagePath,
  };
}

function artifactKindFromValue(value: unknown, fallback: ArtifactKind): ArtifactKind {
  if (typeof value !== "string") return fallback;
  if ((ARTIFACT_KINDS as readonly string[]).includes(value)) return value as ArtifactKind;
  fail(`download().kind must be one of: ${ARTIFACT_KINDS.join(", ")}`);
}

function inferArtifactKind(contentType: string | undefined, filename: string | undefined): ArtifactKind {
  const content = (contentType ?? "").toLowerCase();
  const name = (filename ?? "").toLowerCase();
  if (content.includes("pdf") || name.endsWith(".pdf")) return "pdf";
  if (content.includes("html") || name.endsWith(".html") || name.endsWith(".htm")) return "html";
  if (content.startsWith("image/") || /\.(png|jpe?g|gif|webp|tiff?)$/u.test(name)) return "image";
  if (
    content.includes("officedocument") ||
    content.includes("msword") ||
    /\.(docx?|pptx?|xlsx?)$/u.test(name)
  ) {
    return "office";
  }
  return "bytes";
}

function sanitizeFilename(value: string | undefined): string {
  const cleaned = (value ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned || "artifact.bin";
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    return base || undefined;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`download().${field} must be a string`);
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`download().${field} must be a finite number`);
  }
  return value;
}

function decodeProviderBytes(value: Record<string, unknown>): Buffer {
  const bytesBase64 =
    optionalString(value.bytesBase64, "bytesBase64") ??
    optionalString(value.contentBase64, "contentBase64") ??
    optionalString(value.bodyBase64, "bodyBase64");
  if (bytesBase64 !== undefined) {
    if (!bytesBase64.trim()) fail("download().bytesBase64 must be non-empty");
    return Buffer.from(bytesBase64, "base64");
  }

  const text = optionalString(value.text, "text") ?? optionalString(value.body, "body");
  if (text !== undefined) {
    return Buffer.from(text, "utf8");
  }

  fail("download() must return bytesBase64/contentBase64/bodyBase64 or text/body");
}

function parseProviderDownloadResult(value: unknown, sourceUrl: string): ProviderDownloadResult {
  if (!isPlainObject(value)) {
    fail("download() must return an object");
  }
  const remoteUrl = optionalString(value.remoteUrl, "remoteUrl") ?? sourceUrl;
  if (!isHttpUrl(remoteUrl)) fail("download().remoteUrl must be an http(s) URL when provided");
  const contentType = optionalString(value.contentType, "contentType");
  const filename = sanitizeFilename(optionalString(value.filename, "filename") ?? filenameFromUrl(remoteUrl));
  const kind = artifactKindFromValue(value.kind, inferArtifactKind(contentType, filename));
  const status = optionalNumber(value.status, "status");
  const message = optionalString(value.message, "message");
  return {
    kind,
    filename,
    ...(contentType ? { contentType } : {}),
    bytes: decodeProviderBytes(value),
    remoteUrl,
    ...(status !== undefined ? { status } : {}),
    ...(message ? { message } : {}),
  };
}

function toWorkspacePath(value: string): string {
  return value.split(path.sep).join("/");
}

function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`Workspace artifact path escapes workspace root: ${relativePath}`);
  }
  return target;
}

function artifactBytesRelativePath(artifactId: string, filename: string): string {
  return toWorkspacePath(path.join("material", "files", artifactId, filename));
}

async function writeArtifactBytes(options: {
  workspaceRoot: string;
  relativePath: string;
  bytes: Buffer;
}): Promise<void> {
  const target = resolveWorkspacePath(options.workspaceRoot, options.relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, options.bytes);
}

function providerInput(options: {
  resolvedInput: ResolvedArtifactDownloadInput;
  sourceUrl: string;
  policy: string;
  candidate?: MaterialResolverCandidateLocation;
}): Record<string, unknown> {
  return {
    url: options.sourceUrl,
    source: options.resolvedInput.summary,
    ...(options.candidate ? { candidate: options.candidate } : {}),
    ...(options.resolvedInput.attachedItemId ? { attachTo: options.resolvedInput.attachedItemId } : {}),
    policy: options.policy,
    download: true,
  };
}

function artifactRecordMessage(download: boolean, providerMessage?: string): string {
  if (providerMessage) return providerMessage;
  return download
    ? "Artifact downloaded through material provider"
    : "Artifact download recorded but bytes were not requested";
}

function artifactRecordInput(options: {
  artifactId: string;
  createdAt: string;
  provider: ArtifactDownloadProviderSummary;
  resolvedInput: ResolvedArtifactDownloadInput;
  policy: string;
  download: false;
  resolver?: ResolverProviderSummary;
  resolverSource?: string;
  priorAttempts?: ArtifactAttempt[];
  sourceUrl?: string;
}): Parameters<typeof createArtifactRecord>[1];
function artifactRecordInput(options: {
  artifactId: string;
  createdAt: string;
  provider: ArtifactDownloadProviderSummary;
  resolvedInput: ResolvedArtifactDownloadInput;
  policy: string;
  download: true;
  providerResult: ProviderDownloadResult;
  relativePath: string;
  resolver?: ResolverProviderSummary;
  resolverSource?: string;
  priorAttempts?: ArtifactAttempt[];
  sourceUrl: string;
  chosenCandidate?: MaterialResolverCandidateLocation;
}): Parameters<typeof createArtifactRecord>[1];
function artifactRecordInput(options: {
  artifactId: string;
  createdAt: string;
  provider: ArtifactDownloadProviderSummary;
  resolvedInput: ResolvedArtifactDownloadInput;
  policy: string;
  download: boolean;
  providerResult?: ProviderDownloadResult;
  relativePath?: string;
  resolver?: ResolverProviderSummary;
  resolverSource?: string;
  priorAttempts?: ArtifactAttempt[];
  sourceUrl?: string;
  chosenCandidate?: MaterialResolverCandidateLocation;
}): Parameters<typeof createArtifactRecord>[1] {
  const downloaded = options.download && options.providerResult && options.relativePath;
  const effectiveSourceUrl =
    options.sourceUrl ?? options.resolvedInput.sourceUrl ?? options.resolvedInput.identifier?.value;
  const filename = downloaded
    ? options.providerResult!.filename
    : sanitizeFilename(
        filenameFromUrl(effectiveSourceUrl ?? "") ?? options.resolvedInput.identifier?.value ?? "artifact.bin",
      );
  const kind = downloaded
    ? options.providerResult!.kind
    : inferArtifactKind(undefined, filename);
  const message = artifactRecordMessage(options.download, options.providerResult?.message);
  const downloadAttempt: ArtifactAttempt = {
    tier: downloaded ? "artifact-download" : "artifact-record",
    source: effectiveSourceUrl,
    providerId: options.provider.id,
    ok: true,
    ...(downloaded && options.providerResult!.status !== undefined ? { status: options.providerResult!.status } : {}),
    message,
    at: options.createdAt,
  };
  if (options.chosenCandidate?.host) {
    downloadAttempt.message = `${downloadAttempt.message} (host: ${options.chosenCandidate.host})`;
  }
  return {
    id: options.artifactId,
    createdAt: options.createdAt,
    kind,
    status: downloaded ? "downloaded" : "requested",
    ...(options.resolvedInput.attachedItemId ? { itemId: options.resolvedInput.attachedItemId } : {}),
    filename,
    ...(downloaded && options.providerResult!.contentType ? { contentType: options.providerResult!.contentType } : {}),
    ...(downloaded ? { path: options.relativePath! } : {}),
    remoteUrl: downloaded ? options.providerResult!.remoteUrl : effectiveSourceUrl,
    ...(downloaded ? { sizeBytes: options.providerResult!.bytes.byteLength } : {}),
    provenance: {
      origin: downloaded ? "download" : "resolved",
      sourceUrl: effectiveSourceUrl,
      providerId: options.provider.id,
      policy: options.policy,
      ...(options.resolver ? { resolverProviderId: options.resolver.id } : {}),
      ...(options.resolverSource ? { resolverSource: options.resolverSource } : {}),
      ...(options.resolvedInput.summary.kind === "workspace_item"
        ? { resolvedFrom: options.resolvedInput.summary.itemId }
        : {}),
      ...(options.resolvedInput.summary.kind === "identifier"
        ? { resolvedFrom: options.resolvedInput.summary.identifier?.value }
        : {}),
    },
    attempts:
      options.priorAttempts && options.priorAttempts.length > 0
        ? options.priorAttempts
        : [downloadAttempt],
    message,
  };
}

async function downloadWithResolverFunnel(options: {
  config: ResolvedConfig;
  resolvedInput: ResolvedArtifactDownloadInput;
  policy: string;
  resolverProviderId?: string;
  providerPackage: LoadedMaterialProviderPackage;
  provider: ArtifactDownloadProviderSummary;
  downloadMethod: (...args: unknown[]) => Promise<unknown>;
}): Promise<{
  providerResult: ProviderDownloadResult;
  resolver?: ResolverProviderSummary;
  resolverSource?: string;
  attempts: ArtifactAttempt[];
  chosenCandidate?: MaterialResolverCandidateLocation;
  sourceUrl: string;
}> {
  let candidates: MaterialResolverCandidateLocation[] = [];
  let resolver: ResolverProviderSummary | undefined;
  let resolverSource: string | undefined;
  let priorAttempts: ArtifactAttempt[] = [];
  let sourceUrl = options.resolvedInput.sourceUrl;

  if (options.resolvedInput.resolverRequired) {
    if (!options.resolvedInput.identifier) {
      fail("Resolver input is missing identifier");
    }
    const resolved = await resolveAcquireCandidates({
      config: options.config,
      identifier: options.resolvedInput.identifier,
      policy: options.policy,
      resolverProviderId: options.resolverProviderId,
      attachTo: options.resolvedInput.attachedItemId ?? null,
    });
    resolver = resolved.resolver;
    resolverSource = resolved.resolverResult.provenance.source;
    candidates = resolved.candidates;
    priorAttempts = resolved.attempts;
    sourceUrl = candidates[0]!.url;
  } else if (!sourceUrl) {
    fail("Artifact download input did not resolve to a source URL");
  } else {
    candidates = [{ url: sourceUrl }];
  }

  const attempts = [...priorAttempts];
  const candidateErrors: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const attemptAt = new Date().toISOString();
    try {
      const providerResult = parseProviderDownloadResult(
        await options.downloadMethod(
          providerInput({
            resolvedInput: options.resolvedInput,
            sourceUrl: candidate.url,
            policy: options.policy,
            candidate,
          }),
        ),
        candidate.url,
      );
      attempts.push({
        tier: "artifact-download-candidate",
        source: candidate.url,
        providerId: options.provider.id,
        ok: true,
        ...(providerResult.status !== undefined ? { status: providerResult.status } : {}),
        message:
          candidates.length > 1
            ? `Downloaded candidate ${index + 1}/${candidates.length}`
            : providerResult.message ?? "Downloaded artifact bytes",
        at: attemptAt,
      });
      return {
        providerResult,
        resolver,
        resolverSource,
        attempts,
        chosenCandidate: candidate,
        sourceUrl: candidate.url,
      };
    } catch (error) {
      const message = formatError(error);
      candidateErrors.push(`${candidate.url}: ${message}`);
      attempts.push({
        tier: "artifact-download-candidate",
        source: candidate.url,
        providerId: options.provider.id,
        ok: false,
        message,
        at: attemptAt,
      });
    }
  }

  fail(
    [
      "All resolver candidate downloads failed",
      ...candidateErrors.map((entry) => `- ${entry}`),
    ].join("\n"),
  );
}

export async function planArtifactDownload(
  options: ArtifactDownloadOptions,
): Promise<ResultEnvelope<PlannedOperationData>> {
  const started = Date.now();
  const attachTo = normalizeAttachTo(options.attachTo);
  const policy = normalizePolicy(options.policy);
  const download = options.download !== false;
  const resolvedInput = await resolveDownloadInput(options.config, options.input, attachTo);
  const resolverPlan = resolvedInput.resolverRequired
    ? await planResolverProvider({
        installDir: options.config.providers.installDir,
        resolverProviderId: options.resolverProviderId,
      })
    : undefined;
  const providerPackage = await selectDownloaderProvider({
    installDir: options.config.providers.installDir,
    providerId: options.providerId,
  });
  const provider = providerSummary(providerPackage);
  const plannedFileDir = path.join(options.config.workspace.root, "material", "files", "<new-artifact-id>");
  const recordDir = path.join(options.config.workspace.root, ARTIFACT_RECORDS_DIR);
  const resolverSteps = resolverPlan
    ? [
        {
          id: "load-resolver",
          action: "read" as const,
          description: `Load material artifact resolver provider ${resolverPlan.id}.`,
          targetPaths: [resolverPlan.packagePath],
          providerId: resolverPlan.id,
          policy,
        },
        {
          id: "run-resolver",
          action: "compute" as const,
          description: "Resolve identifier to ordered artifact candidate locations.",
          targetPaths: [],
          providerId: resolverPlan.id,
          policy,
        },
      ]
    : [];

  return createPlanEnvelope({
    capability: "acquire",
    tool: "artifact_download",
    selectedPolicy: policy,
    selectedProvider: {
      id: provider.id,
      kind: "material",
      capabilities: ["acquire"],
    },
    intendedSteps: [
      ...resolverSteps,
      {
        id: "load-downloader",
        action: "read",
        description: `Load material artifact downloader provider ${provider.id}.`,
        targetPaths: [provider.packagePath],
        providerId: provider.id,
        policy,
      },
      ...(download
        ? [
            {
              id: "run-downloader",
              action: providerPackage.manifest.capabilities.network ? "network" as const : "compute" as const,
              description: resolverPlan
                ? "Try artifact downloads for resolver candidate URLs until one succeeds."
                : "Acquire artifact bytes from the resolved URL.",
              targetPaths: [],
              providerId: provider.id,
              policy,
            },
            {
              id: "write-artifact",
              action: "write" as const,
              description: "Write artifact bytes to the workspace.",
              targetPaths: [plannedFileDir],
              providerId: provider.id,
              policy,
            },
          ]
        : []),
      {
        id: "record-artifact",
        action: "record",
        description: resolvedInput.attachedItemId
          ? `Create an artifact record attached to workspace item ${resolvedInput.attachedItemId}.`
          : "Create a standalone artifact record.",
        targetPaths: [recordDir],
        providerId: provider.id,
        policy,
      },
    ],
    targetPaths: download
      ? [
          ...(resolverPlan ? [resolverPlan.packagePath] : []),
          provider.packagePath,
          plannedFileDir,
          recordDir,
        ]
      : [...(resolverPlan ? [resolverPlan.packagePath] : []), provider.packagePath, recordDir],
    diagnostics: {
      elapsedMs: Date.now() - started,
      inputKind: resolvedInput.summary.kind,
      workspaceRoot: options.config.workspace.root,
      attachTo: resolvedInput.attachedItemId ?? null,
      download,
      ...(resolverPlan ? { resolverProviderId: resolverPlan.id } : {}),
    },
    provenance: {
      configPaths: options.config.meta.loadedFiles,
      ...(resolverPlan ? { providerIds: [resolverPlan.id, provider.id] } : { providerIds: [provider.id] }),
    },
  });
}

export async function runArtifactDownload(
  options: ArtifactDownloadOptions,
): Promise<ResultEnvelope<ArtifactDownloadData>> {
  const started = Date.now();
  const attachTo = normalizeAttachTo(options.attachTo);
  const policy = normalizePolicy(options.policy);
  const download = options.download !== false;
  const resolvedInput = await resolveDownloadInput(options.config, options.input, attachTo);
  const providerPackage = await selectDownloaderProvider({
    installDir: options.config.providers.installDir,
    providerId: options.providerId,
  });
  const provider = providerSummary(providerPackage);
  const artifactId = randomUUID();
  const createdAt = new Date().toISOString();

  let record: ArtifactRecord;
  let artifactPath: string | undefined;
  if (!download) {
    let priorAttempts: ArtifactAttempt[] = [];
    let resolver: ResolverProviderSummary | undefined;
    let resolverSource: string | undefined;
    let sourceUrl = resolvedInput.sourceUrl;
    if (resolvedInput.resolverRequired && resolvedInput.identifier) {
      const resolved = await resolveAcquireCandidates({
        config: options.config,
        identifier: resolvedInput.identifier,
        policy,
        resolverProviderId: options.resolverProviderId,
        attachTo: resolvedInput.attachedItemId ?? null,
      });
      resolver = resolved.resolver;
      resolverSource = resolved.resolverResult.provenance.source;
      priorAttempts = resolved.attempts;
      sourceUrl = resolved.candidates[0]?.url;
    }
    record = await createArtifactRecord(
      options.config.workspace.root,
      artifactRecordInput({
        artifactId,
        createdAt,
        provider,
        resolvedInput,
        policy,
        download: false,
        resolver,
        resolverSource,
        priorAttempts,
        sourceUrl,
      }),
    );
  } else {
    const runtimeContext = createMaterialRuntimeContext({
      manifest: providerPackage.manifest,
      providerConfig: (options.config.platform[provider.id] ?? {}) as Record<string, unknown>,
      policy: {
        name: policy,
        capability: "acquire",
        attachTo: resolvedInput.attachedItemId ?? null,
      },
      cacheRoot: path.join(options.config.workspace.root, ".material-provider-cache"),
      workspaceRoot: options.config.workspace.root,
    });
    const loadedProvider = await invokeMaterialProviderFactoryInNode(
      providerPackage.bundleCode,
      providerPackage.manifest,
      runtimeContext,
    );
    const downloadMethod = loadedProvider.provider.download;
    if (!downloadMethod) {
      fail(`Material provider ${provider.id} does not implement download()`);
    }
    const funnelResult = await downloadWithResolverFunnel({
      config: options.config,
      resolvedInput,
      policy,
      resolverProviderId: options.resolverProviderId,
      providerPackage,
      provider,
      downloadMethod,
    });
    artifactPath = artifactBytesRelativePath(artifactId, funnelResult.providerResult.filename);
    await writeArtifactBytes({
      workspaceRoot: options.config.workspace.root,
      relativePath: artifactPath,
      bytes: funnelResult.providerResult.bytes,
    });
    record = await createArtifactRecord(
      options.config.workspace.root,
      artifactRecordInput({
        artifactId,
        createdAt,
        provider,
        resolvedInput,
        policy,
        download: true,
        providerResult: funnelResult.providerResult,
        relativePath: artifactPath,
        resolver: funnelResult.resolver,
        resolverSource: funnelResult.resolverSource,
        priorAttempts: funnelResult.attempts,
        sourceUrl: funnelResult.sourceUrl,
        chosenCandidate: funnelResult.chosenCandidate,
      }),
    );
  }

  const providerIds: string[] = [
    ...(record.provenance.resolverProviderId ? [record.provenance.resolverProviderId] : []),
    provider.id,
  ];

  return okEnvelope({
    capability: "acquire",
    tool: "artifact_download",
    data: {
      record,
      provider,
      input: resolvedInput.summary,
      download,
      ...(artifactPath ? { artifactPath } : {}),
    },
    diagnostics: {
      elapsedMs: Date.now() - started,
      inputKind: resolvedInput.summary.kind,
      workspaceRoot: options.config.workspace.root,
      attachTo: resolvedInput.attachedItemId ?? null,
      download,
      ...(record.provenance.resolverProviderId
        ? { resolverProviderId: record.provenance.resolverProviderId }
        : {}),
    },
    provenance: {
      providerIds,
      policy,
      configPaths: options.config.meta.loadedFiles,
    },
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
