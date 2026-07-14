import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MaterialProviderManifest } from "../types.js";

export interface MaterialHttpRequestOptions {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeout?: number;
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
  workspace: {
    writeText(relativePath: string, value: string): Promise<{ path: string }>;
    writeJson(relativePath: string, value: unknown): Promise<{ path: string }>;
  };
}

export interface CreateMaterialRuntimeContextOptions {
  manifest: MaterialProviderManifest;
  providerConfig?: Record<string, unknown>;
  policy?: MaterialRuntimePolicy;
  cacheRoot: string;
  workspaceRoot: string;
  transport?: MaterialHttpTransport;
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
      `URL not allowed by material provider permissions: ${url}`,
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
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function createDefaultTransport(): MaterialHttpTransport {
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
      );
      return {
        data: await fetchJsonOrText<T>(response),
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
      );
      return {
        data: await fetchJsonOrText<T>(response),
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
  const providerConfig = options.providerConfig ?? {};
  const policy = options.policy ?? {};
  const transport = options.transport ?? createDefaultTransport();
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
    cache: {
      async readText(relativePath: string): Promise<string | null> {
        return readTextIfPresent(cacheRoot, relativePath, "provider cache");
      },
      async writeText(relativePath: string, value: string): Promise<{ path: string }> {
        assertCacheWriteAllowed(options.manifest);
        return writeTextInsideRoot(cacheRoot, relativePath, value, "provider cache");
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
          `${JSON.stringify(value, null, 2)}\n`,
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
    workspace: {
      async writeText(relativePath: string, value: string): Promise<{ path: string }> {
        assertWorkspaceWriteAllowed(options.manifest);
        return writeTextInsideRoot(
          options.workspaceRoot,
          relativePath,
          value,
          "workspace write",
        );
      },
      async writeJson(relativePath: string, value: unknown): Promise<{ path: string }> {
        assertWorkspaceWriteAllowed(options.manifest);
        return writeTextInsideRoot(
          options.workspaceRoot,
          relativePath,
          `${JSON.stringify(value, null, 2)}\n`,
          "workspace write",
        );
      },
    },
  };
}
