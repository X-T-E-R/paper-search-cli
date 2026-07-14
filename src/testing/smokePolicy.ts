export interface SmokeConfig {
  enabled: boolean;
  envVar: string;
}

export interface ResolvedSmokePolicy {
  enabled: boolean;
  envVar: string;
  rawEnvValue: string;
  reason: string;
}

function parseTruthy(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveSmokePolicy(
  config: SmokeConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSmokePolicy {
  const rawEnvValue = String(env[config.envVar] ?? "");
  const envEnabled = parseTruthy(rawEnvValue);

  if (!config.enabled) {
    return {
      enabled: false,
      envVar: config.envVar,
      rawEnvValue,
      reason: "Smoke suite disabled in config.",
    };
  }

  if (!envEnabled) {
    return {
      enabled: false,
      envVar: config.envVar,
      rawEnvValue,
      reason: `Smoke suite requires ${config.envVar}=1.`,
    };
  }

  return {
    enabled: true,
    envVar: config.envVar,
    rawEnvValue,
    reason: "Smoke suite explicitly enabled.",
  };
}
