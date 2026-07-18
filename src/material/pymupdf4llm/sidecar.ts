import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaperSearchHome } from "../../config/home.js";

export const PYMUPDF4LLM_VERSION = "0.3.4";
export const PYMUPDF_VERSION = "1.27.2.3";
export const PYMUPDF4LLM_LICENSE =
  "Dual Licensed - GNU AFFERO GPL 3.0 or Artifex Commercial License";
export const PYMUPDF4LLM_PROVIDER_ID = "local-pymupdf4llm";
export const PYMUPDF4LLM_DEFAULT_TIMEOUT_MS = 300_000;
export const PYMUPDF4LLM_MAX_TIMEOUT_MS = 600_000;

const REQUEST_LIMIT = 64 * 1024;
const STDOUT_LIMIT = 16 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

export type PyMuPDF4LLMSidecarErrorCode =
  | "DEPENDENCY_MISSING"
  | "SIDECAR_UNAVAILABLE"
  | "INVALID_PDF"
  | "ENCRYPTED_PDF"
  | "OCR_UNAVAILABLE"
  | "EMPTY_MARKDOWN"
  | "PARSER_TIMEOUT"
  | "SIDECAR_OUTPUT_LIMIT"
  | "SIDECAR_PROTOCOL_ERROR"
  | "EXTRACTION_FAILED";

export interface PyMuPDF4LLMWarning {
  code: string;
  message: string;
}

export interface PyMuPDF4LLMMetadata {
  parser: {
    name: "pymupdf4llm";
    version: string;
    pymupdfVersion: string;
    mode: "official-legacy-markdown";
    license: string;
  };
  pageCount: number;
  ocr: false;
  images: "disabled";
  tableStrategy: "lines_strict";
  warnings: PyMuPDF4LLMWarning[];
  elapsedMs: number;
}

export interface PyMuPDF4LLMResult {
  markdown: string;
  metadata: PyMuPDF4LLMMetadata;
}

export interface PyMuPDF4LLMRequestOptions {
  ocr?: boolean;
  timeoutMs?: number;
}

export interface RunPyMuPDF4LLMSidecarOptions extends PyMuPDF4LLMRequestOptions {
  pdfPath: string;
  env?: NodeJS.ProcessEnv;
  hostPaths?: PyMuPDF4LLMHostPaths;
}

export interface PyMuPDF4LLMHostPaths {
  runtimeRoot: string;
  pythonExecutable: string;
  adapterPath: string;
  requirementsPath: string;
  tempRoot: string;
}

interface SidecarSuccess {
  protocol: "paper-search.pymupdf4llm";
  version: 1;
  ok: true;
  markdown: string;
  metadata: PyMuPDF4LLMMetadata;
}

interface SidecarFailure {
  protocol: "paper-search.pymupdf4llm";
  version: 1;
  ok: false;
  error: {
    code: PyMuPDF4LLMSidecarErrorCode;
    message: string;
  };
}

type SidecarResponse = SidecarSuccess | SidecarFailure;

export class PyMuPDF4LLMSidecarError extends Error {
  constructor(
    readonly code: PyMuPDF4LLMSidecarErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PyMuPDF4LLMSidecarError";
  }
}

function packagedFile(name: string): string {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

export function resolvePyMuPDF4LLMHostPaths(
  env: NodeJS.ProcessEnv = process.env,
): PyMuPDF4LLMHostPaths {
  const runtimeRoot = path.join(
    resolvePaperSearchHome(env),
    "runtimes",
    "pymupdf4llm",
    PYMUPDF4LLM_VERSION,
  );
  const pythonExecutable = process.platform === "win32"
    ? path.join(runtimeRoot, "python", "Scripts", "python.exe")
    : path.join(runtimeRoot, "python", "bin", "python");
  return {
    runtimeRoot,
    pythonExecutable,
    adapterPath: packagedFile("pymupdf4llm-adapter.py"),
    requirementsPath: packagedFile("requirements.lock.txt"),
    tempRoot: path.join(runtimeRoot, "tmp"),
  };
}

function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new PyMuPDF4LLMSidecarError(
    "SIDECAR_UNAVAILABLE",
    `${label} is outside the managed PyMuPDF4LLM runtime`,
  );
}

