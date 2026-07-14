import type {
  ProviderConfigFieldSchema,
  ProviderHelpExample,
  ProviderInventoryEntry,
  ProviderManifest,
  ProviderUsageHelp,
} from "../sdk/types.js";

const ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfigSchema(
  schema: unknown,
): asserts schema is Record<string, ProviderConfigFieldSchema> {
  if (!isPlainObject(schema)) {
    throw new ManifestValidationError("configSchema must be an object");
  }
  for (const [key, def] of Object.entries(schema)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(key)) {
      throw new ManifestValidationError(`Invalid configSchema key: ${key}`);
    }
    if (!isPlainObject(def)) {
      throw new ManifestValidationError(`configSchema.${key} must be an object`);
    }
    const type = def.type;
    if (type !== "boolean" && type !== "string" && type !== "number") {
      throw new ManifestValidationError(`configSchema.${key}.type invalid`);
    }
    if ("enum" in def && def.enum !== undefined) {
      if (!Array.isArray(def.enum) || !def.enum.every((entry) => typeof entry === "string")) {
        throw new ManifestValidationError(`configSchema.${key}.enum must be string[]`);
      }
    }
    for (const field of ["label", "labelZh", "description", "placeholder"] as const) {
      const value = def[field];
      if (value !== undefined && typeof value !== "string") {
        throw new ManifestValidationError(`configSchema.${key}.${field} must be a string`);
      }
    }
    for (const field of ["advanced", "secret", "required"] as const) {
      const value = def[field];
      if (value !== undefined && typeof value !== "boolean") {
        throw new ManifestValidationError(`configSchema.${key}.${field} must be boolean`);
      }
    }
    for (const field of ["min", "max"] as const) {
      const value = def[field];
      if (value !== undefined && typeof value !== "number") {
        throw new ManifestValidationError(`configSchema.${key}.${field} must be a number`);
      }
    }
  }
}

function validateHelpExample(example: unknown, index: number): asserts example is ProviderHelpExample {
  if (!isPlainObject(example)) {
    throw new ManifestValidationError(`help.examples[${index}] must be an object`);
  }
  for (const key of ["title", "titleZh", "description", "descriptionZh", "tool"] as const) {
    const value = example[key];
    if (value !== undefined && typeof value !== "string") {
      throw new ManifestValidationError(`help.examples[${index}].${key} must be a string`);
    }
  }
  if ("arguments" in example && example.arguments !== undefined && !isPlainObject(example.arguments)) {
    throw new ManifestValidationError(`help.examples[${index}].arguments must be an object`);
  }
}

function validateUsageHelp(help: unknown): asserts help is ProviderUsageHelp {
  if (!isPlainObject(help)) {
    throw new ManifestValidationError("help must be an object");
  }
  for (const key of ["summary", "summaryZh"] as const) {
    const value = help[key];
    if (value !== undefined && typeof value !== "string") {
      throw new ManifestValidationError(`help.${key} must be a string`);
    }
  }
  for (const key of ["notes", "notesZh"] as const) {
    const value = help[key];
    if (value !== undefined && (!Array.isArray(value) || !value.every((item) => typeof item === "string"))) {
      throw new ManifestValidationError(`help.${key} must be string[]`);
    }
  }
  if (help.examples !== undefined) {
    if (!Array.isArray(help.examples)) {
      throw new ManifestValidationError("help.examples must be an array");
    }
    help.examples.forEach((example, index) => validateHelpExample(example, index));
  }
}

function validateStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ManifestValidationError(`${field} must be string[]`);
  }
}

function validateControlledArray(
  value: unknown,
  field: string,
  allowed: readonly string[],
): asserts value is string[] {
  validateStringArray(value, field);
  if (
    value.length === 0 ||
    new Set(value).size !== value.length ||
    value.some((entry) => !allowed.includes(entry))
  ) {
    throw new ManifestValidationError(`${field} must contain unique controlled values`);
  }
}

