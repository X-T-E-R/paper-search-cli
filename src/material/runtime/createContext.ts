import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { assertSafeRelativePath } from "../../runtime/safeRelativePath.js";
import { safeExternalHttpsRequest } from "../../runtime/safeExternalHttps.js";
import {
  sanitizeForPersistence,
  sanitizeUrlForPersistence,
  sanitizeUrlsForPersistenceInText,
} from "../../runtime/sanitizeUrl.js";
import {
  PYMUPDF4LLM_PROVIDER_ID,
  normalizePyMuPDF4LLMRequestOptions,
  runPyMuPDF4LLMSidecar,
  type PyMuPDF4LLMRequestOptions,
  type PyMuPDF4LLMResult,
  type RunPyMuPDF4LLMSidecarOptions,
} from "../pymupdf4llm/sidecar.js";
import type { MaterialProviderManifest } from "../types.js";

export interface MaterialHttpRequestOptions {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeout?: number;
  /** Return the response body as Base64 instead of JSON/text. */
  responseType?: "auto" | "base64";
  /** Abort a Base64 response after this many decoded bytes. */
  maxResponseBytes?: number;
}

export interface MaterialHttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface MaterialHttpTransport {
  get<T = unknown>(
    url: string,
    options?: MaterialHttpRequestOptions,
  ): Promise<MaterialHttpResponse<T>>;
  post<T = unknown>(
    url: string,
    body?: string | Record<string, unknown>,
    options?: MaterialHttpRequestOptions,
  ): Promise<MaterialHttpResponse<T>>;
}

export interface MaterialRuntimePolicy {
  name?: string;
  [key: string]: unknown;
}

export interface MaterialArchiveMarkdownOptions {
  /** Reject the decoded ZIP before parsing when it exceeds this size. */
  maxArchiveBytes: number;
  /** Reject the selected Markdown entry when it exceeds this size. */
  maxMarkdownBytes: number;
  /** Preferred ZIP entry basenames or relative paths, in priority order. */
  preferredEntryNames?: string[];
}

export interface MaterialArchiveMarkdownResult {
  markdown: string;
  entryPath: string;
  entryCount: number;
  markdownBytes: number;
}

export interface MaterialRuntimeContext {
  http: {
    get<T = unknown>(
      url: string,
      options?: MaterialHttpRequestOptions,
    ): Promise<MaterialHttpResponse<T>>;
    post<T = unknown>(
      url: string,
      body?: string | Record<string, unknown>,
      options?: MaterialHttpRequestOptions,
    ): Promise<MaterialHttpResponse<T>>;
  };
  config: {
    get<T = unknown>(key: string, defaultValue?: T): T;
    getRedacted(key: string): unknown;
    getRedacted(): Record<string, unknown>;
  };
  archive: {
    readMarkdownFromZipBase64(
      archiveBase64: string,
      options: MaterialArchiveMarkdownOptions,
    ): Promise<MaterialArchiveMarkdownResult>;
  };
  cache: {
    readText(relativePath: string): Promise<string | null>;
    writeText(relativePath: string, value: string): Promise<{ path: string }>;
    readJson<T = unknown>(relativePath: string): Promise<T | null>;
    writeJson(relativePath: string, value: unknown): Promise<{ path: string }>;
  };
  policy: {
    get(): MaterialRuntimePolicy;
    get<T = unknown>(key: string, defaultValue?: T): T;
  };
  sidecar: {
    pymupdf4llm: {
      /** Convert the one host-authorized PDF; providers cannot supply a path or process options. */
      toMarkdown(options?: PyMuPDF4LLMRequestOptions): Promise<PyMuPDF4LLMResult>;
    };
  };
  workspace: {
    writeText(relativePath: string, value: string): Promise<{ path: string }>;
    writeJson(relativePath: string, value: unknown): Promise<{ path: string }>;
  };
}

