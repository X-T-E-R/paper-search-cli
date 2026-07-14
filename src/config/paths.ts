import os from "node:os";
import path from "node:path";

export interface ConfigBundlePaths {
  root: string;
  config: string;
  subscriptions: string;
  credentials: string;
  externalSearch: string;
}

export function resolveConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.APPDATA) {
    return path.join(env.APPDATA, "paper-search");
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(expandHome(xdgConfigHome, env), "paper-search");
  }
  return path.join(os.homedir(), ".config", "paper-search");
}

export function resolveConfigBundlePaths(env: NodeJS.ProcessEnv = process.env): ConfigBundlePaths {
  const root = resolveConfigRoot(env);
  return {
    root,
    config: path.join(root, "config.toml"),
    subscriptions: path.join(root, "subscriptions.toml"),
    credentials: path.join(root, "credentials.toml"),
    externalSearch: path.join(root, "external-search.toml"),
  };
}

export function resolveDefaultUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveConfigBundlePaths(env).config;
}

export function resolveExplicitConfigPath(input: string, cwd: string): string {
  const resolved = path.resolve(cwd, expandHome(input));
  return path.extname(resolved).toLowerCase() === ".toml"
    ? resolved
    : path.join(resolved, "config.toml");
}

export function resolveConfigFragmentDirectory(configPath: string): string {
  const extension = path.extname(configPath);
  const stem = extension ? path.basename(configPath, extension) : path.basename(configPath);
  return path.join(path.dirname(configPath), `${stem}.d`);
}

export function resolveProjectConfigCandidates(cwd: string): string[] {
  return [path.join(cwd, "paper-search.toml"), path.join(cwd, ".paper-search.toml")];
}

export function expandHome(input: string, env: NodeJS.ProcessEnv = process.env): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}
