import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../config/schema.js";
import {
  INSTITUTIONAL_PROTOCOL_VERSION,
  INSTSCI_ADAPTER_ID,
  INSTSCI_CAPTURE_REVISION,
  assertInstitutionalRequest,
  parseInstitutionalResponse,
  type InstitutionalRunnerRequest,
  type InstitutionalRunnerResponse,
} from "./protocol.js";

const OUTPUT_LIMIT = 64 * 1024;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface InstitutionalRunner {
  run(request: InstitutionalRunnerRequest, config: ResolvedConfig): Promise<InstitutionalRunnerResponse>;
}

async function assertRegularAbsoluteFile(filePath: string, field: string): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error(`${field} must be an absolute path`);
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${field} must be a regular non-reparse file`);
  const resolved = await realpath(filePath);
  if (path.normalize(resolved).toLowerCase() !== path.normalize(filePath).toLowerCase()) {
    throw new Error(`${field} must not traverse a symlink or reparse point`);
  }
  return resolved;
}

async function assertRegularAbsoluteDirectory(directory: string, field: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error(`${field} must be an absolute path`);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${field} must be a regular non-reparse directory`);
  const resolved = await realpath(directory);
  if (path.normalize(resolved).toLowerCase() !== path.normalize(directory).toLowerCase()) {
    throw new Error(`${field} must not traverse a symlink or reparse point`);
  }
  return resolved;
}

function bundledAdapterPath(): string {
  return fileURLToPath(new URL("./instsci-adapter.py", import.meta.url));
}

function boundedAppend(current: Buffer[], total: number, chunk: Buffer): { total: number; exceeded: boolean } {
  if (total + chunk.byteLength > OUTPUT_LIMIT) return { total, exceeded: true };
  current.push(chunk);
  return { total: total + chunk.byteLength, exceeded: false };
}

export class ProcessInstitutionalRunner implements InstitutionalRunner {
  async run(request: InstitutionalRunnerRequest, config: ResolvedConfig): Promise<InstitutionalRunnerResponse> {
    assertInstitutionalRequest(request);
    const python = await assertRegularAbsoluteFile(config.institutional.pythonExecutable, "institutional.pythonExecutable");
    const checkout = await assertRegularAbsoluteDirectory(config.institutional.checkoutRoot, "institutional.checkoutRoot");
    const adapter = await assertRegularAbsoluteFile(bundledAdapterPath(), "bundled institutional adapter");
    if (request.profileId && !PROFILE_RE.test(request.profileId)) throw new Error("institution profile id is invalid");
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.PYTHONIOENCODING = "utf-8";
    env.INSTSCI_CHECKOUT_ROOT = checkout;

    return await new Promise((resolve, reject) => {
      const child = spawn(python, [adapter], { cwd: checkout, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: false });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let exceeded = false;
      const timer = setTimeout(() => child.kill(), config.institutional.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        const next = boundedAppend(stdout, stdoutBytes, chunk);
        stdoutBytes = next.total;
        exceeded ||= next.exceeded;
        if (next.exceeded) child.kill();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const next = boundedAppend(stderr, stderrBytes, chunk);
        stderrBytes = next.total;
        exceeded ||= next.exceeded;
        if (next.exceeded) child.kill();
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (exceeded) return reject(new Error("institutional sidecar output exceeded the bounded protocol limit"));
        if (signal) return reject(new Error(`institutional sidecar terminated before a protocol response (${signal})`));
        if (code !== 0) return reject(new Error(`institutional sidecar exited without a valid response (exit ${code ?? "unknown"})`));
        try {
          const text = Buffer.concat(stdout).toString("utf8").trim();
          if (!text || text.includes("\n")) throw new Error("institutional sidecar must emit one JSON response");
          resolve(parseInstitutionalResponse(JSON.parse(text), request));
        } catch (error) { reject(error); }
      });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }
}

export function createInstitutionalRequest(
  operation: "probe" | "acquire",
  input: { doi?: string; profileId?: string; handoffRoot?: string; maxPdfBytes?: number } = {},
): InstitutionalRunnerRequest {
  return {
    protocolVersion: INSTITUTIONAL_PROTOCOL_VERSION,
    requestId: randomUUID(),
    operation,
    adapter: { id: INSTSCI_ADAPTER_ID, revision: INSTSCI_CAPTURE_REVISION },
    ...input,
  };
}

export async function verifyInstitutionalHandoff(options: {
  root: string;
  response: InstitutionalRunnerResponse;
  maxPdfBytes: number;
}): Promise<Buffer> {
  if (!options.response.handoff) throw new Error("institutional response has no acquired handoff");
  const root = await assertRegularAbsoluteDirectory(options.root, "attempt handoff root");
  const relative = options.response.handoff.relativePath;
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("institutional handoff path must be a contained relative path");
  }
  const target = path.resolve(root, ...relative.split(/[\\/]/u));
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("institutional handoff escaped its attempt root");
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("institutional handoff must be a regular non-reparse file");
  const actual = await realpath(target);
  if (path.relative(root, actual).startsWith("..") || path.normalize(actual).toLowerCase() !== path.normalize(target).toLowerCase()) {
    throw new Error("institutional handoff traversed a symlink or reparse point");
  }
  if (stat.size !== options.response.handoff.sizeBytes) throw new Error("institutional handoff size does not match the protocol response");
  if (stat.size > options.maxPdfBytes) throw new Error("institutional handoff exceeds the configured PDF limit");
  const bytes = await readFile(target);
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("institutional handoff is not a PDF");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== options.response.handoff.sha256) throw new Error("institutional handoff SHA-256 mismatch");
  return bytes;
}
