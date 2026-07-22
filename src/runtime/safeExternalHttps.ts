import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { sanitizeUrlForPersistence } from "./sanitizeUrl.js";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeExternalHttpsTestHooks {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  requestPinned?: (
    url: URL,
    init: RequestInit,
    address: ResolvedAddress,
  ) => Promise<Response>;
}

let testHooks: SafeExternalHttpsTestHooks | undefined;

/** Host-only test seam. It is never injected into provider VM contexts. */
export function setSafeExternalHttpsTestHooksForTests(
  hooks: SafeExternalHttpsTestHooks | undefined,
): void {
  testHooks = hooks;
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
}

function inIpv4Range(address: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

function publicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
    ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
    ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, prefix]) => inIpv4Range(value, ipv4Number(base), prefix));
}

function expandIpv6(address: string): number[] | null {
  const zoneIndex = address.indexOf("%");
  const withoutZone = (zoneIndex >= 0 ? address.slice(0, zoneIndex) : address).toLowerCase();
  const mappedMatch = withoutZone.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/u);
  let normalized = withoutZone;
  if (mappedMatch) {
    const ipv4 = ipv4Number(mappedMatch[2]!);
    normalized = `${mappedMatch[1]}${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const sides = normalized.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides[1] ? sides[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (sides.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function publicIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) return false;
  const [first, second] = groups;
  if (groups.every((group) => group === 0) || groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false;
  if ((first! & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first! & 0xffc0) === 0xfe80) return false; // link local fe80::/10
  if ((first! & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6]! >>> 8}.${groups[6]! & 0xff}.${groups[7]! >>> 8}.${groups[7]! & 0xff}`;
    return publicIpv4(mapped);
  }
  return (first! & 0xe000) === 0x2000; // globally routable 2000::/3
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family === 6) return publicIpv6(address);
  return false;
}

function assertSafeUrl(url: URL): void {
  if (url.protocol !== "https:") throw new Error("External provider HTTP requires HTTPS");
  if (url.username || url.password) throw new Error("External provider HTTP URL must not contain userinfo");
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("External provider HTTP rejects localhost");
  }
}

async function resolvePublicAddress(hostname: string): Promise<ResolvedAddress> {
  const literalFamily = isIP(hostname);
  const addresses: ResolvedAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : testHooks?.resolve
      ? await testHooks.resolve(hostname)
      : (await dnsLookup(hostname, { all: true, verbatim: true })) as ResolvedAddress[];
  if (addresses.length === 0) throw new Error(`External provider HTTP hostname did not resolve: ${hostname}`);
  const unsafe = addresses.find((entry) => !isPublicNetworkAddress(entry.address));
  if (unsafe) {
    throw new Error(`External provider HTTP hostname resolved to a non-public address: ${unsafe.address}`);
  }
  return addresses[0]!;
}

async function defaultPinnedRequest(
  url: URL,
  init: RequestInit,
  pinned: ResolvedAddress,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const tlsHostname = url.hostname.replace(/^\[|\]$/gu, "");
    const requestHeaders: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      requestHeaders[key] = value;
    });
    if (
      typeof init.body === "string" &&
      requestHeaders["content-length"] === undefined &&
      requestHeaders["transfer-encoding"] === undefined
    ) {
      requestHeaders["content-length"] = String(Buffer.byteLength(init.body));
    }
    const request = https.request({
      protocol: "https:",
      hostname: tlsHostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers: requestHeaders,
      servername: tlsHostname,
      family: pinned.family,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      signal: init.signal ?? undefined,
    }, (incoming) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
        else if (value !== undefined) headers.set(key, String(value));
      }
      const status = incoming.statusCode ?? 500;
      const noBody = status === 204 || status === 205 || status === 304;
      if (noBody) incoming.resume();
      const body = noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, {
        status,
        statusText: incoming.statusMessage ?? "",
        headers,
      }));
    });
    request.on("error", reject);
    if (typeof init.body === "string") request.write(init.body);
    request.end();
  });
}

function redirectedInit(status: number, from: URL, to: URL, init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  if (from.origin !== to.origin) {
    headers.delete("authorization");
    headers.delete("cookie");
  }
  const method = String(init.method ?? "GET").toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    headers.delete("content-length");
    headers.delete("content-type");
    return { ...init, method: "GET", body: undefined, headers };
  }
  return { ...init, headers };
}

export async function safeExternalHttpsRequest(options: {
  url: string;
  init: RequestInit;
  assertAllowed(url: string): void;
  maxRedirects?: number;
}): Promise<{ response: Response; finalUrl: string }> {
  const cap = options.maxRedirects ?? MAX_REDIRECTS;
  let current = new URL(options.url);
  let init = { ...options.init };
  for (let redirects = 0; ; redirects += 1) {
    assertSafeUrl(current);
    options.assertAllowed(current.toString());
    const hostname = current.hostname.replace(/^\[|\]$/gu, "");
    const pinned = await resolvePublicAddress(hostname);
    let response: Response;
    try {
      response = await (testHooks?.requestPinned ?? defaultPinnedRequest)(current, init, pinned);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`External provider HTTP request failed for ${sanitizeUrlForPersistence(current.toString())}: ${message}`);
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: current.toString() };
    }
    if (redirects >= cap) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`External provider HTTP exceeded ${cap} redirects`);
    }
    const location = response.headers.get("location");
    if (!location) throw new Error(`External provider HTTP redirect ${response.status} is missing Location`);
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`External provider HTTP redirect ${response.status} has an invalid Location`);
    }
    init = redirectedInit(response.status, current, next, init);
    await response.body?.cancel().catch(() => undefined);
    current = next;
  }
}
