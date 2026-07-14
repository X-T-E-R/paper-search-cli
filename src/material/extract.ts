import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  listProviderPackageDirectories,
  resolveProviderPackageDirectory,
} from "../providers/paths.js";
import type { ResolvedConfig } from "../config/schema.js";
import { createPlanEnvelope, type PlannedOperationData } from "../surface/plan.js";
import { okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import { readArtifactRecord, resolveArtifactRecordPath } from "./artifactStore.js";
import { EXTRACTION_RECORDS_DIR, createExtractionRecord } from "./extractionStore.js";
import { loadMaterialProviderPackage, type LoadedMaterialProviderPackage } from "./package/load.js";
import type { ArtifactRecord, ExtractionRecord, ExtractionSource } from "./records.js";
import { createMaterialRuntimeContext } from "./runtime/createContext.js";
import { resolveMaterialProviderCacheRoot } from "./cache.js";
import { invokeMaterialProviderFactoryInNode } from "./runtime/invokeNodeFactory.js";
import type { MaterialInputKind } from "./types.js";
import { writeLocalStorageBytes } from "../storage/local.js";
import type { LocalStorageRefV1 } from "../storage/types.js";

export interface MaterialExtractionOptions {
  config: ResolvedConfig;
  input: string;
  attachTo?: string;
  providerId?: string;
  policy?: string;
}

export interface MaterialExtractionPlanForInputKindOptions {
  config: ResolvedConfig;
  inputKind: MaterialInputKind;
  sourceKind: ExtractionSource["kind"];
  attachTo?: string;
  providerId?: string;
  policy?: string;
}

export interface MaterialExtractionProviderSummary {
  id: string;
  name: string;
  version: string;
  packagePath: string;
}

export interface MaterialExtractionData {
  record: ExtractionRecord;
  markdown: string;
  markdownPath: string;
  jsonPath?: string;
  provider: MaterialExtractionProviderSummary;
}

export interface MaterialExtractionCommittedOutput {
  kind: "markdown" | "json";
  path: string;
  storage: LocalStorageRefV1;
  sha256: string;
  sizeBytes: number;
}

/** One or more extraction files were committed without a durable record. */
export interface MaterialExtractionOrphanOutcome {
  outcome: "orphaned";
  commitStage: "output" | "metadata";
  extractionId: string;
  outputs: MaterialExtractionCommittedOutput[];
  metadataPath: string;
  error: string;
}

export type MaterialExtractionResultEnvelope = ResultEnvelope<MaterialExtractionData> & {
  /** Present only when one or more output files were committed without record metadata. */
  orphan?: MaterialExtractionOrphanOutcome;
};

interface ResolvedExtractionInput {
  source: ExtractionSource;
  materialInputKind: MaterialInputKind;
  artifact?: ArtifactRecord;
}

interface ProviderExtractionResult {
  markdown: string;
  metadata?: unknown;
  cacheHit: boolean;
  message?: string;
}

class ExtractionOutputCommitError extends Error {
  constructor(
    readonly committedOutputs: MaterialExtractionCommittedOutput[],
    cause: unknown,
  ) {
    super(formatError(cause));
    this.name = "ExtractionOutputCommitError";
  }
}

export class MaterialExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialExtractionError";
  }
}

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

