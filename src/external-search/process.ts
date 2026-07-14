import { spawn, type ChildProcess } from "node:child_process";
import { ExternalSearchError } from "./errors.js";

export const EXTERNAL_SEARCH_STDIN_LIMIT = 1 * 1024 * 1024;
export const EXTERNAL_SEARCH_STDOUT_LIMIT = 4 * 1024 * 1024;
export const EXTERNAL_SEARCH_STDERR_LIMIT = 1 * 1024 * 1024;

export interface BoundedProcessOptions {
  executable: string;
  args?: readonly string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  stdoutLimit?: number;
  stderrLimit?: number;
}

export interface BoundedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const SECRET_ASSIGNMENT_RE = /\b(api[-_]?key|authorization|password|secret|token)\b(\s*[:=]\s*)([^\s,;]+)/giu;
const BEARER_RE = /\bbearer\s+[^\s,;]+/giu;
const SECRET_QUERY_RE = /([?&](?:api[-_]?key|authorization|password|secret|token)=)[^&#\s]+/giu;

function diagnostic(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT_RE, "$1$2[redacted]")
    .replace(SECRET_QUERY_RE, "$1[redacted]")
    .trim();
  return normalized.length > 2_000 ? `${normalized.slice(0, 2_000)}…` : normalized;
}

function terminateProcessTree(child: ChildProcess): NodeJS.Timeout | undefined {
  const pid = child.pid;
  if (!pid) return undefined;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill());
    killer.once("close", (code) => {
      if (code !== 0) child.kill();
    });
    killer.unref();
    return undefined;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 1_000);
  force.unref();
  return force;
}

export async function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  const stdin = Buffer.from(options.stdin, "utf8");
  if (stdin.byteLength > EXTERNAL_SEARCH_STDIN_LIMIT) {
    throw new ExternalSearchError("process_output_limit", `External search request exceeds ${EXTERNAL_SEARCH_STDIN_LIMIT} bytes`);
  }
  if (options.signal?.aborted) {
    throw new ExternalSearchError("process_cancelled", "External search was cancelled before process start", { retryable: true });
  }

  const stdoutLimit = options.stdoutLimit ?? EXTERNAL_SEARCH_STDOUT_LIMIT;
  const stderrLimit = options.stderrLimit ?? EXTERNAL_SEARCH_STDERR_LIMIT;
  const started = Date.now();

  return new Promise<BoundedProcessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.executable, [...(options.args ?? [])], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new ExternalSearchError("process_spawn_failed", "External search process could not be started", { cause: error }));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ExternalSearchError | null = null;
    let settled = false;
    let terminationForce: NodeJS.Timeout | undefined;

    const failAndTerminate = (error: ExternalSearchError): void => {
      if (failure) return;
      failure = error;
      terminationForce = terminateProcessTree(child);
    };

    const timeout = setTimeout(() => {
      failAndTerminate(new ExternalSearchError(
        "process_timeout",
        `External search exceeded the ${options.timeoutMs} ms deadline`,
        { retryable: true },
      ));
    }, options.timeoutMs);

    const onAbort = (): void => {
      failAndTerminate(new ExternalSearchError("process_cancelled", "External search was cancelled", { retryable: true }));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > stdoutLimit) {
        failAndTerminate(new ExternalSearchError("process_output_limit", `External search stdout exceeded ${stdoutLimit} bytes`));
        return;
      }
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > stderrLimit) {
        failAndTerminate(new ExternalSearchError("process_output_limit", `External search stderr exceeded ${stderrLimit} bytes`));
        return;
      }
      stderrChunks.push(Buffer.from(chunk));
    });

    child.once("error", (error) => {
      failAndTerminate(new ExternalSearchError("process_spawn_failed", "External search process could not be started", { cause: error }));
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationForce) clearTimeout(terminationForce);
      options.signal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new ExternalSearchError(
          "process_nonzero_exit",
          `External search process exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${diagnostic(stderr)}` : ""}`,
          { details: { exitCode: code } },
        ));
        return;
      }
      resolve({
        exitCode: 0,
        stdout,
        stderr: diagnostic(stderr),
        durationMs: Date.now() - started,
      });
    });

    child.stdin?.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        failAndTerminate(new ExternalSearchError("process_spawn_failed", "Failed to write the external search request", { cause: error }));
      }
    });
    child.stdin?.end(stdin);
  });
}