function validateInventory(
  inventory: unknown,
  manifestId: string,
  manifestSourceType: "academic" | "patent",
): asserts inventory is ProviderInventoryEntry {
  if (!isPlainObject(inventory)) {
    throw new ManifestValidationError("inventory must be an object");
  }
  if (inventory.schemaVersion !== 1) {
    throw new ManifestValidationError("inventory.schemaVersion must be 1");
  }
  if (inventory.id !== manifestId) {
    throw new ManifestValidationError("inventory.id must match manifest.id");
  }
  if (inventory.kind !== "search") {
    throw new ManifestValidationError("inventory.kind must be search");
  }
  if (inventory.sourceType !== manifestSourceType) {
    throw new ManifestValidationError("inventory.sourceType must match manifest.sourceType");
  }
  if (inventory.entryKind !== "source" && inventory.entryKind !== "view") {
    throw new ManifestValidationError("inventory.entryKind must be source or view");
  }
  if (typeof inventory.serviceFamily !== "string" || !inventory.serviceFamily) {
    throw new ManifestValidationError("inventory.serviceFamily must be a string");
  }
  if (inventory.transport !== "api" && inventory.transport !== "html") {
    throw new ManifestValidationError("inventory.transport must be api or html");
  }
  validateControlledArray(inventory.domains, "inventory.domains", [
    "biomedicine",
    "computer-science",
    "cryptography",
    "engineering",
    "life-sciences",
    "multidisciplinary",
    "patents",
  ]);
  validateControlledArray(inventory.contentKinds, "inventory.contentKinds", [
    "book",
    "conference-paper",
    "journal-article",
    "patent",
    "preprint",
    "repository-record",
  ]);
  validateControlledArray(inventory.access, "inventory.access", [
    "credentialed",
    "institutional",
    "public",
    "session-gated",
  ]);
  if (
    !isPlainObject(inventory.selection) ||
    typeof inventory.selection.defaultInAll !== "boolean"
  ) {
    throw new ManifestValidationError("inventory.selection.defaultInAll must be boolean");
  }
  if (!isPlainObject(inventory.publication)) {
    throw new ManifestValidationError("inventory.publication must be an object");
  }
  if (
    inventory.publication.status !== "published" &&
    inventory.publication.status !== "retained-unpublished"
  ) {
    throw new ManifestValidationError(
      "inventory.publication.status must be published or retained-unpublished",
    );
  }
  if (inventory.aliases !== undefined) {
    validateStringArray(inventory.aliases, "inventory.aliases");
  }
  if (inventory.entryKind === "source") {
    if (typeof inventory.sourceId !== "string" || !inventory.sourceId) {
      throw new ManifestValidationError("source inventory requires sourceId");
    }
    if (inventory.backingSourceIds !== undefined) {
      throw new ManifestValidationError("source inventory cannot declare backingSourceIds");
    }
  } else {
    if (inventory.sourceId !== undefined) {
      throw new ManifestValidationError("view inventory cannot declare sourceId");
    }
    validateStringArray(inventory.backingSourceIds, "view inventory.backingSourceIds");
    if (inventory.backingSourceIds.length === 0) {
      throw new ManifestValidationError("view inventory.backingSourceIds cannot be empty");
    }
    if (inventory.selection.defaultInAll) {
      throw new ManifestValidationError("view inventory cannot default into platform=all");
    }
  }
}

