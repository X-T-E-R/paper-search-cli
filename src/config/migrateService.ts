import { createHash } from "node:crypto";
import {
  applyProviderDirectoryMigration,
  planProviderDirectoryMigration,
  recoverProviderDirectoryMigrations,
  type AppliedProviderDirectoryMigration,
  type ProviderDirectoryMigrationEntry,
  type ProviderDirectoryMigrationPlan,
} from "../providers/migration.js";
import {
  executeConfigMigration,
  planConfigMigration,
  type ConfigMigrationPlan,
} from "./migration.js";
import { tryAppendLifecycleEvent } from "../runtime/eventLedger.js";
import {
  applyConfigLocationMigration,
  planConfigLocationMigration,
  type ConfigLocationMigrationPlan,
} from "./locationMigration.js";

export interface MigrationBlocker {
  scope: "config-location" | "config" | "provider-directory";
  key: string;
  reason: string;
  blocksAllApply: boolean;
}

export interface CombinedMigrationPlan {
  schemaVersion: 1;
  configLocation: ConfigLocationMigrationPlan;
  config: ConfigMigrationPlan;
  providerDirectory: {
    status: "ready" | "requires-explicit-source";
    source: string;
    operationalRoot: string;
    operationalOwnership: "machine-data-root";
    plan: ProviderDirectoryMigrationPlan | null;
  };
  blockers: MigrationBlocker[];
  planDigest: string;
}

export interface CombinedMigrationResult {
  plan: CombinedMigrationPlan;
  applied: boolean;
  changed: boolean;
  components: {
    config: {
      applied: boolean;
      changed: boolean;
      operationId?: string;
      recovered: string[];
    };
    configLocation: {
      applied: boolean;
      changed: boolean;
      operationId?: string;
      receiptPath?: string;
    };
    providerDirectory: {
      applied: boolean;
      migrated: string[];
      recovered: string[];
      blocked: ProviderDirectoryMigrationEntry[];
    };
  };
  blockers: MigrationBlocker[];
  auditWarnings: string[];
  errors: string[];
}