export interface CreateMaterialRuntimeContextOptions {
  manifest: MaterialProviderManifest;
  providerConfig?: Record<string, unknown>;
  /** Host environment used only for manifest-declared config fallbacks. */
  env?: NodeJS.ProcessEnv;
  policy?: MaterialRuntimePolicy;
  cacheRoot: string;
  workspaceRoot: string;
  transport?: MaterialHttpTransport;
  /** Exact local PDF selected and validated by the host extraction planner. */
  authorizedPdfPath?: string;
  /** Host-only dependency injection for focused tests. Never exposed to provider code. */
  pymupdf4llmRunner?: (
    options: RunPyMuPDF4LLMSidecarOptions,
  ) => Promise<PyMuPDF4LLMResult>;
}

export class MaterialRuntimePermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialRuntimePermissionError";
  }
}

export class MaterialRuntimePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialRuntimePathError";
  }
}

const MAX_MATERIAL_ARCHIVE_ENTRIES = 10_000;

function positiveSafeByteLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function isPaddedBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!valid) return false;
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
}

function decodeBoundedBase64Archive(value: string, maxArchiveBytes: number): Buffer {
  if (typeof value !== "string") {
    throw new TypeError("archiveBase64 must be a string");
  }
  const compact = value.replace(/\s+/gu, "");
  if (!isPaddedBase64(compact)) {
    throw new TypeError("archiveBase64 must be valid padded Base64");
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.byteLength > maxArchiveBytes) {
    throw new Error(
      `Material archive exceeds maxArchiveBytes (${decoded.byteLength} bytes > ${maxArchiveBytes} bytes)`,
    );
  }
  return decoded;
}

function markdownEntryPriority(
  entryPath: string,
  preferredEntryNames: readonly string[],
): number {
  const normalized = entryPath.toLocaleLowerCase("en-US");
  const basename = normalized.split("/").at(-1) ?? normalized;
  const preferredIndex = preferredEntryNames.findIndex((candidate) => {
    const preferred = candidate.toLocaleLowerCase("en-US");
    return normalized === preferred || basename === preferred;
  });
  if (preferredIndex >= 0) return preferredIndex;
  return preferredEntryNames.length + (/^readme(?:\.|$)/u.test(basename) ? 2 : 1);
}

