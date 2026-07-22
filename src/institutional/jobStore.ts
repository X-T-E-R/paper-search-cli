import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig } from "../config/schema.js";

export type InstitutionalJobStatus = "queued" | "running" | "action_required" | "acquired" | "not_entitled" | "unsupported" | "failed" | "canceled";

export interface InstitutionalJob {
  schemaVersion: 1;
  id: string;
  status: InstitutionalJobStatus;
  doi: string;
  profileId: string;
  attachTo?: string;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  reasonCode?: string;
  message?: string;
  artifactId?: string;
  /** Stable local commit identity allocated before any sidecar attempt. */
  commit: {
    artifactId: string;
    filename: string;
    startedAt?: string;
  };
  roots: {
    configRoot: string;
    contextId: string;
    workspaceRoot: string;
    artifactRoot: string;
    jobRoot: string;
  };
}

const ID_RE = /^[0-9a-f-]{36}$/u;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function institutionalJobRoot(config: ResolvedConfig): string {
  return path.join(path.dirname(path.resolve(config.meta.userConfigPath)), "state", "institutional", "jobs");
}

function assertId(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid institutional job id: ${id}`);
  return id;
}

function target(root: string, id: string): string {
  return path.join(path.resolve(root), `${assertId(id)}.json`);
}

function parse(value: unknown): InstitutionalJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("institutional job must be an object");
  const job = value as InstitutionalJob;
  const allowed = new Set(["schemaVersion", "id", "status", "doi", "profileId", "attachTo", "createdAt", "updatedAt", "attemptCount", "reasonCode", "message", "artifactId", "commit", "roots"]);
  const unexpected = Object.keys(value as Record<string, unknown>).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`institutional job contains unexpected fields: ${unexpected.join(", ")}`);
  const statuses: InstitutionalJobStatus[] = ["queued", "running", "action_required", "acquired", "not_entitled", "unsupported", "failed", "canceled"];
  if (job.schemaVersion !== 1 || !ID_RE.test(job.id) || !statuses.includes(job.status)) throw new Error("institutional job header is invalid");
  if (typeof job.doi !== "string" || !job.doi.startsWith("10.") || !PROFILE_RE.test(job.profileId)) throw new Error("institutional job input is invalid");
  if (!job.roots || typeof job.roots.contextId !== "string" || !job.roots.contextId ||
      [job.roots.configRoot, job.roots.workspaceRoot, job.roots.artifactRoot, job.roots.jobRoot]
        .some((entry) => typeof entry !== "string" || !path.isAbsolute(entry))) {
    throw new Error("institutional job roots are invalid");
  }
  const rootKeys = Object.keys(job.roots);
  if (rootKeys.length !== 5 || rootKeys.some((key) => !["configRoot", "contextId", "workspaceRoot", "artifactRoot", "jobRoot"].includes(key))) {
    throw new Error("institutional job roots contain unexpected fields");
  }
  if (!Number.isSafeInteger(job.attemptCount) || job.attemptCount < 0 ||
      typeof job.createdAt !== "string" || typeof job.updatedAt !== "string") {
    throw new Error("institutional job timestamps or attempt count are invalid");
  }
  const commitKeys = job.commit ? Object.keys(job.commit) : [];
  if (!job.commit || commitKeys.some((key) => !["artifactId", "filename", "startedAt"].includes(key)) ||
      commitKeys.length < 2 || !ID_RE.test(job.commit.artifactId) || job.commit.filename !== "paper.pdf" ||
      (job.commit.startedAt !== undefined && typeof job.commit.startedAt !== "string")) {
    throw new Error("institutional job commit intent is invalid");
  }
  if (job.artifactId !== undefined && job.artifactId !== job.commit.artifactId) {
    throw new Error("institutional job terminal artifact id differs from its commit intent");
  }
  return job;
}

async function atomicWrite(root: string, job: InstitutionalJob): Promise<void> {
  await mkdir(root, { recursive: true });
  const file = target(root, job.id);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createInstitutionalJob(config: ResolvedConfig, input: { doi: string; profileId?: string; attachTo?: string }): Promise<InstitutionalJob> {
  const profileId = input.profileId ?? "default";
  if (!PROFILE_RE.test(profileId)) throw new Error("institution profile id is invalid");
  const now = new Date().toISOString();
  const root = institutionalJobRoot(config);
  const job: InstitutionalJob = {
    schemaVersion: 1,
    id: randomUUID(),
    status: "queued",
    doi: input.doi,
    profileId,
    ...(input.attachTo ? { attachTo: input.attachTo } : {}),
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    commit: {
      artifactId: randomUUID(),
      filename: "paper.pdf",
    },
    roots: {
      configRoot: path.dirname(path.resolve(config.meta.userConfigPath)),
      contextId: config.context.id,
      workspaceRoot: path.resolve(config.workspace.root),
      artifactRoot: path.resolve(config.storage.artifactRoot),
      jobRoot: path.resolve(root),
    },
  };
  await atomicWrite(root, job);
  return job;
}

export async function readInstitutionalJob(root: string, id: string): Promise<InstitutionalJob | null> {
  try { return parse(JSON.parse(await readFile(target(root, id), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listInstitutionalJobs(root: string): Promise<InstitutionalJob[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs = await Promise.all(entries.filter((entry) => entry.isFile() && ID_RE.test(path.basename(entry.name, ".json")))
    .map((entry) => readInstitutionalJob(root, path.basename(entry.name, ".json"))));
  return jobs.filter((job): job is InstitutionalJob => Boolean(job)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function withInstitutionalJobLock<T>(root: string, id: string, fn: (job: InstitutionalJob, save: (next: InstitutionalJob) => Promise<void>) => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const lockPath = path.join(root, `${assertId(id)}.lock`);
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
      let stale = false;
      try {
        const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
        if (typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) {
          try { process.kill(parsed.pid, 0); }
          catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        } else {
          stale = Date.now() - (await stat(lockPath)).mtimeMs > 30_000;
        }
      } catch {
        stale = Date.now() - (await stat(lockPath)).mtimeMs > 30_000;
      }
      if (!stale) throw new Error(`Institutional job is already active: ${id}`);
      await rm(lockPath, { force: true });
    }
  }
  if (!handle) throw new Error(`Institutional job is already active: ${id}`);
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    const job = await readInstitutionalJob(root, id);
    if (!job) throw new Error(`Institutional job not found: ${id}`);
    return await fn(job, async (next) => atomicWrite(root, parse(next)));
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}