async function assertFixedHostFile(options: {
  filePath: string;
  root?: string;
  missingCode: PyMuPDF4LLMSidecarErrorCode;
  missingMessage: string;
  label: string;
}): Promise<string> {
  let info;
  try {
    info = await lstat(options.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PyMuPDF4LLMSidecarError(options.missingCode, options.missingMessage);
    }
    throw new PyMuPDF4LLMSidecarError(
      options.missingCode,
      `${options.label} could not be inspected`,
    );
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new PyMuPDF4LLMSidecarError(
      options.missingCode,
      `${options.label} must be a regular non-symlink file`,
    );
  }
  const resolved = await realpath(options.filePath);
  if (options.root) {
    const rootReal = await realpath(options.root).catch(() => path.resolve(options.root!));
    assertInside(rootReal, resolved, options.label);
  }
  return resolved;
}

async function validatePdfPath(pdfPath: string): Promise<string> {
  if (!path.isAbsolute(pdfPath)) {
    throw new PyMuPDF4LLMSidecarError("INVALID_PDF", "The authorized PDF path is invalid");
  }
  let info;
  try {
    info = await lstat(pdfPath);
  } catch {
    throw new PyMuPDF4LLMSidecarError("INVALID_PDF", "The authorized PDF is unavailable");
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new PyMuPDF4LLMSidecarError(
      "INVALID_PDF",
      "The authorized PDF must be a regular non-symlink file",
    );
  }
  const resolved = await realpath(pdfPath);
  const handle = await open(resolved, "r");
  const signatureBytes = Buffer.alloc(5);
  try {
    await handle.read(signatureBytes, 0, signatureBytes.byteLength, 0);
  } finally {
    await handle.close();
  }
  const signature = signatureBytes.toString("ascii");
  if (signature !== "%PDF-") {
    throw new PyMuPDF4LLMSidecarError("INVALID_PDF", "The authorized file is not a PDF");
  }
  return resolved;
}

export function normalizePyMuPDF4LLMRequestOptions(
  value: PyMuPDF4LLMRequestOptions = {},
): Required<PyMuPDF4LLMRequestOptions> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("PyMuPDF4LLM options must be an object");
  }
  const unknown = Object.keys(value).filter((key) => key !== "ocr" && key !== "timeoutMs");
  if (unknown.length > 0) {
    throw new TypeError(`Unsupported PyMuPDF4LLM option: ${unknown.join(", ")}`);
  }
  const ocr = value.ocr ?? false;
  if (typeof ocr !== "boolean") throw new TypeError("PyMuPDF4LLM ocr must be a boolean");
  const timeoutMs = value.timeoutMs ?? PYMUPDF4LLM_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > PYMUPDF4LLM_MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      `PyMuPDF4LLM timeoutMs must be an integer from 1000 to ${PYMUPDF4LLM_MAX_TIMEOUT_MS}`,
    );
  }
  return { ocr, timeoutMs };
}

function sidecarEnvironment(
  env: NodeJS.ProcessEnv,
  tempRoot: string,
): NodeJS.ProcessEnv {
  // Windows can repopulate omitted user variables for a child process. Pass
  // their names with empty values, then set only the small runtime allowlist.
  const result: NodeJS.ProcessEnv = Object.fromEntries(
    Object.keys(env).map((key) => [key, ""]),
  );
  const setValue = (key: string, value: string): void => {
    for (const candidate of Object.keys(result)) {
      if (candidate.toLocaleUpperCase("en-US") === key) delete result[candidate];
    }
    result[key] = value;
  };
  const fixed: Record<string, string> = {
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    PYTHONNOUSERSITE: "1",
    PIP_NO_INDEX: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    TEMP: tempRoot,
    TMP: tempRoot,
  };
  for (const [key, value] of Object.entries(fixed)) setValue(key, value);
  for (const key of ["SYSTEMROOT", "WINDIR"] as const) {
    if (env[key]) setValue(key, env[key]);
  }
  return result;
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

function parseSidecarResponse(raw: string): SidecarResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PyMuPDF4LLMSidecarError(
      "SIDECAR_PROTOCOL_ERROR",
      "The local parser returned invalid JSON",
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { protocol?: unknown }).protocol !== "paper-search.pymupdf4llm" ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { ok?: unknown }).ok !== "boolean"
  ) {
    throw new PyMuPDF4LLMSidecarError(
      "SIDECAR_PROTOCOL_ERROR",
      "The local parser returned an incompatible response",
    );
  }
  return value as SidecarResponse;
}

