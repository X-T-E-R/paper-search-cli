import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { withLocks } from "../runtime/locks.js";
import { redactForRunPersistence } from "./redaction.js";
import {
  assertMaxAgeDays,
  classifyPruneEligibility,
  pruneCutoff,
} from "./retention.js";
import {
  RUN_KINDS,
  RUN_RECORD_LIMITS,
  RUN_SCHEMA_VERSION,
  RUN_STATUSES,
  type CreateResearchRunInput,
  type FinishResearchRunInput,
  type ResearchRunKind,
  type ResearchRunRecord,
  type ResearchRunStatus,
  type RunListEntry,
  type RunListFilter,
  type RunProgressUpdate,
  type RunPruneApplyResult,
  type RunPruneCandidate,
  type RunPruneExclusion,
  type RunPrunePlan,
} from "./types.js";

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GENERATED_RUN_ID_RE = /^\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESERVED_RUN_IDS = new Set(["locks", "quarantine"]);
const RECORD_KEYS = new Set([
  "schemaVersion",
  "runId",
  "kind",
  "status",
  "startedAt",
  "updatedAt",
  "finishedAt",
  "pinned",
  "request",
  "resolvedSelection",
  "build",
  "provenance",
  "attempts",
  "diagnostics",
  "result",
  "checkpoint",
  "parentRunId",
]);

export type RunStoreErrorCode =
  | "invalid_run_id"
  | "invalid_run_record"
  | "run_already_exists"
  | "run_not_found"
  | "run_conflict"
  | "run_path_unsafe"
  | "run_export_exists";

export class RunStoreError extends Error {
  constructor(
    public readonly code: RunStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunStoreError";
  }
}

export interface RunStoreOptions {
  /** Absolute, fully resolved run root from configuration. */
  root: string;
  /** Default cutoff for explicit prune. -1 disables age eligibility. */
  maxAgeDays: number;
  lockTimeoutMs?: number;
  now?: () => Date;
  randomUuid?: () => string;
  /** Called after a new run file is created and before work starts. */
  onCreated?: (record: ResearchRunRecord, root: string) => Promise<void>;
}

export interface PruneRunsOptions {
  apply?: boolean;
  maxAgeDays?: number;
  now?: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is ResearchRunKind {
  return typeof value === "string" && (RUN_KINDS as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is ResearchRunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new RunStoreError("invalid_run_record", `${label} must be a valid ISO timestamp`);
  }
}

function jsonBytes(value: unknown, label: string): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new RunStoreError("invalid_run_record", `${label} is not JSON serializable`, { cause: error });
  }
  if (serialized === undefined) {
    throw new RunStoreError("invalid_run_record", `${label} is not a JSON value`);
  }
  return Buffer.byteLength(serialized, "utf8");
}

function assertBound(value: unknown, label: string, maximum: number): void {
  const bytes = jsonBytes(value, label);
  if (bytes > maximum) {
    throw new RunStoreError(
      "invalid_run_record",
      `${label} exceeds its ${maximum}-byte durable-run limit`,
    );
  }
}

export function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId) || RESERVED_RUN_IDS.has(runId.toLowerCase())) {
    throw new RunStoreError(
      "invalid_run_id",
      "runId must be 1-128 portable filename characters and must not be reserved",
    );
  }
}

