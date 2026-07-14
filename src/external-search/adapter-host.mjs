#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const STDOUT_LIMIT = 4 * 1024 * 1024;
const STDERR_LIMIT = 1 * 1024 * 1024;
const REQUEST_LIMIT = 1 * 1024 * 1024;
const SECRET_ASSIGNMENT_RE = /\b(api[-_]?key|authorization|password|secret|token)\b(\s*[:=]\s*)([^\s,;]+)/giu;
const BEARER_RE = /\bbearer\s+[^\s,;]+/giu;
const SECRET_QUERY_RE = /([?&](?:api[-_]?key|authorization|password|secret|token)=)[^&#\s]+/giu;

function diagnostic(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT_RE, "$1$2[redacted]")
    .replace(SECRET_QUERY_RE, "$1[redacted]")
    .slice(0, 2000)
    .trim();
}

function terminate(child) {
  if (!child.pid) return undefined;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      shell: false, windowsHide: true, stdio: "ignore",
    });
    killer.once("error", () => child.kill());
    killer.once("close", (code) => { if (code !== 0) child.kill(); });
    killer.unref();
    return undefined;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  const force = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, 1000);
  force.unref();
  return force;
}

function readRequest() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    process.stdin.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > REQUEST_LIMIT) reject(new Error("adapter host request exceeded its input limit"));
      else chunks.push(Buffer.from(chunk));
    });
    process.stdin.once("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    process.stdin.once("error", reject);
  });
}

function invokeExecutable(input, signal) {
  const remaining = input.deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("external search adapter deadline expired"));
  const extraArgs = Array.isArray(input.args) && input.args.every((value) => typeof value === "string") ? input.args : [];
  const stdin = typeof input.stdin === "string" ? input.stdin : "";
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(input.process.executable, [...input.process.args, ...extraArgs], {
      cwd: input.process.workingDirectory,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    let errBytes = 0;
    let failure = null;
    let terminationForce;
    const fail = (error) => { if (!failure) { failure = error; terminationForce = terminate(child); } };
    const timer = setTimeout(() => fail(new Error("configured executable timed out")), remaining);
    const abort = () => fail(new Error("configured executable cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > STDOUT_LIMIT) fail(new Error("configured executable stdout limit exceeded"));
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      errBytes += chunk.length;
      if (errBytes > STDERR_LIMIT) fail(new Error("configured executable stderr limit exceeded"));
      else stderr.push(Buffer.from(chunk));
    });
    child.once("error", fail);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (terminationForce) clearTimeout(terminationForce);
      signal.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: diagnostic(Buffer.concat(stderr).toString("utf8")),
        durationMs: Date.now() - started,
      });
    });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") fail(error); });
    child.stdin.end(stdin);
  });
}

function failure(request, code, error) {
  return {
    protocol: request.protocol,
    version: request.version,
    requestId: request.requestId,
    operation: request.operation,
    ok: false,
    status: "failed",
    error: { code, message: diagnostic(error instanceof Error ? error.message : error), retryable: false },
    warnings: [],
  };
}

async function main() {
  const input = await readRequest();
  const request = input.request;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    if (!input.adapterPath || !input.adapterName || !request || !input.process) throw new Error("invalid adapter host request");
    const module = await import(pathToFileURL(input.adapterPath).href);
    const manifest = module.manifest;
    if (!manifest || manifest.moduleAbiVersion !== 1 || manifest.id !== input.adapterName || typeof manifest.version !== "string" || !manifest.version.trim()) {
      throw new Error("adapter manifest is invalid or does not match the configured adapter name");
    }
    if (typeof module.handle !== "function") throw new Error("adapter must export handle(request, context)");
    const context = {
      signal: controller.signal,
      deadline: input.deadline,
      execFile: (options = {}) => invokeExecutable({ ...options, process: input.process, deadline: input.deadline }, controller.signal),
      log: (message) => process.stderr.write(`${diagnostic(message)}\n`),
    };
    const payload = await module.handle(request, context);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("adapter handle must return an object");
    const response = {
      protocol: request.protocol,
      version: request.version,
      requestId: request.requestId,
      operation: request.operation,
      ok: payload.ok ?? payload.status !== "failed",
      status: payload.status,
      ...(payload.data !== undefined ? { data: payload.data } : {}),
      ...(payload.provenance !== undefined ? { provenance: payload.provenance } : {}),
      ...(payload.error !== undefined ? { error: payload.error } : {}),
      warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    };
    process.stdout.write(JSON.stringify(response));
  } catch (error) {
    process.stdout.write(JSON.stringify(failure(request, "adapter_invalid", error)));
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