function fail(message: string): never {
  throw new MaterialExtractionError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!ARTIFACT_ID_RE.test(trimmed) || trimmed === "." || trimmed === "..") {
    fail(`Invalid workspace item id: ${trimmed}`);
  }
  return trimmed;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function toWorkspacePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function resolvePathInput(cwd: string, input: string): Promise<string | null> {
  const candidate = path.isAbsolute(input) ? input : path.resolve(cwd, input);
  try {
    const candidateStat = await stat(candidate);
    if (!candidateStat.isFile()) {
      fail(`Path input must be a file: ${candidate}`);
    }
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function resolveExtractionInput(config: ResolvedConfig, input: string): Promise<ResolvedExtractionInput> {
  const trimmed = input.trim();
  if (!trimmed) fail("extract input must be non-empty");

  if (isHttpUrl(trimmed)) {
    return {
      source: { kind: "url", url: trimmed },
      materialInputKind: "url",
    };
  }

  const resolvedPath = await resolvePathInput(config.meta.cwd, trimmed);
  if (resolvedPath) {
    return {
      source: { kind: "path", path: resolvedPath },
      materialInputKind: "local_file",
    };
  }

  if (ARTIFACT_ID_RE.test(trimmed)) {
    const artifact = await readArtifactRecord(config.workspace.root, trimmed);
    if (artifact) {
      const artifactPath = await resolveArtifactRecordPath(config.workspace.root, artifact);
      const resolvedArtifact = artifactPath ? { ...artifact, path: artifactPath } : artifact;
      return {
        source: { kind: "artifact", artifactId: artifact.id },
        materialInputKind: "artifact",
        artifact: resolvedArtifact,
      };
    }
  }

  fail(`Input is not an http(s) URL, existing local file, or known artifact id: ${input}`);
}

async function providerPackageDirectories(installDir: string): Promise<string[]> {
  return (await listProviderPackageDirectories(installDir, "material"))
    .sort((left, right) => left.localeCompare(right));
}

function providerSupportsInput(providerPackage: LoadedMaterialProviderPackage, inputKind: MaterialInputKind): boolean {
  return (
    providerPackage.manifest.kind === "extractor" &&
    providerPackage.manifest.capabilities.inputs.includes(inputKind) &&
    providerPackage.manifest.capabilities.outputs.includes("markdown")
  );
}

async function selectExtractorProvider(options: {
  installDir: string;
  inputKind: MaterialInputKind;
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
      if (providerSupportsInput(providerPackage, options.inputKind)) {
        return providerPackage;
      }
      loadErrors.push(
        `${providerPackage.manifest.id}: does not support ${options.inputKind} -> markdown extraction`,
      );
    } catch (error) {
      loadErrors.push(`${path.basename(packageDir)}: ${formatError(error)}`);
    }
  }

  fail(
    [
      providerId
        ? `Material extractor provider not usable: ${providerId}`
        : `No usable material extractor provider found in ${installDir}`,
      ...loadErrors.map((entry) => `- ${entry}`),
    ].join("\n"),
  );
}

function providerSummary(providerPackage: LoadedMaterialProviderPackage): MaterialExtractionProviderSummary {
  return {
    id: providerPackage.manifest.id,
    name: providerPackage.manifest.name,
    version: providerPackage.manifest.version,
    packagePath: providerPackage.packagePath,
  };
}

function parseProviderExtractionResult(value: unknown): ProviderExtractionResult {
  if (!isPlainObject(value)) {
    fail("extract() must return an object");
  }
  const markdown = value.markdown;
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    fail("extract() must return non-empty markdown");
  }
  const cacheHit = value.cacheHit;
  if (cacheHit !== undefined && typeof cacheHit !== "boolean") {
    fail("extract().cacheHit must be a boolean when provided");
  }
  const message = value.message;
  if (message !== undefined && typeof message !== "string") {
    fail("extract().message must be a string when provided");
  }
  return {
    markdown,
    ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
    cacheHit: cacheHit === true,
    ...(message !== undefined ? { message } : {}),
  };
}

function outputRelativePaths(extractionId: string): { markdownPath: string; jsonPath: string } {
  const base = toWorkspacePath(path.join(extractionId));
  return {
    markdownPath: `${base}/content.md`,
    jsonPath: `${base}/result.json`,
  };
}

async function writeExtractionOutputs(options: {
  extractionRoot: string;
  markdownPath: string;
  jsonPath: string;
  markdown: string;
  providerResult: ProviderExtractionResult;
}): Promise<{
  markdown: { ref: LocalStorageRefV1; path: string };
  json: { ref: LocalStorageRefV1; path: string };
}> {
  const markdown = await writeLocalStorageBytes({
    root: options.extractionRoot,
    key: options.markdownPath,
    area: "extraction",
    bytes: Buffer.from(options.markdown, "utf8"),
  });
  let json: { ref: LocalStorageRefV1; path: string };
  try {
    json = await writeLocalStorageBytes({
      root: options.extractionRoot,
      key: options.jsonPath,
      area: "extraction",
      bytes: Buffer.from(`${JSON.stringify(
        {
          markdown: options.providerResult.markdown,
          metadata: options.providerResult.metadata ?? null,
          cacheHit: options.providerResult.cacheHit,
          message: options.providerResult.message ?? null,
        },
        null,
        2,
      )}\n`, "utf8"),
    });
  } catch (error) {
    throw new ExtractionOutputCommitError([committedOutput("markdown", markdown)], error);
  }
  return { markdown, json };
}