export function validateResearchRunRecord(value: unknown): ResearchRunRecord {
  if (!isRecord(value)) {
    throw new RunStoreError("invalid_run_record", "Run record must be a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (!RECORD_KEYS.has(key)) {
      throw new RunStoreError("invalid_run_record", `Run record contains unknown field: ${key}`);
    }
  }
  if (value.schemaVersion !== RUN_SCHEMA_VERSION) {
    throw new RunStoreError("invalid_run_record", "Unsupported run schemaVersion");
  }
  if (typeof value.runId !== "string") {
    throw new RunStoreError("invalid_run_record", "Run record runId is missing");
  }
  assertRunId(value.runId);
  if (!isKind(value.kind)) {
    throw new RunStoreError("invalid_run_record", "Run record kind is invalid");
  }
  if (!isStatus(value.status)) {
    throw new RunStoreError("invalid_run_record", "Run record status is invalid");
  }
  assertIsoTimestamp(value.startedAt, "startedAt");
  assertIsoTimestamp(value.updatedAt, "updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.startedAt)) {
    throw new RunStoreError("invalid_run_record", "updatedAt precedes startedAt");
  }
  if (value.status === "running") {
    if (value.finishedAt !== undefined) {
      throw new RunStoreError("invalid_run_record", "A running run must not have finishedAt");
    }
  } else {
    assertIsoTimestamp(value.finishedAt, "finishedAt");
    if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
      throw new RunStoreError("invalid_run_record", "finishedAt precedes startedAt");
    }
    if (Date.parse(value.updatedAt) < Date.parse(value.finishedAt)) {
      throw new RunStoreError("invalid_run_record", "updatedAt precedes finishedAt");
    }
  }
  if (typeof value.pinned !== "boolean") {
    throw new RunStoreError("invalid_run_record", "Run record pinned must be boolean");
  }
  if (!isRecord(value.build) || typeof value.build.cliVersion !== "string" || !value.build.cliVersion.trim()) {
    throw new RunStoreError("invalid_run_record", "Run record build.cliVersion is required");
  }
  if (value.build.sourceCommit !== undefined && typeof value.build.sourceCommit !== "string") {
    throw new RunStoreError("invalid_run_record", "Run record build.sourceCommit must be a string");
  }
  if (Object.keys(value.build).some((key) => key !== "cliVersion" && key !== "sourceCommit")) {
    throw new RunStoreError("invalid_run_record", "Run record build contains an unknown field");
  }
  for (const [key, maximum] of [
    ["provenance", RUN_RECORD_LIMITS.provenanceCount],
    ["attempts", RUN_RECORD_LIMITS.attemptsCount],
    ["diagnostics", RUN_RECORD_LIMITS.diagnosticsCount],
  ] as const) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.length > maximum) {
      throw new RunStoreError("invalid_run_record", `${key} must be an array of at most ${maximum} entries`);
    }
    assertBound(entries, key, RUN_RECORD_LIMITS.arrayBytes);
  }
  if (value.parentRunId !== undefined) {
    if (typeof value.parentRunId !== "string") {
      throw new RunStoreError("invalid_run_record", "parentRunId must be a string");
    }
    assertRunId(value.parentRunId);
    if (value.parentRunId === value.runId) {
      throw new RunStoreError("invalid_run_record", "A run cannot be its own parent");
    }
  }
  assertBound(value.request, "request", RUN_RECORD_LIMITS.requestBytes);
  if (value.resolvedSelection !== undefined) {
    assertBound(value.resolvedSelection, "resolvedSelection", RUN_RECORD_LIMITS.resolvedSelectionBytes);
  }
  if (value.result !== undefined) assertBound(value.result, "result", RUN_RECORD_LIMITS.resultBytes);
  if (value.checkpoint !== undefined) {
    assertBound(value.checkpoint, "checkpoint", RUN_RECORD_LIMITS.checkpointBytes);
  }
  assertBound(value, "run record", RUN_RECORD_LIMITS.recordBytes);
  if (JSON.stringify(redactForRunPersistence(value)) !== JSON.stringify(value)) {
    throw new RunStoreError("invalid_run_record", "Run record contains unredacted or non-canonical values");
  }
  return value as unknown as ResearchRunRecord;
}

function recordFilename(runId: string): string {
  assertRunId(runId);
  return `${runId}.json`;
}