export interface CombinedMigrationOptions {
  apply?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  legacyInstallDir?: string;
  legacyConfigRoot?: string;
  explicitConfigPath?: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function providerBlockers(plan: ProviderDirectoryMigrationPlan | null): MigrationBlocker[] {
  if (!plan) return [];
  return plan.entries
    .filter((entry) => entry.action === "blocked")
    .map((entry) => ({
      scope: "provider-directory" as const,
      key: entry.id,
      reason: entry.reason,
      // Provider migration is deliberately per-provider; one invalid package
      // does not block independent valid packages or config migration.
      blocksAllApply: false,
    }));
}

export async function planCombinedMigration(
  options: Omit<CombinedMigrationOptions, "apply"> = {},
): Promise<CombinedMigrationPlan> {
  const env = options.env ?? process.env;
  const configLocation = await planConfigLocationMigration({
    env,
    legacyConfigRoot: options.legacyConfigRoot,
  });
  const config = await planConfigMigration(options);
  const ownership = config.legacyInstallDirectory;
  const requiresExplicit = ownership.requiresExplicitSelection && !options.legacyInstallDir;
  const providerPlan = requiresExplicit
    ? null
    : await planProviderDirectoryMigration({
        legacyInstallDir: ownership.source,
        env,
      });
  const blockers: MigrationBlocker[] = [
    ...(["ambiguous", "conflicted", "blocked"].includes(configLocation.status)
      ? [{
          scope: "config-location" as const,
          key: "configRoot",
          reason: configLocation.requiresExplicitSource
            ? "Multiple different legacy config roots require --legacy-config-root"
            : configLocation.blockers.join("; ") || `Config-location migration is ${configLocation.status}`,
          blocksAllApply: true,
        }]
      : []),
    ...config.blockers.map((blocker) => ({
      scope: "config" as const,
      key: blocker.key,
      reason: blocker.detail,
      blocksAllApply: true,
    })),
    ...(requiresExplicit
      ? [{
          scope: "provider-directory" as const,
          key: "providers.installDir",
          reason: "Custom compatibility provider root requires --legacy-install-dir before provider movement",
          blocksAllApply: false,
        }]
      : []),
    ...providerBlockers(providerPlan),
  ];
  const base = {
    schemaVersion: 1 as const,
    configLocation,
    config,
    providerDirectory: {
      status: requiresExplicit ? "requires-explicit-source" as const : "ready" as const,
      source: ownership.source,
      operationalRoot: ownership.target,
      operationalOwnership: "machine-data-root" as const,
      plan: providerPlan,
    },
    blockers,
  };
  return { ...base, planDigest: digest(base) };
}

function emptyResult(plan: CombinedMigrationPlan): CombinedMigrationResult {
  return {
    plan,
    applied: false,
    changed: false,
    components: {
      config: { applied: false, changed: false, recovered: [] },
      configLocation: { applied: false, changed: false },
      providerDirectory: { applied: false, migrated: [], recovered: [], blocked: [] },
    },
    blockers: plan.blockers,
    auditWarnings: [],
    errors: [],
  };
}

export async function executeCombinedMigration(
  options: CombinedMigrationOptions = {},
): Promise<CombinedMigrationResult> {
  const env = options.env ?? process.env;
  if (!options.apply) return emptyResult(await planCombinedMigration(options));

  // Recovery is always first. It is authoritative cleanup of an earlier apply,
  // not a new provider move, and must complete before a new plan is selected.
  const recovery = await recoverProviderDirectoryMigrations(env);
  const plan = await planCombinedMigration(options);
  const result = emptyResult(plan);
  result.components.providerDirectory.recovered.push(...recovery.recovered);
  result.auditWarnings.push(...(recovery.auditWarnings ?? []));
  result.changed = recovery.recovered.length > 0;

  if (plan.blockers.some((blocker) => blocker.blocksAllApply)) {
    return result;
  }

  try {
    const location = await applyConfigLocationMigration({
      env,
      legacyConfigRoot: options.legacyConfigRoot,
    });
    result.components.configLocation = {
      applied: location.applied,
      changed: location.changed,
      ...(location.operationId ? { operationId: location.operationId } : {}),
      ...(location.receiptPath ? { receiptPath: location.receiptPath } : {}),
    };
    result.changed ||= location.changed;
  } catch (error) {
    result.errors.push(`Config-location migration failed: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  // Location migration is ordered first. Re-plan so schema/provider migration
  // consumes the copied conventional files rather than the now-retired root.
  const postLocationPlan = await planCombinedMigration(options);
  result.plan = postLocationPlan;
  result.blockers = postLocationPlan.blockers;
  if (postLocationPlan.blockers.some((blocker) => blocker.blocksAllApply)) return result;

  try {
    const config = await executeConfigMigration({
      apply: true,
      cwd: options.cwd,
      env,
      legacyInstallDir: options.legacyInstallDir,
      explicitConfigPath: options.explicitConfigPath,
    });
    result.components.config = {
      applied: true,
      changed: !postLocationPlan.config.alreadyMigrated,
      ...(config.operationId ? { operationId: config.operationId } : {}),
      recovered: config.recovered ?? [],
    };
    result.changed ||= result.components.config.changed || result.components.config.recovered.length > 0;
    if (result.components.config.changed || result.components.config.recovered.length > 0) {
      const audit = await tryAppendLifecycleEvent({
        ...(config.operationId ? { operationId: config.operationId } : {}),
        command: "migrate config",
        planDigest: postLocationPlan.config.planDigest,
        affectedIds: [],
        outcome: result.components.config.changed ? "applied" : "recovered",
      }, env);
      if (audit.warning) result.auditWarnings.push(audit.warning);
    }
  } catch (error) {
    result.errors.push(`Config migration failed: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  const providerPlan = postLocationPlan.providerDirectory.plan;
  if (providerPlan) {
    let appliedProviders: AppliedProviderDirectoryMigration;
    try {
      appliedProviders = await applyProviderDirectoryMigration(providerPlan, env);
    } catch (error) {
      result.errors.push(`Provider-directory migration failed: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
    result.components.providerDirectory = {
      applied: true,
      migrated: appliedProviders.migrated,
      recovered: [
        ...new Set([
          ...result.components.providerDirectory.recovered,
          ...appliedProviders.recovered,
        ]),
      ],
      blocked: appliedProviders.blocked,
    };
    result.auditWarnings.push(...(appliedProviders.auditWarnings ?? []));
    result.changed ||= appliedProviders.migrated.length > 0 || appliedProviders.recovered.length > 0;
  }

  result.applied = result.errors.length === 0;
  return result;
}
