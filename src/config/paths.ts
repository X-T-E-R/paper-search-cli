import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaperSearchPaths } from "./home.js";

export interface ConfigBundlePaths {
  root: string;
  config: string;
  subscriptions: string;
  credentials: string;
  externalSearch: string;
}

export function resolveConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePaperSearchPaths(env).configRoot;
}

export function resolveConfigBundlePaths(env: NodeJS.ProcessEnv = process.env): ConfigBundlePaths {
  const paths = resolvePaperSearchPaths(env);
  return {
    root: paths.configRoot,
    config: paths.configPath,
    subscriptions: paths.subscriptionsPath,
    credentials: paths.credentialsPath,
    externalSearch: paths.externalSearchPath,
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
  let current = path.resolve(cwd);
  for (;;) {
    const candidates = [
      path.join(current, "paper-search.toml"),
      path.join(current, ".paper-search.toml"),
    ];
    if (candidates.some((candidate) => {
      try {
        lstatSync(candidate);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    })) return candidates;
    const parent = path.dirname(current);
    if (parent === current) return [
      path.join(path.resolve(cwd), "paper-search.toml"),
      path.join(path.resolve(cwd), ".paper-search.toml"),
    ];
    current = parent;
  }
}

export function expandHome(input: string, env: NodeJS.ProcessEnv = process.env): string {
  void env;
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}
