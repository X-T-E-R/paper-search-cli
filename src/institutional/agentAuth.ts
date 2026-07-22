import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig, UserConfig } from "../config/schema.js";
import { InstitutionalProfileIdSchema } from "../config/schema.js";
import { applyCredentialPermissions } from "../config/permissions.js";
import {
  atomicWriteConfigFile,
  readUserConfigFile,
  writeUserConfigFile,
} from "../config/userConfig.js";
import { withLocks } from "../runtime/locks.js";
import {
  institutionalJobRoot,
  withInstitutionalJobLock,
  type InstitutionalJob,
} from "./jobStore.js";

export type InstitutionalAgentMode = "ask" | "allow" | "off";
export type InstitutionalAgentGrantStatus = "active" | "consumed" | "revoked" | "expired";

export interface InstitutionalAgentGrant {
  schemaVersion: 1;
  id: string;
  status: InstitutionalAgentGrantStatus;
  jobId: string;
  profileId: string;
  contextDigest: string;
  attemptNumber: number;
  issuedAt: string;
  expiresAt: string;
  updatedAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

const UUID_RE = /^[0-9a-f-]{36}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;

function configRoot(config: ResolvedConfig): string {
  return path.dirname(path.resolve(config.meta.userConfigPath));
}

export function institutionalAgentGrantRoot(config: ResolvedConfig): string {
  return path.join(configRoot(config), "state", "institutional", "agent-grants");
}

function grantPath(config: ResolvedConfig, id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`Invalid institutional agent grant id: ${id}`);
  return path.join(institutionalAgentGrantRoot(config), `${id}.json`);
}

function lockOptions(config: ResolvedConfig, command: string) {
  return {
    command,
    lockRoot: path.join(configRoot(config), "state", "locks"),
  };
}

function parseGrant(value: unknown): InstitutionalAgentGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("institutional agent grant must be an object");
  const grant = value as InstitutionalAgentGrant;
  const allowed = new Set([
    "schemaVersion", "id", "status", "jobId", "profileId", "contextDigest", "attemptNumber",
    "issuedAt", "expiresAt", "updatedAt", "consumedAt", "revokedAt",
  ]);
  if (Object.keys(value as Record<string, unknown>).some((key) => !allowed.has(key)) ||
      grant.schemaVersion !== 1 || !UUID_RE.test(grant.id) || !UUID_RE.test(grant.jobId) ||
      !["active", "consumed", "revoked", "expired"].includes(grant.status) ||
      !InstitutionalProfileIdSchema.safeParse(grant.profileId).success || !SHA256_RE.test(grant.contextDigest) ||
      !Number.isSafeInteger(grant.attemptNumber) || grant.attemptNumber < 1 ||
      [grant.issuedAt, grant.expiresAt, grant.updatedAt].some((entry) => typeof entry !== "string" || !Number.isFinite(Date.parse(entry)))) {
    throw new Error("institutional agent grant is invalid");
  }
  if ((grant.consumedAt !== undefined && typeof grant.consumedAt !== "string") ||
      (grant.revokedAt !== undefined && typeof grant.revokedAt !== "string")) {
    throw new Error("institutional agent grant terminal timestamps are invalid");
  }
  if ((grant.status === "consumed") !== Boolean(grant.consumedAt) ||
      (grant.status === "revoked") !== Boolean(grant.revokedAt) ||
      Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
    throw new Error("institutional agent grant lifecycle is invalid");
  }
  return grant;
}