export async function runPyMuPDF4LLMSidecar(
  options: RunPyMuPDF4LLMSidecarOptions,
): Promise<PyMuPDF4LLMResult> {
  const requestOptions = normalizePyMuPDF4LLMRequestOptions({
    ocr: options.ocr,
    timeoutMs: options.timeoutMs,
  });
  const env = options.env ?? process.env;
  const hostPaths = options.hostPaths ?? resolvePyMuPDF4LLMHostPaths(env);
  const pdfPath = await validatePdfPath(options.pdfPath);
  const pythonExecutable = await assertFixedHostFile({
    filePath: hostPaths.pythonExecutable,
    root: hostPaths.runtimeRoot,
    missingCode: "DEPENDENCY_MISSING",
    missingMessage:
      "The pinned local PyMuPDF4LLM runtime is not installed; run `paper-search material setup-local-pymupdf4llm --apply --python <absolute-python-3.11-path>`",
    label: "Pinned Python executable",
  });
  const adapterPath = await assertFixedHostFile({
    filePath: hostPaths.adapterPath,
    missingCode: "SIDECAR_UNAVAILABLE",
    missingMessage: "The packaged PyMuPDF4LLM adapter is unavailable; rebuild or reinstall Paper Search",
    label: "Packaged PyMuPDF4LLM adapter",
  });
  await mkdir(hostPaths.tempRoot, { recursive: true });

  const request = JSON.stringify({
    protocol: "paper-search.pymupdf4llm",
    version: 1,
    operation: "to_markdown",
    input: {
      path: pdfPath,
      ocr: requestOptions.ocr,
    },
  });
  if (Buffer.byteLength(request, "utf8") > REQUEST_LIMIT) {
    throw new PyMuPDF4LLMSidecarError(
      "SIDECAR_PROTOCOL_ERROR",
      "The local parser request exceeds its size limit",
    );
  }

  return new Promise<PyMuPDF4LLMResult>((resolve, reject) => {
    const child = spawn(pythonExecutable, [adapterPath], {
      cwd: hostPaths.runtimeRoot,
      env: sidecarEnvironment(env, hostPaths.tempRoot),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: PyMuPDF4LLMSidecarError | null = null;
    let forceTimer: NodeJS.Timeout | undefined;

    const fail = (error: PyMuPDF4LLMSidecarError): void => {
      if (failure) return;
      failure = error;
      forceTimer = terminateProcessTree(child);
    };
    const timeout = setTimeout(() => {
      fail(new PyMuPDF4LLMSidecarError(
        "PARSER_TIMEOUT",
        `The local PDF parser exceeded its ${requestOptions.timeoutMs} ms deadline`,
      ));
    }, requestOptions.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > STDOUT_LIMIT) {
        fail(new PyMuPDF4LLMSidecarError(
          "SIDECAR_OUTPUT_LIMIT",
          `The local parser output exceeded ${STDOUT_LIMIT} bytes`,
        ));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > STDERR_LIMIT) {
        fail(new PyMuPDF4LLMSidecarError(
          "SIDECAR_OUTPUT_LIMIT",
          `The local parser diagnostics exceeded ${STDERR_LIMIT} bytes`,
        ));
        return;
      }
      stderr.push(Buffer.from(chunk));
    });
    child.once("error", () => {
      fail(new PyMuPDF4LLMSidecarError(
        "DEPENDENCY_MISSING",
        "The pinned local PyMuPDF4LLM runtime could not be started",
      ));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new PyMuPDF4LLMSidecarError(
          "EXTRACTION_FAILED",
          "The local PDF parser stopped before returning a result",
        ));
        return;
      }
      try {
        const response = parseSidecarResponse(Buffer.concat(stdout).toString("utf8"));
        if (!response.ok) {
          reject(new PyMuPDF4LLMSidecarError(response.error.code, response.error.message));
          return;
        }
        if (typeof response.markdown !== "string" || response.markdown.trim().length === 0) {
          reject(new PyMuPDF4LLMSidecarError(
            "EMPTY_MARKDOWN",
            "PyMuPDF4LLM returned no usable Markdown",
          ));
          return;
        }
        resolve({ markdown: response.markdown, metadata: response.metadata });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin?.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        fail(new PyMuPDF4LLMSidecarError(
          "SIDECAR_PROTOCOL_ERROR",
          "The local parser request could not be written",
        ));
      }
    });
    child.stdin?.end(request, "utf8");
  });
}
