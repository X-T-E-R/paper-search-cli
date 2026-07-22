import type {
  ProviderAPI,
  ProviderHttpBodyRequestOptions,
  ProviderHttpRequestOptions,
  ProviderHttpResponse,
  ProviderManifest,
} from "../sdk/types.js";
import { DOMParser, parseHTML } from "linkedom/worker";
import { sanitizeUrlForPersistence } from "../../runtime/sanitizeUrl.js";

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expiresAt?: number;
}

export interface ProviderHttpTransport {
  get<T = unknown>(
    url: string,
    options?: ProviderHttpRequestOptions,
  ): Promise<ProviderHttpResponse<T>>;
  post<T = unknown>(
    url: string,
    body?: string | Record<string, unknown>,
    options?: ProviderHttpBodyRequestOptions,
  ): Promise<ProviderHttpResponse<T>>;
  put?<T = unknown>(
    url: string,
    body?: string | Record<string, unknown>,
    options?: ProviderHttpBodyRequestOptions,
  ): Promise<ProviderHttpResponse<T>>;
}

export interface CreateNodeCompatibilityApiOptions {
  manifest: ProviderManifest;
  providerConfig?: Record<string, unknown>;
  globalPrefs?: Record<string, unknown>;
  transport?: ProviderHttpTransport;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
  rateLimit?: {
    stateKey?: string;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  };
}

interface ProviderRateLimitState {
  intervalMs: number;
  nextAvailableAt: number;
  reservationQueue: Promise<void>;
}