async function readGrant(config: ResolvedConfig, id: string): Promise<InstitutionalAgentGrant | null> {
  try {
    return parseGrant(JSON.parse(await readFile(grantPath(config, id), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeGrant(config: ResolvedConfig, grant: InstitutionalAgentGrant): Promise<void> {
  const filePath = grantPath(config, grant.id);
  await atomicWriteConfigFile(filePath, `${JSON.stringify(parseGrant(grant), null, 2)}\n`, 0o600);
  const permissions = await applyCredentialPermissions(filePath);
  if (!permissions.restricted || !permissions.verified) {
    await rm(filePath, { force: true }).catch(() => undefined);
    throw new Error("Institutional agent grant could not be persisted with private file permissions.");
  }
}

function contextFacts(config: ResolvedConfig, job: InstitutionalJob): string[] {
  return [
    job.id,
    path.dirname(path.resolve(config.meta.userConfigPath)),
    config.context.id,
    path.resolve(config.workspace.root),
    path.resolve(config.storage.artifactRoot),
    path.resolve(institutionalJobRoot(config)),
  ];
}

export function institutionalAgentContextDigest(config: ResolvedConfig, job: InstitutionalJob): string {
  const current = contextFacts(config, job);
  const captured = [job.id, job.roots.configRoot, job.roots.contextId, job.roots.workspaceRoot, job.roots.artifactRoot, job.roots.jobRoot];
  if (current.some((value, index) => value !== captured[index])) {
    throw new Error("Institutional job context drift prevents agent authorization.");
  }
  return createHash("sha256").update(JSON.stringify(captured), "utf8").digest("hex");
}

export function showInstitutionalAgentPolicy(config: ResolvedConfig): {
  mode: InstitutionalAgentMode;
  allowedProfiles: string[];
} {
  return {
    mode: config.institutional.agentControl.mode,
    allowedProfiles: [...config.institutional.agentControl.allowedProfiles],
  };
}

export async function setInstitutionalAgentPolicy(options: {
  config: ResolvedConfig;
  mode: InstitutionalAgentMode;
  profileId?: string;
}): Promise<{ mode: InstitutionalAgentMode; allowedProfiles: string[] }> {
  if (options.mode === "allow" && !options.profileId) {
    throw new Error("Agent policy allow requires an explicit --profile allowlist entry.");
  }
  if (options.mode !== "allow" && options.profileId) {
    throw new Error("--profile is valid only when setting agent policy to allow.");
  }
  const profileId = options.profileId ? InstitutionalProfileIdSchema.parse(options.profileId) : undefined;
  const file = await readUserConfigFile(options.config.meta.userConfigPath);
  const currentProfiles = file.data.institutional?.agentControl?.allowedProfiles ?? [];
  const allowedProfiles = options.mode === "allow"
    ? [...new Set([...currentProfiles, profileId!])].sort()
    : [];
  const next: UserConfig = {
    ...file.data,
    institutional: {
      ...file.data.institutional,
      agentControl: { mode: options.mode, allowedProfiles },
    },
  };
  await writeUserConfigFile(next, file.path, { expectedDigest: file.digest });
  return { mode: options.mode, allowedProfiles };
}

export async function issueInstitutionalAgentGrant(options: {
  config: ResolvedConfig;
  jobId: string;
  ttlSeconds?: number;
  now?: Date;
}): Promise<InstitutionalAgentGrant> {
  if (options.config.institutional.agentControl.mode === "off") {
    throw new Error("Institutional agent-assisted continuation is disabled by user policy.");
  }
  if (options.config.institutional.agentControl.mode !== "ask") {
    throw new Error("One-attempt grants are issued only while institutional agent policy is ask.");
  }
  const ttlSeconds = options.ttlSeconds ?? 600;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3_600) {
    throw new Error("Institutional agent grant TTL must be an integer from 1 to 3600 seconds.");
  }
  const now = options.now ?? new Date();
  return withInstitutionalJobLock(institutionalJobRoot(options.config), options.jobId, async (job) => {
    if (["acquired", "not_entitled", "unsupported", "canceled"].includes(job.status)) {
      throw new Error(`Institutional job cannot receive a grant from terminal status ${job.status}.`);
    }
    const issuedAt = now.toISOString();
    const grant: InstitutionalAgentGrant = {
      schemaVersion: 1,
      id: randomUUID(),
      status: "active",
      jobId: job.id,
      profileId: job.profileId,
      contextDigest: institutionalAgentContextDigest(options.config, job),
      attemptNumber: job.attemptCount + 1,
      issuedAt,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
      updatedAt: issuedAt,
    };
    await writeGrant(options.config, grant);
    return grant;
  });
}

export async function consumeInstitutionalAgentGrant(options: {
  config: ResolvedConfig;
  grantId: string;
  job: InstitutionalJob;
  attemptNumber: number;
  now?: Date;
}): Promise<InstitutionalAgentGrant> {
  return withLocks([`institutional-agent-grant/${options.grantId}`], async () => {
    const grant = await readGrant(options.config, options.grantId);
    if (!grant) throw new Error(`Institutional agent grant not found: ${options.grantId}`);
    const now = options.now ?? new Date();
    if (grant.status === "active" && Date.parse(grant.expiresAt) <= now.getTime()) {
      const expired: InstitutionalAgentGrant = { ...grant, status: "expired", updatedAt: now.toISOString() };
      await writeGrant(options.config, expired);
      throw new Error("Institutional agent grant has expired.");
    }
    if (grant.status !== "active") throw new Error(`Institutional agent grant is ${grant.status} and cannot be replayed.`);
    if (grant.jobId !== options.job.id || grant.profileId !== options.job.profileId ||
        grant.contextDigest !== institutionalAgentContextDigest(options.config, options.job) ||
        grant.attemptNumber !== options.attemptNumber) {
      throw new Error("Institutional agent grant does not match this job, profile, context, and attempt.");
    }
    const consumed: InstitutionalAgentGrant = {
      ...grant,
      status: "consumed",
      updatedAt: now.toISOString(),
      consumedAt: now.toISOString(),
    };
    await writeGrant(options.config, consumed);
    return consumed;
  }, lockOptions(options.config, "institutional agent grant consume"));
}

export async function revokeInstitutionalAgentGrants(options: {
  config: ResolvedConfig;
  grantId?: string;
  all?: boolean;
  now?: Date;
}): Promise<{ revoked: string[] }> {
  if ((options.grantId ? 1 : 0) + (options.all ? 1 : 0) !== 1) {
    throw new Error("Specify exactly one institutional agent grant id or --all.");
  }
  const ids = options.grantId
    ? [options.grantId]
    : (await readdir(institutionalAgentGrantRoot(options.config)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }))
      .filter((name) => name.endsWith(".json") && UUID_RE.test(path.basename(name, ".json")))
      .map((name) => path.basename(name, ".json"));
  const revoked: string[] = [];
  for (const id of ids) {
    await withLocks([`institutional-agent-grant/${id}`], async () => {
      const grant = await readGrant(options.config, id);
      if (!grant) {
        if (options.grantId) throw new Error(`Institutional agent grant not found: ${id}`);
        return;
      }
      if (grant.status !== "active") return;
      const now = options.now ?? new Date();
      if (Date.parse(grant.expiresAt) <= now.getTime()) {
        await writeGrant(options.config, { ...grant, status: "expired", updatedAt: now.toISOString() });
        return;
      }
      await writeGrant(options.config, {
        ...grant,
        status: "revoked",
        updatedAt: now.toISOString(),
        revokedAt: now.toISOString(),
      });
      revoked.push(id);
    }, lockOptions(options.config, "institutional agent grant revoke"));
  }
  return { revoked };
}

export async function readInstitutionalAgentGrantForTest(
  config: ResolvedConfig,
  id: string,
): Promise<InstitutionalAgentGrant | null> {
  return readGrant(config, id);
}