export function parseProviderManifest(raw: string): ProviderManifest {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ManifestValidationError("manifest.json is not valid JSON");
  }

  if (!isPlainObject(data)) {
    throw new ManifestValidationError("manifest root must be an object");
  }

  const id = data.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new ManifestValidationError("manifest.id must match /^[a-z][a-z0-9_-]{1,63}$/");
  }

  const name = data.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 200) {
    throw new ManifestValidationError("manifest.name invalid");
  }

  const version = data.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new ManifestValidationError("manifest.version must be semver-like (e.g. 1.0.0)");
  }

  const sourceType = data.sourceType;
  if (sourceType !== "web" && sourceType !== "academic" && sourceType !== "patent") {
    throw new ManifestValidationError("manifest.sourceType must be web | academic | patent");
  }

  const permissions = data.permissions;
  if (!isPlainObject(permissions)) {
    throw new ManifestValidationError("manifest.permissions required");
  }
  const urls = permissions.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new ManifestValidationError("manifest.permissions.urls must be a non-empty array");
  }
  for (const url of urls) {
    if (typeof url !== "string" || url.length > 512) {
      throw new ManifestValidationError("manifest.permissions.urls entries must be strings");
    }
    if (!/^https?:\/\//i.test(url) && !/^\*:\/\//.test(url)) {
      throw new ManifestValidationError(`Invalid url pattern: ${url}`);
    }
  }

  let configSchema: Record<string, ProviderConfigFieldSchema> | undefined;
  if (data.configSchema !== undefined) {
    validateConfigSchema(data.configSchema);
    configSchema = data.configSchema as Record<string, ProviderConfigFieldSchema>;
  }

  let help: ProviderUsageHelp | undefined;
  if (data.help !== undefined) {
    validateUsageHelp(data.help);
    help = data.help as ProviderUsageHelp;
  }

  let allowedGlobalPrefs: string[] | undefined;
  if (data.allowedGlobalPrefs !== undefined) {
    if (!Array.isArray(data.allowedGlobalPrefs)) {
      throw new ManifestValidationError("allowedGlobalPrefs must be an array");
    }
    allowedGlobalPrefs = [];
    for (const pref of data.allowedGlobalPrefs) {
      if (typeof pref !== "string" || !/^[a-zA-Z0-9._-]+$/.test(pref)) {
        throw new ManifestValidationError(`Invalid allowedGlobalPref: ${pref}`);
      }
      allowedGlobalPrefs.push(pref);
    }
  }

  let rateLimitPerMinute: number | undefined;
  if (data.rateLimitPerMinute !== undefined) {
    if (
      typeof data.rateLimitPerMinute !== "number" ||
      data.rateLimitPerMinute < 1 ||
      data.rateLimitPerMinute > 10_000
    ) {
      throw new ManifestValidationError("rateLimitPerMinute must be 1..10000");
    }
    rateLimitPerMinute = data.rateLimitPerMinute;
  }

  let maxResultsLimit: number | undefined;
  if (data.maxResultsLimit !== undefined) {
    if (typeof data.maxResultsLimit !== "number" || data.maxResultsLimit < 1 || data.maxResultsLimit > 10_000) {
      throw new ManifestValidationError("maxResultsLimit must be 1..10000");
    }
    maxResultsLimit = data.maxResultsLimit;
  }

  let searchTimeoutMs: number | undefined;
  if (data.searchTimeoutMs !== undefined) {
    if (
      typeof data.searchTimeoutMs !== "number" ||
      data.searchTimeoutMs < 1000 ||
      data.searchTimeoutMs > 300_000
    ) {
      throw new ManifestValidationError("searchTimeoutMs must be 1000..300000");
    }
    searchTimeoutMs = data.searchTimeoutMs;
  }

  let integrity: { sha256?: string } | undefined;
  if (data.integrity !== undefined) {
    if (!isPlainObject(data.integrity)) {
      throw new ManifestValidationError("integrity must be an object");
    }
    const sha = data.integrity.sha256;
    if (sha !== undefined && (typeof sha !== "string" || !/^[a-f0-9]{64}$/i.test(sha))) {
      throw new ManifestValidationError("integrity.sha256 must be 64 hex chars");
    }
    integrity = { sha256: typeof sha === "string" ? sha.toLowerCase() : undefined };
  }

  let inventory: ProviderInventoryEntry | undefined;
  if (data.inventory !== undefined) {
    if (sourceType === "web") {
      throw new ManifestValidationError("web provider cannot declare search inventory");
    }
    validateInventory(data.inventory, id, sourceType);
    inventory = data.inventory;
  }

  return {
    id,
    name,
    version,
    sourceType,
    description: typeof data.description === "string" ? data.description : undefined,
    author: typeof data.author === "string" ? data.author : undefined,
    help,
    minPluginVersion: typeof data.minPluginVersion === "string" ? data.minPluginVersion : undefined,
    permissions: { urls: urls as string[] },
    configSchema,
    maxResultsLimit,
    rateLimitPerMinute,
    searchTimeoutMs,
    allowedGlobalPrefs,
    integrity,
    inventory,
  };
}