function committedOutput(
  kind: MaterialExtractionCommittedOutput["kind"],
  output: { ref: LocalStorageRefV1; path: string },
): MaterialExtractionCommittedOutput {
  return {
    kind,
    path: output.path,
    storage: output.ref,
    sha256: output.ref.sha256!,
    sizeBytes: output.ref.sizeBytes!,
  };
}

function providerInput(options: {
  resolvedInput: ResolvedExtractionInput;
  attachTo?: string;
  policy: string;
}): Record<string, unknown> {
  return {
    source: options.resolvedInput.source,
    ...(options.resolvedInput.artifact ? { artifact: options.resolvedInput.artifact } : {}),
    ...(options.attachTo ? { attachTo: options.attachTo } : {}),
    policy: options.policy,
  };
}

export async function planMaterialExtractionForInputKind(
  options: MaterialExtractionPlanForInputKindOptions,
): Promise<ResultEnvelope<PlannedOperationData>> {
  const started = Date.now();
  const attachTo = normalizeAttachTo(options.attachTo);
  const policy = normalizePolicy(options.policy);
  const providerPackage = await selectExtractorProvider({
    installDir: options.config.providers.installDir,
    inputKind: options.inputKind,
    providerId: options.providerId,
  });
  const provider = providerSummary(providerPackage);
  const plannedOutputDir = path.join(
    options.config.storage.extractionRoot,
    "<new-extraction-id>",
  );

  return createPlanEnvelope({
    capability: "extract",
    tool: "extract",
    selectedPolicy: policy,
    selectedProvider: {
      id: provider.id,
      kind: "material",
      capabilities: ["extract"],
    },
    intendedSteps: [
      {
        id: "load-extractor",
        action: "read",
        description: `Load material extractor provider ${provider.id}.`,
        targetPaths: [provider.packagePath],
        providerId: provider.id,
        policy,
      },
      {
        id: "run-extractor",
        action: providerPackage.manifest.capabilities.network ? "network" : "compute",
        description: `Extract Markdown from ${options.sourceKind} input.`,
        targetPaths: [],
        providerId: provider.id,
        policy,
      },
      {
        id: "write-markdown",
        action: "write",
        description: "Write extracted Markdown and structured provider output to the configured extraction root.",
        targetPaths: [plannedOutputDir],
        providerId: provider.id,
        policy,
      },
      {
        id: "record-extraction",
        action: "record",
        description: attachTo
          ? `Create an extraction record attached to workspace item ${attachTo}.`
          : "Create a standalone extraction record.",
        targetPaths: [path.join(options.config.workspace.root, "material", "extractions")],
        providerId: provider.id,
        policy,
      },
    ],
    targetPaths: [
      provider.packagePath,
      plannedOutputDir,
      path.join(options.config.workspace.root, "material", "extractions"),
    ],
    diagnostics: {
      elapsedMs: Date.now() - started,
      inputKind: options.inputKind,
      workspaceRoot: options.config.workspace.root,
      attachTo: attachTo ?? null,
    },
  });
}

export async function planMaterialExtraction(
  options: MaterialExtractionOptions,
): Promise<ResultEnvelope<PlannedOperationData>> {
  const resolvedInput = await resolveExtractionInput(options.config, options.input);
  return planMaterialExtractionForInputKind({
    config: options.config,
    inputKind: resolvedInput.materialInputKind,
    sourceKind: resolvedInput.source.kind,
    attachTo: options.attachTo,
    providerId: options.providerId,
    policy: options.policy,
  });
}