async function readMarkdownFromZipBase64(
  archiveBase64: string,
  options: MaterialArchiveMarkdownOptions,
): Promise<MaterialArchiveMarkdownResult> {
  const maxArchiveBytes = positiveSafeByteLimit(
    options.maxArchiveBytes,
    "maxArchiveBytes",
  );
  const maxMarkdownBytes = positiveSafeByteLimit(
    options.maxMarkdownBytes,
    "maxMarkdownBytes",
  );
  const preferredEntryNames = (options.preferredEntryNames ?? ["full.md"]).map(
    (candidate) => assertSafeRelativePath(candidate, "preferred archive entry path"),
  );
  const archive = await JSZip.loadAsync(
    decodeBoundedBase64Archive(archiveBase64, maxArchiveBytes),
  );
  const files = Object.values(archive.files).filter((entry) => !entry.dir);
  if (files.length > MAX_MATERIAL_ARCHIVE_ENTRIES) {
    throw new Error(
      `Material archive contains too many files (${files.length} > ${MAX_MATERIAL_ARCHIVE_ENTRIES})`,
    );
  }

  const seenPaths = new Set<string>();
  const candidates = files.flatMap((entry) => {
    const entryWithOriginalName = entry as typeof entry & { unsafeOriginalName?: string };
    const entryPath = assertSafeRelativePath(
      entryWithOriginalName.unsafeOriginalName ?? entry.name,
      "material archive entry path",
    );
    const collisionKey = entryPath.toLocaleLowerCase("en-US");
    if (seenPaths.has(collisionKey)) {
      throw new Error(`Duplicate material archive entry path: ${entryPath}`);
    }
    seenPaths.add(collisionKey);
    return /\.(?:md|markdown)$/iu.test(entryPath) ? [{ entry, entryPath }] : [];
  });
  candidates.sort((left, right) => {
    const priority =
      markdownEntryPriority(left.entryPath, preferredEntryNames) -
      markdownEntryPriority(right.entryPath, preferredEntryNames);
    return priority || left.entryPath.localeCompare(right.entryPath, "en-US");
  });
  const selected = candidates[0];
  if (!selected) {
    throw new Error("Material archive does not contain a Markdown file");
  }

  const declaredBytes = (
    selected.entry as typeof selected.entry & {
      _data?: { uncompressedSize?: number };
    }
  )._data?.uncompressedSize;
  if (typeof declaredBytes === "number" && declaredBytes > maxMarkdownBytes) {
    throw new Error(
      `Material archive Markdown exceeds maxMarkdownBytes (${declaredBytes} bytes > ${maxMarkdownBytes} bytes)`,
    );
  }
  const stream = (selected.entry as typeof selected.entry & {
    internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
  }).internalStream("uint8array");
  const { markdownBytes, emittedBytes } = await new Promise<{
    markdownBytes: Buffer;
    emittedBytes: number;
  }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    stream.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxMarkdownBytes) {
        settled = true;
        const error = new Error(
          `Material archive Markdown exceeds maxMarkdownBytes (${total} bytes > ${maxMarkdownBytes} bytes)`,
        );
        stream.pause();
        reject(error);
        return;
      }
      chunks.push(bytes);
    });
    stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ markdownBytes: Buffer.concat(chunks, total), emittedBytes: total });
    });
    stream.resume();
  });
  return {
    markdown: new TextDecoder("utf-8").decode(markdownBytes),
    entryPath: selected.entryPath,
    entryCount: files.length,
    markdownBytes: emittedBytes,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesUrlPermission(url: string, pattern: string): boolean {
  const regex = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`, "i");
  return regex.test(url);
}

function assertNetworkAllowed(url: string, manifest: MaterialProviderManifest): void {
  if (!manifest.capabilities.network) {
    throw new MaterialRuntimePermissionError(
      `Network access is disabled by material provider capabilities: ${manifest.id}`,
    );
  }
  const patterns = manifest.permissions.network ?? [];
  const allowed = patterns.some((pattern) => matchesUrlPermission(url, pattern));
  if (!allowed) {
    throw new MaterialRuntimePermissionError(
      `URL not allowed by material provider permissions: ${sanitizeUrlForPersistence(url)}`,
    );
  }
}

function toSearchParams(params: Record<string, unknown>): URLSearchParams {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    searchParams.set(key, String(value));
  }
  return searchParams;
}

async function fetchJsonOrText<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }
  return (await response.text()) as T;
}

function normalizedMaxResponseBytes(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("maxResponseBytes must be a non-negative safe integer");
  }
  return value;
}

function responseSizeError(actualBytes: number, maxBytes: number): Error {
  return new Error(
    `Material HTTP response exceeds maxResponseBytes (${actualBytes} bytes > ${maxBytes} bytes)`,
  );
}

async function fetchBase64(
  response: Response,
  maxResponseBytes: number | undefined,
): Promise<string> {
  const maxBytes = normalizedMaxResponseBytes(maxResponseBytes);
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    maxBytes !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    throw responseSizeError(declaredLength, maxBytes);
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        await reader.cancel();
        throw responseSizeError(totalBytes, maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("base64");
}

async function fetchResponseData<T>(
  response: Response,
  options?: MaterialHttpRequestOptions,
): Promise<T> {
  const responseType = options?.responseType ?? "auto";
  if (responseType !== "auto" && responseType !== "base64") {
    throw new TypeError("responseType must be auto or base64");
  }
  if (responseType === "base64") {
    if (options?.maxResponseBytes === undefined) {
      throw new TypeError("Base64 material HTTP responses require maxResponseBytes");
    }
    return (await fetchBase64(response, options.maxResponseBytes)) as T;
  }
  return fetchJsonOrText<T>(response);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  manifest: MaterialProviderManifest,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return (await safeExternalHttpsRequest({
      url: input,
      init: { ...init, signal: controller.signal },
      assertAllowed: (url) => assertNetworkAllowed(url, manifest),
    })).response;
  } finally {
    clearTimeout(timer);
  }
}

function createDefaultTransport(manifest: MaterialProviderManifest): MaterialHttpTransport {
  return {
    async get<T = unknown>(
      url: string,
      options?: MaterialHttpRequestOptions,
    ): Promise<MaterialHttpResponse<T>> {
      const target = new URL(url);
      if (options?.params) {
        target.search = toSearchParams(options.params).toString();
      }
      const response = await fetchWithTimeout(
        target.toString(),
        { method: "GET", headers: options?.headers },
        options?.timeout ?? 30_000,
        manifest,
      );
      return {
        data: await fetchResponseData<T>(response, options),
        status: response.status,
        statusText: response.statusText,
        headers: headersToRecord(response.headers),
      };
    },
    async post<T = unknown>(
      url: string,
      body?: string | Record<string, unknown>,
      options?: MaterialHttpRequestOptions,
    ): Promise<MaterialHttpResponse<T>> {
      const headers = { ...(options?.headers ?? {}) };
      let payload: string | undefined;
      if (typeof body === "string") {
        payload = body;
      } else if (body !== undefined) {
        payload = JSON.stringify(body);
        if (!headers["content-type"]) {
          headers["content-type"] = "application/json";
        }
      }
      const response = await fetchWithTimeout(
        url,
        { method: "POST", headers, body: payload },
        options?.timeout ?? 30_000,
        manifest,
      );
      return {
        data: await fetchResponseData<T>(response, options),
        status: response.status,
        statusText: response.statusText,
        headers: headersToRecord(response.headers),
      };
    },
  };
}

function resolveConfigValue<T>(
  manifest: MaterialProviderManifest,
  providerConfig: Record<string, unknown>,
  key: string,
  defaultValue?: T,
): T {
  if (key in providerConfig) return providerConfig[key] as T;
  const schemaDefault = manifest.configSchema?.[key]?.default;
  if (schemaDefault !== undefined) return schemaDefault as T;
  return defaultValue as T;
}

function hasConfigValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

function resolveProviderRuntimeConfig(
  manifest: MaterialProviderManifest,
  providerConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const resolved = { ...providerConfig };
  for (const [key, field] of Object.entries(manifest.configSchema ?? {})) {
    if (hasConfigValue(providerConfig[key])) continue;
    const envName = (field.env ?? []).find((name) => hasConfigValue(env[name]));
    if (envName) resolved[key] = env[envName];
  }
  return resolved;
}

function redactValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && value.length === 0) return "";
  return "<redacted>";
}

function redactedConfig(
  manifest: MaterialProviderManifest,
  providerConfig: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.keys(manifest.configSchema ?? {}),
    ...Object.keys(providerConfig),
  ]);
  for (const key of keys) {
    const schema = manifest.configSchema?.[key];
    if (!schema) {
      result[key] = redactValue(providerConfig[key]);
      continue;
    }
    const value = resolveConfigValue(manifest, providerConfig, key);
    result[key] = schema.type === "secret" ? redactValue(value) : value;
  }
  return result;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function localWriteScope(manifest: MaterialProviderManifest): "none" | "cache" | "workspace" {
  return manifest.permissions.localWrite ?? "none";
}

function assertCacheWriteAllowed(manifest: MaterialProviderManifest): void {
  const scope = localWriteScope(manifest);
  if (scope === "cache" || scope === "workspace") return;
  throw new MaterialRuntimePermissionError(
    `Provider ${manifest.id} is not allowed to write provider cache`,
  );
}

function assertWorkspaceWriteAllowed(manifest: MaterialProviderManifest): void {
  if (localWriteScope(manifest) === "workspace") return;
  throw new MaterialRuntimePermissionError(
    `Provider ${manifest.id} is not allowed to write workspace files`,
  );
}

function assertPyMuPDF4LLMSidecarAllowed(
  manifest: MaterialProviderManifest,
  authorizedPdfPath: string | undefined,
): string {
  if (
    manifest.id !== PYMUPDF4LLM_PROVIDER_ID ||
    manifest.kind !== "extractor" ||
    manifest.capabilities.network ||
    manifest.permissions.localRead !== true ||
    !manifest.capabilities.outputs.includes("markdown") ||
    !manifest.capabilities.inputs.some((kind) => kind === "artifact" || kind === "local_file")
  ) {
    throw new MaterialRuntimePermissionError(
      `Provider ${manifest.id} is not allowed to use the PyMuPDF4LLM sidecar`,
    );
  }
  if (!authorizedPdfPath) {
    throw new MaterialRuntimePathError(
      "The selected input does not resolve to an authorized local PDF",
    );
  }
  return authorizedPdfPath;
}

function assertPathInsideRoot(rootPath: string, candidatePath: string, label: string): void {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new MaterialRuntimePathError(`${label} escapes root: ${candidatePath}`);
}

async function resolveWritablePath(root: string, relativePath: string, label: string): Promise<string> {
  if (!relativePath || relativePath.trim() === "") {
    throw new MaterialRuntimePathError(`${label} path must be non-empty`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new MaterialRuntimePathError(`${label} path must be relative`);
  }

  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, relativePath);
  assertPathInsideRoot(rootPath, targetPath, label);

  await mkdir(rootPath, { recursive: true });
  const parentPath = path.dirname(targetPath);
  await mkdir(parentPath, { recursive: true });

  const [rootRealPath, parentRealPath] = await Promise.all([
    realpath(rootPath),
    realpath(parentPath),
  ]);
  assertPathInsideRoot(rootRealPath, parentRealPath, label);

  try {
    const stat = await lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw new MaterialRuntimePathError(`${label} target must not be a symlink: ${relativePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return targetPath;
}

async function resolveReadablePath(root: string, relativePath: string, label: string): Promise<string> {
  if (!relativePath || relativePath.trim() === "") {
    throw new MaterialRuntimePathError(`${label} path must be non-empty`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new MaterialRuntimePathError(`${label} path must be relative`);
  }
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, relativePath);
  assertPathInsideRoot(rootPath, targetPath, label);
  return targetPath;
}

async function readTextIfPresent(root: string, relativePath: string, label: string): Promise<string | null> {
  const targetPath = await resolveReadablePath(root, relativePath, label);
  try {
    return await readFile(targetPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeTextInsideRoot(
  root: string,
  relativePath: string,
  value: string,
  label: string,
): Promise<{ path: string }> {
  const targetPath = await resolveWritablePath(root, relativePath, label);
  await writeFile(targetPath, value, "utf8");
  return { path: path.relative(path.resolve(root), targetPath).replace(/\\/g, "/") };
}

export function createMaterialRuntimeContext(
  options: CreateMaterialRuntimeContextOptions,
): MaterialRuntimeContext {
  const providerConfig = resolveProviderRuntimeConfig(
    options.manifest,
    options.providerConfig ?? {},
    options.env ?? process.env,
  );
  const policy = options.policy ?? {};
  const transport = options.transport ?? createDefaultTransport(options.manifest);
  const cacheRoot = path.join(path.resolve(options.cacheRoot), options.manifest.id);
  function getRedactedConfig(): Record<string, unknown>;
  function getRedactedConfig(key: string): unknown;
  function getRedactedConfig(key?: string): unknown {
    const redacted = redactedConfig(options.manifest, providerConfig);
    if (key !== undefined) return redacted[key];
    return redacted;
  }

  return {
    http: {
      async get<T = unknown>(
        url: string,
        requestOptions?: MaterialHttpRequestOptions,
      ): Promise<MaterialHttpResponse<T>> {
        const target = new URL(url);
        if (requestOptions?.params) {
          target.search = toSearchParams(requestOptions.params).toString();
        }
        assertNetworkAllowed(target.toString(), options.manifest);
        return transport.get<T>(target.toString(), {
          ...requestOptions,
          params: undefined,
        });
      },
      async post<T = unknown>(
        url: string,
        body?: string | Record<string, unknown>,
        requestOptions?: MaterialHttpRequestOptions,
      ): Promise<MaterialHttpResponse<T>> {
        const target = new URL(url);
        if (requestOptions?.params) {
          target.search = toSearchParams(requestOptions.params).toString();
        }
        assertNetworkAllowed(target.toString(), options.manifest);
        return transport.post<T>(target.toString(), body, {
          ...requestOptions,
          params: undefined,
        });
      },
    },
    config: {
      get<T = unknown>(key: string, defaultValue?: T): T {
        return resolveConfigValue(options.manifest, providerConfig, key, defaultValue);
      },
      getRedacted: getRedactedConfig,
    },
    archive: {
      readMarkdownFromZipBase64,
    },
    cache: {
      async readText(relativePath: string): Promise<string | null> {
        return readTextIfPresent(cacheRoot, relativePath, "provider cache");
      },
      async writeText(relativePath: string, value: string): Promise<{ path: string }> {
        assertCacheWriteAllowed(options.manifest);
        return writeTextInsideRoot(
          cacheRoot,
          relativePath,
          sanitizeUrlsForPersistenceInText(value),
          "provider cache",
        );
      },
      async readJson<T = unknown>(relativePath: string): Promise<T | null> {
        const raw = await readTextIfPresent(cacheRoot, relativePath, "provider cache");
        return raw === null ? null : (JSON.parse(raw) as T);
      },
      async writeJson(relativePath: string, value: unknown): Promise<{ path: string }> {
        assertCacheWriteAllowed(options.manifest);
        return writeTextInsideRoot(
          cacheRoot,
          relativePath,
          `${JSON.stringify(sanitizeForPersistence(value), null, 2)}\n`,
          "provider cache",
        );
      },
    },
    policy: {
      get<T = unknown>(key?: string, defaultValue?: T): MaterialRuntimePolicy | T {
        if (key === undefined) return cloneJson(policy);
        if (key in policy) return policy[key] as T;
        return defaultValue as T;
      },
    },
    sidecar: {
      pymupdf4llm: {
        async toMarkdown(
          requestOptions: PyMuPDF4LLMRequestOptions = {},
        ): Promise<PyMuPDF4LLMResult> {
          const authorizedPdfPath = assertPyMuPDF4LLMSidecarAllowed(
            options.manifest,
            options.authorizedPdfPath,
          );
          const normalized = normalizePyMuPDF4LLMRequestOptions(requestOptions);
          const runner = options.pymupdf4llmRunner ?? runPyMuPDF4LLMSidecar;
          return runner({
            pdfPath: authorizedPdfPath,
            ...normalized,
            env: options.env ?? process.env,
          });
        },
      },
    },
    workspace: {
      async writeText(relativePath: string, value: string): Promise<{ path: string }> {
        assertWorkspaceWriteAllowed(options.manifest);
        return writeTextInsideRoot(
          options.workspaceRoot,
          relativePath,
          sanitizeUrlsForPersistenceInText(value),
          "workspace write",
        );
      },
      async writeJson(relativePath: string, value: unknown): Promise<{ path: string }> {
        assertWorkspaceWriteAllowed(options.manifest);
        return writeTextInsideRoot(
          options.workspaceRoot,
          relativePath,
          `${JSON.stringify(sanitizeForPersistence(value), null, 2)}\n`,
          "workspace write",
        );
      },
    },
  };
}