const providerRateLimitStates = new Map<string, ProviderRateLimitState>();

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export function resetProviderRateLimitStateForTests(): void {
  providerRateLimitStates.clear();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesUrlPermission(url: string, pattern: string): boolean {
  const regex = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`, "i");
  return regex.test(url);
}

function assertUrlAllowed(url: string, manifest: ProviderManifest): void {
  const allowed = manifest.permissions.urls.some((pattern) => matchesUrlPermission(url, pattern));
  if (!allowed) {
    throw new Error(`URL not allowed by provider permissions: ${sanitizeUrlForPersistence(url)}`);
  }
}

function summarizeResponseBody(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function assertSuccessfulResponse(
  response: ProviderHttpResponse<unknown>,
  manifest: ProviderManifest,
  url: string,
): void {
  if (response.status >= 200 && response.status < 300) return;
  const statusText = response.statusText.trim();
  const body = summarizeResponseBody(response.data);
  throw new ProviderHttpError(
    [
      `Provider HTTP request failed (${manifest.id})`,
      `${response.status}${statusText ? ` ${statusText}` : ""}`,
      sanitizeUrlForPersistence(url),
      ...(body ? [body] : []),
    ].join(": "),
    manifest.id,
    response.status,
  );
}

function createSharedRateLimitAcquire(
  manifest: ProviderManifest,
  hooks: CreateNodeCompatibilityApiOptions["rateLimit"],
): () => Promise<void> {
  if (!manifest.rateLimitPerMinute) return async () => undefined;
  const intervalMs = 60_000 / manifest.rateLimitPerMinute;
  const stateKey = hooks?.stateKey ?? manifest.id;
  let state = providerRateLimitStates.get(stateKey);
  if (!state || state.intervalMs !== intervalMs) {
    state = {
      intervalMs,
      nextAvailableAt: 0,
      reservationQueue: Promise.resolve(),
    };
    providerRateLimitStates.set(stateKey, state);
  }
  const now = hooks?.now ?? Date.now;
  const sleep =
    hooks?.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  return async (): Promise<void> => {
    let waitMs = 0;
    const reserve = state!.reservationQueue.then(() => {
      const current = now();
      const scheduledAt = Math.max(current, state!.nextAvailableAt);
      state!.nextAvailableAt = scheduledAt + intervalMs;
      waitMs = Math.max(0, scheduledAt - current);
    });
    state!.reservationQueue = reserve.catch(() => undefined);
    await reserve;
    if (waitMs > 0) await sleep(waitMs);
  };
}

function toSearchParams(params: Record<string, unknown>): URLSearchParams {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
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

function mergeHeaders(base: Record<string, string>, extra?: Record<string, string>): Record<string, string> {
  return { ...base, ...(extra ?? {}) };
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^\./, "").toLowerCase();
}

function parseSetCookie(url: string, rawCookie: string): StoredCookie | null {
  const target = new URL(url);
  const segments = rawCookie
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const head = segments.shift();
  if (!head) return null;
  const separator = head.indexOf("=");
  if (separator <= 0) return null;

  const cookie: StoredCookie = {
    name: head.slice(0, separator).trim(),
    value: head.slice(separator + 1).trim(),
    domain: normalizeDomain(target.hostname),
    path: "/",
    secure: false,
  };

  for (const segment of segments) {
    const index = segment.indexOf("=");
    const key = (index >= 0 ? segment.slice(0, index) : segment).trim().toLowerCase();
    const value = index >= 0 ? segment.slice(index + 1).trim() : "";
    switch (key) {
      case "domain":
        if (value) cookie.domain = normalizeDomain(value);
        break;
      case "path":
        cookie.path = value || "/";
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "max-age": {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) {
          cookie.expiresAt = Date.now() + seconds * 1000;
        }
        break;
      }
      case "expires": {
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp)) {
          cookie.expiresAt = timestamp;
        }
        break;
      }
    }
  }

  return cookie.name ? cookie : null;
}

function extractSetCookies(headers: Headers): string[] {
  const getter = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === "function") {
    return getter.call(headers).filter((value) => Boolean(value?.trim()));
  }
  const merged = headers.get("set-cookie");
  return merged ? [merged] : [];
}

function cookieMatches(url: URL, cookie: StoredCookie): boolean {
  const now = Date.now();
  if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
    return false;
  }
  const targetDomain = url.hostname.toLowerCase();
  const cookieDomain = normalizeDomain(cookie.domain);
  const domainMatches =
    targetDomain === cookieDomain || targetDomain.endsWith(`.${cookieDomain}`);
  if (!domainMatches) {
    return false;
  }
  if (cookie.secure && url.protocol !== "https:") {
    return false;
  }
  const cookiePath = cookie.path || "/";
  return url.pathname.startsWith(cookiePath);
}

function appendCookies(
  cookiesByOrigin: Map<string, StoredCookie[]>,
  url: URL,
  rawCookies: string[],
): void {
  if (rawCookies.length === 0) return;
  const origin = url.origin;
  const existing = cookiesByOrigin.get(origin) ?? [];
  const next = existing.filter((cookie) => cookieMatches(url, cookie));

  for (const rawCookie of rawCookies) {
    const parsed = parseSetCookie(url.toString(), rawCookie);
    if (!parsed) continue;
    const filtered = next.filter(
      (cookie) =>
        !(
          cookie.name === parsed.name &&
          normalizeDomain(cookie.domain) === normalizeDomain(parsed.domain) &&
          cookie.path === parsed.path
        ),
    );
    next.splice(0, next.length, ...filtered);
    if (parsed.value && (parsed.expiresAt === undefined || parsed.expiresAt > Date.now())) {
      next.push(parsed);
    }
  }

  if (next.length > 0) {
    cookiesByOrigin.set(origin, next);
    return;
  }
  cookiesByOrigin.delete(origin);
}

function buildCookieHeader(
  cookiesByOrigin: Map<string, StoredCookie[]>,
  url: URL,
): string | undefined {
  const cookies = cookiesByOrigin.get(url.origin) ?? [];
  const pairs = cookies
    .filter((cookie) => cookieMatches(url, cookie))
    .map((cookie) => `${cookie.name}=${cookie.value}`);
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

async function fetchWithTimeout<T>(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function createDefaultTransport(manifest: ProviderManifest): ProviderHttpTransport {
  const cookiesByOrigin = new Map<string, StoredCookie[]>();

  return {
    async get<T = unknown>(
      url: string,
      options?: ProviderHttpRequestOptions,
    ): Promise<ProviderHttpResponse<T>> {
      const target = new URL(url);
      if (options?.params) {
        target.search = toSearchParams(options.params).toString();
      }
      const headers = mergeHeaders({}, options?.headers);
      if (options?.withCredentials) {
        const cookieHeader = buildCookieHeader(cookiesByOrigin, target);
        if (cookieHeader && !headers.cookie && !headers.Cookie) {
          headers.cookie = cookieHeader;
        }
      }
      const response = await fetchWithTimeout<T>(target.toString(), {
        method: "GET",
        headers,
      }, options?.timeout ?? manifest.searchTimeoutMs ?? 30_000);
      if (options?.withCredentials) {
        appendCookies(cookiesByOrigin, target, extractSetCookies(response.headers));
      }
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
      options?: {
        headers?: Record<string, string>;
        timeout?: number;
        withCredentials?: boolean;
      },
    ): Promise<ProviderHttpResponse<T>> {
      const target = new URL(url);
      const headers = mergeHeaders({}, options?.headers);
      let payload: string | undefined;
      if (typeof body === "string") {
        payload = body;
      } else if (body !== undefined) {
        payload = JSON.stringify(body);
        if (!headers["content-type"]) {
          headers["content-type"] = "application/json";
        }
      }
      if (options?.withCredentials) {
        const cookieHeader = buildCookieHeader(cookiesByOrigin, target);
        if (cookieHeader && !headers.cookie && !headers.Cookie) {
          headers.cookie = cookieHeader;
        }
      }
      const response = await fetchWithTimeout<T>(url, {
        method: "POST",
        headers,
        body: payload,
      }, options?.timeout ?? manifest.searchTimeoutMs ?? 30_000);
      if (options?.withCredentials) {
        appendCookies(cookiesByOrigin, target, extractSetCookies(response.headers));
      }
      return {
        data: await fetchJsonOrText<T>(response),
        status: response.status,
        statusText: response.statusText,
        headers: headersToRecord(response.headers),
      };
    },
    async put<T = unknown>(
      url: string,
      body?: string | Record<string, unknown>,
      options?: ProviderHttpBodyRequestOptions,
    ): Promise<ProviderHttpResponse<T>> {
      const target = new URL(url);
      const headers = mergeHeaders({}, options?.headers);
      let payload: string | undefined;
      if (typeof body === "string") {
        payload = body;
      } else if (body !== undefined) {
        payload = JSON.stringify(body);
        if (!headers["content-type"]) {
          headers["content-type"] = "application/json";
        }
      }
      if (options?.withCredentials) {
        const cookieHeader = buildCookieHeader(cookiesByOrigin, target);
        if (cookieHeader && !headers.cookie && !headers.Cookie) {
          headers.cookie = cookieHeader;
        }
      }
      const response = await fetchWithTimeout<T>(url, {
        method: "PUT",
        headers,
        body: payload,
      }, options?.timeout ?? manifest.searchTimeoutMs ?? 30_000);
      if (options?.withCredentials) {
        appendCookies(cookiesByOrigin, target, extractSetCookies(response.headers));
      }
      return {
        data: await fetchJsonOrText<T>(response),
        status: response.status,
        statusText: response.statusText,
        headers: headersToRecord(response.headers),
      };
    },
  };
}

function readTypedConfigValue<T>(
  source: Record<string, unknown>,
  key: string,
  defaultValue: T,
  validate: (value: unknown) => value is T,
): T {
  const value = source[key];
  if (validate(value)) {
    return value;
  }
  return defaultValue;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function parseXmlDocument(xml: string): Document {
  const doc = new DOMParser().parseFromString(String(xml), "text/xml") as unknown as Document;
  const parseError = doc.querySelector?.("parsererror");
  if (parseError) {
    throw new Error(`XML parse error: ${parseError.textContent ?? ""}`.trim());
  }
  return doc;
}

function parseHtmlDocument(html: string): Document {
  return parseHTML(String(html)).document as unknown as Document;
}

function elementNameMatches(element: Element, tagName: string): boolean {
  const names = [element.tagName, element.localName, element.nodeName].filter(Boolean);
  return names.some((name) => name === tagName || name.endsWith(`:${tagName}`));
}

function queryAllElements(parent: Document | Element): Element[] {
  const querySelectorAll = (parent as ParentNode).querySelectorAll;
  if (typeof querySelectorAll !== "function") {
    return [];
  }
  return Array.from(querySelectorAll.call(parent, "*")) as Element[];
}

function getElementsByTag(parent: Document | Element, tagName: string): Element[] {
  const direct = Array.from(parent.getElementsByTagName(tagName)) as Element[];
  if (direct.length > 0) {
    return direct;
  }

  const namespaceLookup = (
    parent as Document | Element & {
      getElementsByTagNameNS?: (namespace: string, localName: string) => HTMLCollectionOf<Element>;
    }
  ).getElementsByTagNameNS;
  if (typeof namespaceLookup === "function") {
    const namespaced = Array.from(namespaceLookup.call(parent, "*", tagName)) as Element[];
    if (namespaced.length > 0) {
      return namespaced;
    }
  }

  return queryAllElements(parent).filter((element) => elementNameMatches(element, tagName));
}

export function createNodeCompatibilityApi(
  options: CreateNodeCompatibilityApiOptions,
): ProviderAPI {
  const providerConfig = options.providerConfig ?? {};
  const globalPrefs = options.globalPrefs ?? {};
  const logger = options.logger ?? console;
  const transport = options.transport ?? createDefaultTransport(options.manifest);
  const allowedGlobalPrefs = new Set(options.manifest.allowedGlobalPrefs ?? []);
  const acquireRateLimit = createSharedRateLimitAcquire(
    options.manifest,
    options.rateLimit,
  );
  let reservedPermits = 0;

  async function reservePermit(): Promise<void> {
    await acquireRateLimit();
    reservedPermits += 1;
  }

  async function beforeRequest(url: string): Promise<void> {
    assertUrlAllowed(url, options.manifest);
    if (reservedPermits > 0) {
      reservedPermits -= 1;
      return;
    }
    await acquireRateLimit();
  }

  return {
    http: {
      async get<T = unknown>(
        url: string,
        requestOptions?: ProviderHttpRequestOptions,
      ): Promise<ProviderHttpResponse<T>> {
        await beforeRequest(url);
        const response = await transport.get<T>(url, requestOptions);
        assertSuccessfulResponse(response, options.manifest, url);
        return response;
      },
      async post<T = unknown>(
        url: string,
        body?: string | Record<string, unknown>,
        requestOptions?: {
          headers?: Record<string, string>;
          timeout?: number;
          withCredentials?: boolean;
        },
      ): Promise<ProviderHttpResponse<T>> {
        await beforeRequest(url);
        const response = await transport.post<T>(url, body, requestOptions);
        assertSuccessfulResponse(response, options.manifest, url);
        return response;
      },
      async put<T = unknown>(
        url: string,
        body?: string | Record<string, unknown>,
        requestOptions?: ProviderHttpBodyRequestOptions,
      ): Promise<ProviderHttpResponse<T>> {
        await beforeRequest(url);
        if (!transport.put) {
          throw new Error(`Provider HTTP transport does not implement PUT: ${options.manifest.id}`);
        }
        const response = await transport.put<T>(url, body, requestOptions);
        assertSuccessfulResponse(response, options.manifest, url);
        return response;
      },
    },
    xml: {
      parse(xml: string): Document {
        return parseXmlDocument(xml);
      },
      getText(doc: Document | Element, tag: string): string | null {
        return getElementsByTag(doc, tag)[0]?.textContent ?? null;
      },
      getTextAll(doc: Document | Element, tag: string): string[] {
        return getElementsByTag(doc, tag)
          .map((element) => element.textContent)
          .filter((text): text is string => text !== null);
      },
      getElements(parent: Document | Element, tag: string): Element[] {
        return getElementsByTag(parent, tag);
      },
      getAttribute(el: Element, name: string): string | null {
        return el.getAttribute(name);
      },
      getTextContent(el: Element): string | null {
        return el.textContent;
      },
    },
    dom: {
      parseHTML(html: string): Document {
        return parseHtmlDocument(html);
      },
    },
    config: {
      getString(key: string, defaultValue = ""): string {
        return readTypedConfigValue(providerConfig, key, defaultValue, isString);
      },
      getNumber(key: string, defaultValue = 0): number {
        return readTypedConfigValue(providerConfig, key, defaultValue, isNumber);
      },
      getBool(key: string, defaultValue = false): boolean {
        return readTypedConfigValue(providerConfig, key, defaultValue, isBoolean);
      },
    },
    getGlobalPref(key: string, defaultValue = ""): string {
      if (!allowedGlobalPrefs.has(key)) return defaultValue;
      return readTypedConfigValue(globalPrefs, key, defaultValue, isString);
    },
    getGlobalPrefNumber(key: string, defaultValue = 0): number {
      if (!allowedGlobalPrefs.has(key)) return defaultValue;
      return readTypedConfigValue(globalPrefs, key, defaultValue, isNumber);
    },
    getGlobalPrefBool(key: string, defaultValue = false): boolean {
      if (!allowedGlobalPrefs.has(key)) return defaultValue;
      return readTypedConfigValue(globalPrefs, key, defaultValue, isBoolean);
    },
    log: {
      debug(message: string, ...args: unknown[]): void {
        logger.debug(message, ...args);
      },
      info(message: string, ...args: unknown[]): void {
        logger.info(message, ...args);
      },
      warn(message: string, ...args: unknown[]): void {
        logger.warn(message, ...args);
      },
      error(message: string, ...args: unknown[]): void {
        logger.error(message, ...args);
      },
    },
    rateLimit: {
      acquire: reservePermit,
    },
  };
}