export async function runMaterialExtraction(
  options: MaterialExtractionOptions,
): Promise<MaterialExtractionResultEnvelope> {
  const started = Date.now();
  const attachTo = normalizeAttachTo(options.attachTo);
  const policy = normalizePolicy(options.policy);
  const resolvedInput = await resolveExtractionInput(options.config, options.input);
  const providerPackage = await selectExtractorProvider({
    installDir: options.config.providers.installDir,
    inputKind: resolvedInput.materialInputKind,
    providerId: options.providerId,
  });
  const provider = providerSummary(providerPackage);
  const runtimeContext = createMaterialRuntimeContext({
    manifest: providerPackage.manifest,
    providerConfig: (options.config.platform[provider.id] ?? {}) as Record<string, unknown>,
    policy: {
      name: policy,
      capability: "extract",
      attachTo: attachTo ?? null,
    },
    cacheRoot: resolveMaterialProviderCacheRoot(options.config),
    workspaceRoot: options.config.workspace.root,
  });
  const loadedProvider = await invokeMaterialProviderFactoryInNode(
    providerPackage.bundleCode,
    providerPackage.manifest,
    runtimeContext,
  );
  const extractMethod = loadedProvider.provider.extract;
  if (!extractMethod) {
    fail(`Material provider ${provider.id} does not implement extract()`);
  }
  const providerResult = parseProviderExtractionResult(
    await extractMethod(providerInput({ resolvedInput, attachTo, policy })),
  );
  const extractionId = randomUUID();
  const outputs = outputRelativePaths(extractionId);
  let storedOutputs: Awaited<ReturnType<typeof writeExtractionOutputs>>;
  try {
    storedOutputs = await writeExtractionOutputs({
      extractionRoot: options.config.storage.extractionRoot,
      markdownPath: outputs.markdownPath,
      jsonPath: outputs.jsonPath,
      markdown: providerResult.markdown,
      providerResult,
    });
  } catch (error) {
    if (error instanceof ExtractionOutputCommitError) {
      return extractionOrphanEnvelope({
        options,
        started,
        provider,
        policy,
        attachTo,
        resolvedInput,
        extractionId,
        commitStage: "output",
        committedOutputs: error.committedOutputs,
        error: error.message,
      });
    }
    throw error;
  }
  let record: ExtractionRecord;
  try {
    record = await createExtractionRecord(options.config.workspace.root, {
      id: extractionId,
      source: resolvedInput.source,
      backend: provider.id,
      options: {
        policy,
        providerVersion: provider.version,
      },
      outputs: {
        markdownStorage: storedOutputs.markdown.ref,
        jsonStorage: storedOutputs.json.ref,
        markdown: providerResult.markdown,
      },
      cacheHit: providerResult.cacheHit,
      ...(attachTo ? { itemId: attachTo } : {}),
      ...(providerResult.message ? { message: providerResult.message } : {}),
    });
  } catch (error) {
    return extractionOrphanEnvelope({
      options,
      started,
      provider,
      policy,
      attachTo,
      resolvedInput,
      extractionId,
      commitStage: "metadata",
      committedOutputs: [
        committedOutput("markdown", storedOutputs.markdown),
        committedOutput("json", storedOutputs.json),
      ],
      error: formatError(error),
    });
  }

  return okEnvelope({
    capability: "extract",
    tool: "extract",
    data: {
      record,
      markdown: providerResult.markdown,
      markdownPath: storedOutputs.markdown.path,
      jsonPath: storedOutputs.json.path,
      provider,
    },
    diagnostics: {
      elapsedMs: Date.now() - started,
      inputKind: resolvedInput.materialInputKind,
      workspaceRoot: options.config.workspace.root,
      attachTo: attachTo ?? null,
    },
    provenance: {
      providerIds: [provider.id],
      policy,
      configPaths: options.config.meta.loadedFiles,
    },
  });
}

function extractionOrphanEnvelope(options: {
  options: MaterialExtractionOptions;
  started: number;
  provider: MaterialExtractionProviderSummary;
  policy: string;
  attachTo?: string;
  resolvedInput: ResolvedExtractionInput;
  extractionId: string;
  commitStage: MaterialExtractionOrphanOutcome["commitStage"];
  committedOutputs: MaterialExtractionCommittedOutput[];
  error: string;
}): MaterialExtractionResultEnvelope {
  const orphan: MaterialExtractionOrphanOutcome = {
    outcome: "orphaned",
    commitStage: options.commitStage,
    extractionId: options.extractionId,
    outputs: options.committedOutputs,
    metadataPath: path.join(
      path.resolve(options.options.config.workspace.root),
      EXTRACTION_RECORDS_DIR,
      `${options.extractionId}.json`,
    ),
    error: options.error,
  };
  return {
    ok: false,
    capability: "extract",
    tool: "extract",
    data: null as unknown as MaterialExtractionData,
    orphan,
    diagnostics: {
      elapsedMs: Date.now() - options.started,
      inputKind: options.resolvedInput.materialInputKind,
      workspaceRoot: options.options.config.workspace.root,
      attachTo: options.attachTo ?? null,
      partial: true,
      orphanedBytes: true,
      commitStage: options.commitStage,
    },
    errors: [`Extraction ${options.commitStage} commit failed after bytes were committed: ${options.error}`],
    provenance: {
      providerIds: [options.provider.id],
      policy: options.policy,
      configPaths: options.options.config.meta.loadedFiles,
    },
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
