import {
  MATERIAL_IDENTIFIER_SCHEMES,
  MATERIAL_INPUT_KINDS,
  MATERIAL_OUTPUT_KINDS,
  MATERIAL_PROVIDER_KINDS,
  type MaterialConfigFieldSchema,
  type MaterialIdentifierScheme,
  type MaterialInputKind,
  type MaterialOutputKind,
  type MaterialProviderCapabilities,
  type MaterialProviderKind,
  type MaterialProviderManifest,
  type MaterialProviderPermissions,
} from "./types.js";

const ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const URL_PATTERN_RE = /^https?:\/\//i;

export class MaterialManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialManifestValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new MaterialManifestValidationError(message);
}

function validateCapabilities(value: unknown): MaterialProviderCapabilities {
  if (!isPlainObject(value)) fail("capabilities must be an object");

  const { inputs, outputs, inputTypes, identifierSchemes, network } = value;

  if (!Array.isArray(inputs) || inputs.length === 0) {
    fail("capabilities.inputs must be a non-empty array");
  }
  for (const input of inputs) {
    if (!MATERIAL_INPUT_KINDS.includes(input as MaterialInputKind)) {
      fail(`capabilities.inputs has invalid entry: ${String(input)}`);
    }
  }

  if (!Array.isArray(outputs) || outputs.length === 0) {
    fail("capabilities.outputs must be a non-empty array");
  }
  for (const output of outputs) {
    if (!MATERIAL_OUTPUT_KINDS.includes(output as MaterialOutputKind)) {
      fail(`capabilities.outputs has invalid entry: ${String(output)}`);
    }
  }

  if (typeof network !== "boolean") {
    fail("capabilities.network must be a boolean");
  }

  if (inputTypes !== undefined) {
    if (!Array.isArray(inputTypes) || !inputTypes.every((entry) => typeof entry === "string")) {
      fail("capabilities.inputTypes must be string[]");
    }
  }

  let schemes: MaterialIdentifierScheme[] | undefined;
  if (identifierSchemes !== undefined) {
    if (!Array.isArray(identifierSchemes) || identifierSchemes.length === 0) {
      fail("capabilities.identifierSchemes must be a non-empty array when provided");
    }
    for (const scheme of identifierSchemes) {
      if (!MATERIAL_IDENTIFIER_SCHEMES.includes(scheme as MaterialIdentifierScheme)) {
        fail(`capabilities.identifierSchemes has invalid entry: ${String(scheme)}`);
      }
    }
    schemes = [...new Set(identifierSchemes as MaterialIdentifierScheme[])];
  }

  const acceptsIdentifier = (inputs as MaterialInputKind[]).includes("identifier");
  if (acceptsIdentifier && !schemes) {
    fail(
      "capabilities.identifierSchemes must list supported schemes when inputs include identifier",
    );
  }
  if (!acceptsIdentifier && schemes) {
    fail("capabilities.identifierSchemes requires inputs to include identifier");
  }

  return {
    inputs: [...new Set(inputs as MaterialInputKind[])],
    outputs: [...new Set(outputs as MaterialOutputKind[])],
    network,
    ...(inputTypes !== undefined ? { inputTypes: inputTypes as string[] } : {}),
    ...(schemes !== undefined ? { identifierSchemes: schemes } : {}),
  };
}

function validateConfigSchema(value: unknown): Record<string, MaterialConfigFieldSchema> {
  if (!isPlainObject(value)) fail("configSchema must be an object");
  const result: Record<string, MaterialConfigFieldSchema> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(key)) fail(`Invalid configSchema key: ${key}`);
    if (!isPlainObject(raw)) fail(`configSchema.${key} must be an object`);
    const type = raw.type;
    if (type !== "secret" && type !== "string" && type !== "number" && type !== "boolean") {
      fail(`configSchema.${key}.type must be secret | string | number | boolean`);
    }
    if (raw.env !== undefined) {
      if (!Array.isArray(raw.env) || !raw.env.every((entry) => typeof entry === "string")) {
        fail(`configSchema.${key}.env must be string[]`);
      }
    }
    for (const field of ["label", "description", "placeholder"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "string") {
        fail(`configSchema.${key}.${field} must be a string`);
      }
    }
    if (raw.required !== undefined && typeof raw.required !== "boolean") {
      fail(`configSchema.${key}.required must be a boolean`);
    }
    result[key] = {
      type,
      ...(raw.default !== undefined ? { default: raw.default as string | number | boolean } : {}),
      ...(raw.env !== undefined ? { env: raw.env as string[] } : {}),
      ...(typeof raw.label === "string" ? { label: raw.label } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.placeholder === "string" ? { placeholder: raw.placeholder } : {}),
      ...(raw.required !== undefined ? { required: raw.required as boolean } : {}),
    };
  }
  return result;
}

