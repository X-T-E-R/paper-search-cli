import type { ToolSchema } from "./toolCatalog.js";

export type ToolArguments = Record<string, unknown>;

export class ToolArgumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(message: string): never {
  throw new ToolArgumentValidationError(message);
}

export function parseJsonToolArguments(raw: string | undefined): ToolArguments {
  if (raw === undefined || raw.trim().length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`--json-args must be a valid JSON object: ${message}`);
  }

  if (!isPlainObject(parsed)) {
    fail("--json-args must be a JSON object");
  }
  return parsed;
}

export function parseArgAssignment(assignment: string): [string, unknown] {
  const equalsIndex = assignment.indexOf("=");
  if (equalsIndex <= 0) {
    fail(`--arg must use key=value syntax: ${assignment}`);
  }

  const key = assignment.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    fail(`Invalid --arg key: ${key || "(empty)"}`);
  }

  return [key, parseArgValue(assignment.slice(equalsIndex + 1))];
}

export function mergeToolArguments(options: {
  jsonArgs?: string;
  argAssignments?: readonly string[];
}): ToolArguments {
  const result = parseJsonToolArguments(options.jsonArgs);
  for (const assignment of options.argAssignments ?? []) {
    const [key, value] = parseArgAssignment(assignment);
    if (hasOwn(result, key)) {
      fail(`Duplicate argument key: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

function parseArgValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "true" || value === "false" || value === "null" || isJsonNumber(value) || isJsonContainer(value)) {
    try {
      return JSON.parse(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`Invalid JSON value for --arg: ${message}`);
    }
  }
  return raw;
}

function isJsonContainer(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[") || value.startsWith("\"");
}

function isJsonNumber(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
}

export function assertToolArgumentsMatchSchema(schema: ToolSchema, args: ToolArguments): void {
  const inputSchema = schema.inputSchema;
  if (inputSchema.type !== "object") {
    fail(`${schema.name} input schema must be an object schema`);
  }

  const properties = inputSchema.properties ?? {};
  const allowedKeys = new Set(Object.keys(properties));
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) {
      fail(`${key} is not a valid argument for ${schema.name}`);
    }
  }

  for (const key of inputSchema.required ?? []) {
    if (!hasOwn(args, key)) {
      fail(`${key} is required${requiredTypeSuffix(properties[key])}`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    validateValue(key, value, properties[key]);
  }
}

function requiredTypeSuffix(schema: unknown): string {
  if (!isPlainObject(schema) || typeof schema.type !== "string") {
    return "";
  }
  return ` and must be a ${schema.type}`;
}

function validateValue(key: string, value: unknown, schema: unknown): void {
  if (!isPlainObject(schema)) {
    fail(`${key} does not have a declared schema`);
  }

  const type = schema.type;
  if (typeof type !== "string") {
    fail(`${key} does not have a declared type`);
  }

  switch (type) {
    case "string":
      validateString(key, value, schema);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(`${key} must be a number`);
      }
      validateEnum(key, value, schema);
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        fail(`${key} must be a boolean`);
      }
      validateEnum(key, value, schema);
      return;
    case "object":
      if (!isPlainObject(value)) {
        fail(`${key} must be an object`);
      }
      return;
    case "array":
      validateArray(key, value, schema);
      return;
    default:
      fail(`${key} has unsupported schema type: ${type}`);
  }
}

function validateString(key: string, value: unknown, schema: Record<string, unknown>): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${key} must be a string`);
  }
  validateEnum(key, value, schema);
}

function validateArray(key: string, value: unknown, schema: Record<string, unknown>): void {
  if (!Array.isArray(value)) {
    fail(`${key} must be an array`);
  }

  const itemSchema = schema.items;
  if (itemSchema === undefined) {
    return;
  }
  if (!isPlainObject(itemSchema)) {
    fail(`${key}.items must be an object schema`);
  }

  for (let index = 0; index < value.length; index += 1) {
    validateValue(`${key}[${index}]`, value[index], itemSchema);
  }
}

function validateEnum(key: string, value: unknown, schema: Record<string, unknown>): void {
  const enumValues = schema.enum;
  if (enumValues === undefined) {
    return;
  }
  if (!Array.isArray(enumValues)) {
    fail(`${key}.enum must be an array`);
  }
  if (enumValues.length === 0) {
    return;
  }
  if (!enumValues.includes(value)) {
    fail(`${key} must be one of: ${enumValues.join(", ")}`);
  }
}