export function generateResearchRunId(
  now: Date = new Date(),
  randomUuid: () => string = randomUUID,
): string {
  const compact = now.toISOString().replace(/[-:]/gu, "");
  const id = `${compact}-${randomUuid().toLowerCase()}`;
  if (!GENERATED_RUN_ID_RE.test(id)) {
    throw new RunStoreError("invalid_run_id", "Generated run id is invalid");
  }
  return id;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalizeWithoutCreating(target: string): Promise<string> {
  const missing: string[] = [];
  let cursor = target;
  for (;;) {
    try {
      const canonical = await realpath(cursor);
      return path.join(canonical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function privateMkdir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function ensureExportParent(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

async function writeSyncedFile(filePath: string, contents: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicCreate(filePath: string, contents: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeSyncedFile(temporaryPath, contents);
    await link(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function atomicReplace(filePath: string, contents: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeSyncedFile(temporaryPath, contents);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporaryPath, filePath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 39 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
        // Windows virus scanners/indexers can briefly hold freshly linked run
        // records without delete sharing. Retrying rename preserves atomic
        // replacement; deleting the destination first would not.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function serializeRecord(record: ResearchRunRecord): string {
  validateResearchRunRecord(record);
  return `${JSON.stringify(record, null, 2)}\n`;
}

function sanitized(value: unknown): unknown {
  return redactForRunPersistence(value) ?? null;
}

function sanitizeMany(values: readonly unknown[] | undefined): unknown[] {
  return (values ?? []).map((entry) => sanitized(entry));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ResearchRunStore {
  readonly root: string;
  readonly maxAgeDays: number;
  readonly lockRoot: string;
  private readonly lockTimeoutMs: number;
  private readonly clock: () => Date;
  private readonly randomUuid: () => string;
  private readonly onCreated?: RunStoreOptions["onCreated"];

  private constructor(root: string, options: RunStoreOptions) {
    this.root = root;
    this.maxAgeDays = options.maxAgeDays;
    this.lockRoot = path.join(root, ".locks");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.clock = options.now ?? (() => new Date());
    this.randomUuid = options.randomUuid ?? randomUUID;
    this.onCreated = options.onCreated;
  }

  static async open(options: RunStoreOptions): Promise<ResearchRunStore> {
    if (!path.isAbsolute(options.root)) {
      throw new Error("Run store root must be an absolute resolved path");
    }
    assertMaxAgeDays(options.maxAgeDays);
    const canonicalRoot = await canonicalizeWithoutCreating(path.resolve(options.root));
    return new ResearchRunStore(canonicalRoot, options);
  }

  private recordPath(runId: string): string {
    return path.join(this.root, recordFilename(runId));
  }

  private async assertExistingRootSafe(): Promise<boolean> {
    let info;
    try {
      info = await lstat(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.root) !== this.root) {
      throw new RunStoreError("run_path_unsafe", "Run root changed or is not a canonical directory");
    }
    return true;
  }

  private async ensureWritableRoot(): Promise<void> {
    await privateMkdir(this.root);
    const rootInfo = await lstat(this.root);
    const canonical = await realpath(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || canonical !== this.root) {
      throw new RunStoreError("run_path_unsafe", "Run root changed or is not a canonical directory");
    }
    await privateMkdir(this.lockRoot);
    const lockInfo = await lstat(this.lockRoot);
    const canonicalLockRoot = await realpath(this.lockRoot);
    if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink() || canonicalLockRoot !== this.lockRoot) {
      throw new RunStoreError("run_path_unsafe", "Run lock root is not a canonical in-root directory");
    }
  }

  private async assertReadableRecordPath(runId: string): Promise<{ path: string; bytes: number }> {
    if (!await this.assertExistingRootSafe()) {
      throw new RunStoreError("run_not_found", `Run not found: ${runId}`);
    }
    const filePath = this.recordPath(runId);
    let info;
    try {
      info = await lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RunStoreError("run_not_found", `Run not found: ${runId}`, { cause: error });
      }
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new RunStoreError("run_path_unsafe", `Run record is not a regular file: ${runId}`);
    }
    const canonical = await realpath(filePath);
    if (!isContained(this.root, canonical) || path.dirname(canonical) !== this.root) {
      throw new RunStoreError("run_path_unsafe", `Run record escapes the canonical run root: ${runId}`);
    }
    return { path: filePath, bytes: info.size };
  }

  private async readUnlocked(runId: string): Promise<{ record: ResearchRunRecord; bytes: number }> {
    const target = await this.assertReadableRecordPath(runId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(target.path, "utf8"));
    } catch (error) {
      throw new RunStoreError("invalid_run_record", `Run record is corrupt: ${runId}`, { cause: error });
    }
    const record = validateResearchRunRecord(parsed);
    if (record.runId !== runId) {
      throw new RunStoreError("invalid_run_record", `Run record identity does not match its filename: ${runId}`);
    }
    return { record, bytes: target.bytes };
  }

  private async withRunLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    assertRunId(runId);
    await this.ensureWritableRoot();
    return withLocks([`run/${runId}`], action, {
      lockRoot: this.lockRoot,
      timeoutMs: this.lockTimeoutMs,
      command: `durable run ${runId}`,
    });
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }

  async create(input: CreateResearchRunInput): Promise<ResearchRunRecord> {
    await this.ensureWritableRoot();
    const now = this.clock();
    const runId = input.runId ?? generateResearchRunId(now, this.randomUuid);
    assertRunId(runId);
    if (input.parentRunId !== undefined) assertRunId(input.parentRunId);
    const timestamp = now.toISOString();
    const record: ResearchRunRecord = {
      schemaVersion: RUN_SCHEMA_VERSION,
      runId,
      kind: input.kind,
      status: "running",
      startedAt: timestamp,
      updatedAt: timestamp,
      pinned: false,
      request: sanitized(input.request),
      ...(input.resolvedSelection !== undefined
        ? { resolvedSelection: sanitized(input.resolvedSelection) }
        : {}),
      build: {
        cliVersion: input.build.cliVersion,
        ...(input.build.sourceCommit ? { sourceCommit: input.build.sourceCommit } : {}),
      },
      provenance: sanitizeMany(input.provenance),
      attempts: [],
      diagnostics: [],
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    };
    const contents = serializeRecord(record);
    try {
      await atomicCreate(this.recordPath(runId), contents);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RunStoreError("run_already_exists", `Run already exists: ${runId}`, { cause: error });
      }
      throw error;
    }
    if (this.onCreated) {
      try {
        await this.onCreated(record, this.root);
      } catch (error) {
        try {
          await rm(this.recordPath(runId));
        } catch (cleanupError) {
          throw new RunStoreError(
            "run_conflict",
            `Run creation hook failed (${formatError(error)}) and the new run could not be rolled back: ${runId}`,
            { cause: cleanupError },
          );
        }
        throw error;
      }
    }
    return record;
  }

  async read(runId: string): Promise<ResearchRunRecord> {
    assertRunId(runId);
    return (await this.readUnlocked(runId)).record;
  }

  async updateProgress(runId: string, update: RunProgressUpdate): Promise<ResearchRunRecord> {
    return this.withRunLock(runId, async () => {
      const current = (await this.readUnlocked(runId)).record;
      if (current.status !== "running") {
        throw new RunStoreError("run_conflict", `Cannot update terminal run: ${runId}`);
      }
      if (update.checkpoint !== undefined && update.clearCheckpoint === true) {
        throw new RunStoreError("run_conflict", "checkpoint and clearCheckpoint are mutually exclusive");
      }
      const next: ResearchRunRecord = {
        ...current,
        updatedAt: this.timestamp(),
        provenance: [...current.provenance, ...sanitizeMany(update.appendProvenance)],
        attempts: [...current.attempts, ...sanitizeMany(update.appendAttempts)],
        diagnostics: [...current.diagnostics, ...sanitizeMany(update.appendDiagnostics)],
      };
      if (update.clearCheckpoint === true) delete next.checkpoint;
      else if (update.checkpoint !== undefined) next.checkpoint = sanitized(update.checkpoint);
      await atomicReplace(this.recordPath(runId), serializeRecord(next));
      return next;
    });
  }

  async finish(runId: string, input: FinishResearchRunInput): Promise<ResearchRunRecord> {
    return this.withRunLock(runId, async () => {
      const current = (await this.readUnlocked(runId)).record;
      if (current.status !== "running") {
        throw new RunStoreError("run_conflict", `Run is already terminal: ${runId}`);
      }
      if (input.checkpoint !== undefined && input.clearCheckpoint === true) {
        throw new RunStoreError("run_conflict", "checkpoint and clearCheckpoint are mutually exclusive");
      }
      const finishedAt = this.timestamp();
      const next: ResearchRunRecord = {
        ...current,
        status: input.status,
        updatedAt: finishedAt,
        finishedAt,
        provenance: [...current.provenance, ...sanitizeMany(input.appendProvenance)],
        attempts: [...current.attempts, ...sanitizeMany(input.appendAttempts)],
        diagnostics: [...current.diagnostics, ...sanitizeMany(input.appendDiagnostics)],
        ...(input.result !== undefined ? { result: sanitized(input.result) } : {}),
      };
      if (input.clearCheckpoint === true) delete next.checkpoint;
      else if (input.checkpoint !== undefined) next.checkpoint = sanitized(input.checkpoint);
      await atomicReplace(this.recordPath(runId), serializeRecord(next));
      return next;
    });
  }

  async resume(runId: string): Promise<ResearchRunRecord> {
    return this.withRunLock(runId, async () => {
      const current = (await this.readUnlocked(runId)).record;
      if (
        current.checkpoint === undefined ||
        (current.status !== "interrupted" && current.status !== "partial" && current.status !== "failed")
      ) {
        throw new RunStoreError("run_conflict", `Run is not resumable: ${runId}`);
      }
      const reopenedAt = this.timestamp();
      const next: ResearchRunRecord = {
        ...current,
        status: "running",
        updatedAt: reopenedAt,
        attempts: [
          ...current.attempts,
          {
            kind: "run.reopened",
            previousStatus: current.status,
            reopenedAt,
          },
        ],
      };
      delete next.finishedAt;
      await atomicReplace(this.recordPath(runId), serializeRecord(next));
      return next;
    });
  }

  async setPinned(runId: string, pinned: boolean): Promise<ResearchRunRecord> {
    return this.withRunLock(runId, async () => {
      const current = (await this.readUnlocked(runId)).record;
      const next: ResearchRunRecord = {
        ...current,
        pinned,
        updatedAt: this.timestamp(),
      };
      await atomicReplace(this.recordPath(runId), serializeRecord(next));
      return next;
    });
  }

  async list(filter: RunListFilter = {}): Promise<RunListEntry[]> {
    if (!await this.assertExistingRootSafe()) return [];
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: RunListEntry[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const runId = name.slice(0, -".json".length);
      if (!RUN_ID_RE.test(runId)) {
        if (!filter.kind && (!filter.status || filter.status === "corrupt")) {
          let bytes = 0;
          try {
            bytes = (await lstat(path.join(this.root, name))).size;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          entries.push({
            runId,
            status: "corrupt",
            bytes,
            error: "Run record filename contains an invalid run id",
          });
        }
        continue;
      }
      try {
        const { record, bytes } = await this.readUnlocked(runId);
        if (filter.kind && record.kind !== filter.kind) continue;
        if (filter.status && record.status !== filter.status) continue;
        entries.push({
          runId,
          kind: record.kind,
          status: record.status,
          startedAt: record.startedAt,
          updatedAt: record.updatedAt,
          ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
          pinned: record.pinned,
          bytes,
        });
      } catch (error) {
        if (error instanceof RunStoreError && error.code === "run_not_found") continue;
        if (filter.kind || (filter.status && filter.status !== "corrupt")) continue;
        let bytes = 0;
        try {
          bytes = (await lstat(path.join(this.root, name))).size;
        } catch {
          // A concurrent rename may remove the entry between enumeration and reporting.
        }
        entries.push({
          runId,
          status: "corrupt",
          bytes,
          error: formatError(error),
        });
      }
    }
    return entries.sort((left, right) => {
      const leftTime = left.startedAt ?? "";
      const rightTime = right.startedAt ?? "";
      return rightTime.localeCompare(leftTime) || right.runId.localeCompare(left.runId);
    });
  }

  async export(runId: string, outputPath: string): Promise<{ runId: string; path: string; bytes: number }> {
    if (!outputPath.trim()) throw new Error("Run export output path is required");
    const record = await this.read(runId);
    const absoluteOutput = path.resolve(outputPath);
    await ensureExportParent(path.dirname(absoluteOutput));
    const contents = serializeRecord(record);
    try {
      await atomicCreate(absoluteOutput, contents);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RunStoreError(
          "run_export_exists",
          `Refusing to overwrite existing run export: ${absoluteOutput}`,
          { cause: error },
        );
      }
      throw error;
    }
    return { runId, path: absoluteOutput, bytes: Buffer.byteLength(contents, "utf8") };
  }

  private async buildPrunePlan(maxAgeDays: number, now: Date): Promise<RunPrunePlan> {
    const cutoff = pruneCutoff(now, maxAgeDays);
    const candidates: RunPruneCandidate[] = [];
    const exclusions: RunPruneExclusion[] = [];
    for (const entry of await this.list()) {
      if (entry.status === "corrupt") {
        exclusions.push({ runId: entry.runId, reason: "corrupt", detail: entry.error });
        continue;
      }
      let current;
      try {
        current = await this.readUnlocked(entry.runId);
      } catch (error) {
        exclusions.push({ runId: entry.runId, reason: "corrupt", detail: formatError(error) });
        continue;
      }
      const { record, bytes } = current;
      const classification = classifyPruneEligibility(record, bytes, now, maxAgeDays);
      if ("candidate" in classification) candidates.push(classification.candidate);
      else exclusions.push({ runId: record.runId, reason: classification.excluded });
    }
    return {
      planned: true,
      maxAgeDays,
      evaluatedAt: now.toISOString(),
      ...(cutoff ? { cutoffAt: cutoff.toISOString() } : {}),
      candidates,
      exclusions,
      totalBytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
    };
  }

  async prune(options: PruneRunsOptions = {}): Promise<RunPrunePlan | RunPruneApplyResult> {
    const maxAgeDays = options.maxAgeDays ?? this.maxAgeDays;
    assertMaxAgeDays(maxAgeDays);
    const now = options.now ?? this.clock();
    if (options.apply !== true) return this.buildPrunePlan(maxAgeDays, now);

    await this.ensureWritableRoot();
    return withLocks(["store"], async () => {
      const plan = await this.buildPrunePlan(maxAgeDays, now);
      const deleted: RunPruneCandidate[] = [];
      const skipped: RunPruneExclusion[] = [];
      const quarantineRoot = path.join(this.root, ".quarantine");
      await privateMkdir(quarantineRoot);
      const quarantineInfo = await lstat(quarantineRoot);
      const canonicalQuarantine = await realpath(quarantineRoot);
      if (
        !quarantineInfo.isDirectory() ||
        quarantineInfo.isSymbolicLink() ||
        !isContained(this.root, canonicalQuarantine) ||
        path.dirname(canonicalQuarantine) !== this.root
      ) {
        throw new RunStoreError("run_path_unsafe", "Run quarantine is not a canonical same-root directory");
      }

      for (const candidate of plan.candidates) {
        await withLocks([`run/${candidate.runId}`], async () => {
          let current;
          try {
            current = await this.readUnlocked(candidate.runId);
          } catch (error) {
            skipped.push({
              runId: candidate.runId,
              reason: "corrupt",
              detail: formatError(error),
            });
            return;
          }
          const classification = classifyPruneEligibility(
            current.record,
            current.bytes,
            now,
            maxAgeDays,
          );
          if (!("candidate" in classification)) {
            skipped.push({ runId: candidate.runId, reason: classification.excluded });
            return;
          }
          const source = (await this.assertReadableRecordPath(candidate.runId)).path;
          const quarantined = path.join(
            canonicalQuarantine,
            `${recordFilename(candidate.runId)}.${this.randomUuid()}.deleted`,
          );
          await rename(source, quarantined);
          await rm(quarantined, { force: true });
          deleted.push(classification.candidate);
        }, {
          lockRoot: this.lockRoot,
          timeoutMs: this.lockTimeoutMs,
          command: `prune run ${candidate.runId}`,
        });
      }
      return {
        planned: false,
        maxAgeDays: plan.maxAgeDays,
        evaluatedAt: plan.evaluatedAt,
        ...(plan.cutoffAt ? { cutoffAt: plan.cutoffAt } : {}),
        candidates: plan.candidates,
        exclusions: plan.exclusions,
        totalBytes: plan.totalBytes,
        deleted,
        skipped,
        deletedBytes: deleted.reduce((total, entry) => total + entry.bytes, 0),
      };
    }, {
      lockRoot: this.lockRoot,
      timeoutMs: this.lockTimeoutMs,
      command: "prune durable runs",
    });
  }
}

export async function openResearchRunStore(options: RunStoreOptions): Promise<ResearchRunStore> {
  return ResearchRunStore.open(options);
}