function validatePermissions(
  value: unknown,
  networkCapable: boolean,
): MaterialProviderPermissions {
  if (!isPlainObject(value)) fail("permissions must be an object");
  const { network, localRead, localWrite } = value;

  let networkPatterns: string[] | undefined;
  if (network !== undefined) {
    if (!Array.isArray(network) || !network.every((entry) => typeof entry === "string")) {
      fail("permissions.network must be string[]");
    }
    for (const pattern of network as string[]) {
      if (!URL_PATTERN_RE.test(pattern) && !/^\*:\/\//.test(pattern)) {
        fail(`permissions.network has invalid url pattern: ${pattern}`);
      }
    }
    networkPatterns = network as string[];
  }

  if (networkCapable && (!networkPatterns || networkPatterns.length === 0)) {
    fail("permissions.network must list allowed URL patterns when capabilities.network is true");
  }

  if (localRead !== undefined && typeof localRead !== "boolean") {
    fail("permissions.localRead must be a boolean");
  }

  if (localWrite !== undefined && localWrite !== "none" && localWrite !== "cache" && localWrite !== "workspace") {
    fail("permissions.localWrite must be none | cache | workspace");
  }

  return {
    ...(networkPatterns !== undefined ? { network: networkPatterns } : {}),
    ...(localRead !== undefined ? { localRead: localRead as boolean } : {}),
    ...(localWrite !== undefined ? { localWrite: localWrite as "none" | "cache" | "workspace" } : {}),
  };
}

export function parseMaterialProviderManifest(raw: string): MaterialProviderManifest {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    fail("material manifest is not valid JSON");
  }
  if (!isPlainObject(data)) fail("material manifest root must be an object");

  const id = data.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    fail("manifest.id must match /^[a-z][a-z0-9_-]{1,63}$/");
  }

  const name = data.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 200) {
    fail("manifest.name invalid");
  }

  const version = data.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
    fail("manifest.version must be semver-like (e.g. 1.0.0)");
  }

  const kind = data.kind;
  if (!MATERIAL_PROVIDER_KINDS.includes(kind as MaterialProviderKind)) {
    fail(`manifest.kind must be one of: ${MATERIAL_PROVIDER_KINDS.join(", ")}`);
  }

  const entry = data.entry;
  if (typeof entry !== "string" || entry.length < 1 || entry.includes("..") || path_isAbsolute(entry)) {
    fail("manifest.entry must be a relative file path inside the package");
  }

  const capabilities = validateCapabilities(data.capabilities);
  if (kind === "artifact_resolver") {
    if (!capabilities.inputs.includes("identifier")) {
      fail("artifact_resolver manifests must accept identifier inputs");
    }
    if (!capabilities.outputs.includes("locations")) {
      fail("artifact_resolver manifests must declare locations outputs");
    }
  }
  const permissions = validatePermissions(data.permissions, capabilities.network);

  let configSchema: Record<string, MaterialConfigFieldSchema> | undefined;
  if (data.configSchema !== undefined) {
    configSchema = validateConfigSchema(data.configSchema);
  }

  let rateLimit: { requestsPerMinute?: number } | undefined;
  if (data.rateLimit !== undefined) {
    if (!isPlainObject(data.rateLimit)) fail("rateLimit must be an object");
    const rpm = data.rateLimit.requestsPerMinute;
    if (rpm !== undefined && (typeof rpm !== "number" || rpm < 1 || rpm > 10_000)) {
      fail("rateLimit.requestsPerMinute must be 1..10000");
    }
    rateLimit = rpm !== undefined ? { requestsPerMinute: rpm } : {};
  }

  let integrity: { sha256?: string } | undefined;
  if (data.integrity !== undefined) {
    if (!isPlainObject(data.integrity)) fail("integrity must be an object");
    const sha = data.integrity.sha256;
    if (sha !== undefined && (typeof sha !== "string" || !/^[a-f0-9]{64}$/i.test(sha))) {
      fail("integrity.sha256 must be 64 hex chars");
    }
    integrity = { sha256: typeof sha === "string" ? sha.toLowerCase() : undefined };
  }

  return {
    id,
    name,
    version,
    kind: kind as MaterialProviderKind,
    entry,
    description: typeof data.description === "string" ? data.description : undefined,
    author: typeof data.author === "string" ? data.author : undefined,
    capabilities,
    configSchema,
    permissions,
    rateLimit,
    integrity,
  };
}

function path_isAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
}
