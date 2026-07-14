import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "@iarna/toml";
import { z } from "zod";
import { resolveConfigRoot } from "../config/paths.js";
import { ExternalSearchError } from "./errors.js";
import { resolveExternalSearchAdapter } from "./adapters.js";

export const EXTERNAL_SEARCH_CONFIG_FILENAME = "external-search.toml";

const ProcessConfigSchema = z.object({
  executable: z.string().trim().min(1).max(32_768),
  args: z.array(z.string().max(32_768)).max(1_024).default([]),
  workingDirectory: z.string().trim().min(1).max(32_768).optional(),
}).strict();

const EnabledExternalSearchConfigFileSchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.literal(true),
  adapter: z.string().trim().min(1).max(64).default("native"),
  timeoutMs: z.number().int().min(100).max(300_000).default(300_000),
  process: ProcessConfigSchema,
}).strict();

const DisabledExternalSearchConfigFileSchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.literal(false),
  adapter: z.string().trim().min(1).max(64).optional(),
  timeoutMs: z.number().int().min(100).max(300_000).optional(),
  process: ProcessConfigSchema.optional(),
}).strict();

export const ExternalSearchConfigFileSchema = z.discriminatedUnion("enabled", [
  EnabledExternalSearchConfigFileSchema,
  DisabledExternalSearchConfigFileSchema,
]);

export type ExternalSearchConfigFile = z.infer<typeof ExternalSearchConfigFileSchema>;

export interface LoadedExternalSearchConfig extends z.infer<typeof EnabledExternalSearchConfigFileSchema> {
  configRoot: string;
  configPath: string;
  adapterPath?: string;
  process: ExternalSearchConfigFile["process"] & { workingDirectory: string };
}

export type ExternalSearchStaticStatus =
  | { state: "disabled"; enabled: false; configPath: string; reason: string }
  | { state: "misconfigured" | "adapter-invalid" | "tool-unavailable"; enabled: true; configPath: string; reason: string }
  | { state: "configured"; enabled: true; configPath: string; adapter: string; executable: string; reason?: string };

export interface ExternalSearchConfigOptions {
  env?: NodeJS.ProcessEnv;
  configRoot?: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveWorkingDirectory(configRoot: string, input?: string): string {
  if (!input) return configRoot;
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(configRoot, input);
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function executableCandidates(executable: string, env: NodeJS.ProcessEnv): string[] {
  if (path.isAbsolute(executable) || hasPathSeparator(executable)) return [executable];
  const directories = String(env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExtension = path.extname(executable).length > 0;
  return directories.flatMap((directory) =>
    hasExtension ? [path.join(directory, executable)] : extensions.map((extension) => path.join(directory, `${executable}${extension}`)),
  );
}

async function isExecutableAvailable(executable: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const candidate of executableCandidates(executable, env)) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      // Try the next PATH candidate.
    }
  }
  return false;
}

export async function loadExternalSearchConfig(
  options: ExternalSearchConfigOptions = {},
): Promise<LoadedExternalSearchConfig | null> {
  const env = options.env ?? process.env;
  const configRoot = path.resolve(options.configRoot ?? resolveConfigRoot(env));
  const configPath = path.join(configRoot, EXTERNAL_SEARCH_CONFIG_FILENAME);
  if (!(await fileExists(configPath))) return null;

  let parsed: unknown;
  try {
    parsed = parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new ExternalSearchError("external_search_misconfigured", `Invalid external search TOML at ${configPath}`, { cause: error });
  }
  const result = ExternalSearchConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ExternalSearchError(
      "external_search_misconfigured",
      `Invalid external search config at ${configPath}: ${result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`,
      { cause: result.error },
    );
  }
  if (!result.data.enabled) return null;

  const workingDirectory = resolveWorkingDirectory(configRoot, result.data.process.workingDirectory);
  const workingDirectoryStat = await stat(workingDirectory).catch(() => null);
  if (!workingDirectoryStat?.isDirectory()) {
    throw new ExternalSearchError("external_search_misconfigured", `External search working directory is unavailable: ${workingDirectory}`);
  }

  let executable = result.data.process.executable;
  if (!path.isAbsolute(executable) && hasPathSeparator(executable)) {
    executable = path.resolve(configRoot, executable);
  }

  const adapterPath = result.data.adapter === "native"
    ? undefined
    : await resolveExternalSearchAdapter(configRoot, result.data.adapter);

  if (!(await isExecutableAvailable(executable, env))) {
    throw new ExternalSearchError("tool_unavailable", `External search executable is unavailable: ${executable}`);
  }

  return {
    ...result.data,
    configRoot,
    configPath,
    ...(adapterPath ? { adapterPath } : {}),
    process: {
      ...result.data.process,
      executable,
      workingDirectory,
    },
  };
}

export async function inspectExternalSearchStatic(
  options: ExternalSearchConfigOptions = {},
): Promise<ExternalSearchStaticStatus> {
  const env = options.env ?? process.env;
  const configRoot = path.resolve(options.configRoot ?? resolveConfigRoot(env));
  const configPath = path.join(configRoot, EXTERNAL_SEARCH_CONFIG_FILENAME);
  if (!(await fileExists(configPath))) {
    return { state: "disabled", enabled: false, configPath, reason: "external-search.toml is absent" };
  }
  try {
    const loaded = await loadExternalSearchConfig({ env, configRoot });
    if (!loaded) return { state: "disabled", enabled: false, configPath, reason: "external search is disabled" };
    return {
      state: "configured",
      enabled: true,
      configPath,
      adapter: loaded.adapter,
      executable: loaded.process.executable,
    };
  } catch (error) {
    const external = error instanceof ExternalSearchError ? error : null;
    const state = external?.code === "adapter_invalid"
      ? "adapter-invalid"
      : external?.code === "tool_unavailable"
        ? "tool-unavailable"
        : "misconfigured";
    return {
      state,
      enabled: true,
      configPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
