import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/schema.js";
import type { Io } from "../runtime/io.js";
import { listInstalledMaterialProviders } from "../material/registry/plan.js";
import { listInstalledProviders } from "../providers/registry/sync.js";
import type { InstalledProviderSummary } from "../providers/registry/sync.js";
import type { InstalledMaterialProviderSummary } from "../material/registry/plan.js";
import { resolveSmokePolicy } from "../testing/smokePolicy.js";
import { getCanonicalToolNames } from "../surface/toolCatalog.js";
import {
  buildZeroProviderWarnings,
  sanitizeRegistrySource,
} from "../surface/providerInstallHints.js";
import { failEnvelope, okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import {
  formatInstallHealthWarnings,
  inspectInstallHealth,
  type InstallationHealthChecks,
  type InstallHealthReport,
} from "../runtime/installLayout.js";
import {
  reconcileProviderInstallations,
  type ProviderDirectoryInspection,
} from "../providers/inventory.js";
import { resolveProviderLifecyclePaths } from "../providers/paths.js";
import { readCurrentRegistrySnapshot } from "../subscriptions/registry.js";
import { listSubscriptions } from "../subscriptions/service.js";
import { resolveSubscriptionPaths } from "../subscriptions/paths.js";
import type { SubscriptionView } from "../subscriptions/types.js";
import { inspectExternalSearchStatic, type ExternalSearchStaticStatus } from "../external-search/config.js";
import { probeExternalSearch } from "../external-search/service.js";
import { ExternalSearchError } from "../external-search/errors.js";
import { getSystemVersion } from "../runtime/version.js";

interface DoctorOptions {
  json?: boolean;
}

type RegistryKind = "local" | "file" | "url";

interface RegistryReachability {
  source: string;
  kind: RegistryKind;
  checked: boolean;
  reachable: boolean | null;
  reason: string;
  providerCount?: number;
  resolvedPath?: string;
}

interface ProviderManifestHealth {
  total: number;
  valid: number;
  invalid: number;
  invalidProviders: Array<{
    id: string;
    path: string;
    error?: string;
  }>;
}

interface WorkspaceWritability {
  root: string;
  writable: boolean;
  checkedPath: string;
  error?: string;
}

interface ApiKeyReportEntry {
  scope: "api" | "platform" | "material";
  providerId: string;
  key: string;
  status: "present" | "missing";
  masked: boolean;
  value?: "<masked>";
  source?: "config" | "env";
  env?: string;
  unused?: boolean;
}

export interface DoctorReport {
  installation: {
    checkout: string;
    buildPresent: boolean;
    installStatePresent: boolean;
    checkoutMatches: boolean | null;
    launcherProtocolMatches: boolean | null;
    projections: { healthy: number; total: number };
    shims: { healthy: number; total: number };
    binRoot: string;
    binOnPath: boolean;
    health: InstallHealthReport["summary"];
    checks: InstallationHealthChecks;
  };
  providerInstallDir: string;
  registry: RegistryReachability;
  manifestHealth: {
    searchProviders: ProviderManifestHealth;
    materialProviders: ProviderManifestHealth;
  };
  providerLifecycle: ProviderLifecycleHealthReport;
  workspace: WorkspaceWritability;
  externalSearch: ExternalSearchStaticStatus | {
    state: "ready" | "protocol-incompatible" | "adapter-invalid";
    enabled: true;
    configPath: string;
    reason: string;
    tool?: { name: string; version: string };
  };
  mcp: {
    ready: boolean;
    config: {
      enabled: boolean;
      transport: ResolvedConfig["server"]["transport"];
      host: string;
      port: number;
      endpoint: string;
    };
    status: {
      protocolVersion: "2024-11-05";
      initialized: false;
      serverInfo: { name: "paper-search-cli-mcp"; version: string };
      toolsAvailable: number;
    };
  };
  smoke: {
    enabled: boolean;
    envVar: string;
    envPresent: boolean;
    reason: string;
  };
  apiKeys: {
    known: ApiKeyReportEntry[];
    missing: ApiKeyReportEntry[];
  };
}

type LifecycleSeverity = "info" | "warning" | "error";

interface ProviderLifecycleIssue {
  code: string;
  severity: LifecycleSeverity;
  message: string;
  action: string;
  ids?: string[];
  paths?: string[];
}

interface ProviderHealthEntry {
  id: string;
  runtimeKind: "search" | "material";
  providerKind: string;
  version: string;
  path: string;
  healthy: boolean;
  bound: boolean;
  receiptStatus: "healthy" | "missing" | "malformed" | "mismatched" | "unreadable";
  bindingStatus:
    | "current"
    | "unbound"
    | "orphaned"
    | "identity-missing"
    | "rebind-pending"
    | "mismatched"
    | "unavailable"
    | "not-checkable";
  issues: string[];
}

interface ProviderKindHealth {
  installDir: string;
  total: number;
  healthy: number;
  unhealthy: number;
  bound: number;
  unbound: number;
  providers: ProviderHealthEntry[];
}

interface RecoveryJournalSummary {
  directory: string;
  pending: Array<{
    path: string;
    operationId: string | null;
    subjectId: string | null;
    status: string;
  }>;
  complete: number;
  corrupt: Array<{ path: string; error: string }>;
}

interface LockHealth {
  directory: string;
  observed: Array<{
    scope: string;
    path: string;
    valid: boolean;
    pid?: number;
    hostname?: string;
    acquiredAt?: string;
  }>;
  recoveryArtifacts: string[];
  corrupt: Array<{ path: string; error: string }>;
}

export interface ProviderLifecycleHealthReport {
  paths: {
    authoritativeRoot: string;
    searchInstallDir: string;
    materialInstallDir: string;
    configuredCompatibilityRoot: string;
  };
  inventory: {
    status: "available" | "unavailable";
    error?: string;
    total: number;
    healthy: number;
    unhealthy: number;
    bound: number;
    unbound: number;
    duplicateGlobalIds: string[];
    healthyIds: string[];
    unhealthyIds: string[];
    boundIds: string[];
    unboundIds: string[];
    byKind: { search: ProviderKindHealth; material: ProviderKindHealth };
    receiptHealth: Record<ProviderHealthEntry["receiptStatus"], number>;
  };
  subscriptions: {
    status: "available" | "unavailable";
    error?: string;
    total: number;
    rebindPendingIds: string[];
    identityMissingIds: string[];
    entries: Array<{
      id: string;
      runtimeKind: "search" | "material";
      status: SubscriptionView["status"];
      enabled: boolean;
      dependents: string[];
      snapshot: {
        status: "current" | "missing" | "invalid" | "rebind-pending" | "identity-missing";
        registryDigest?: string;
        fetchedAt?: string;
        ageMs?: number;
        error?: string;
      };
    }>;
  };
  recovery: {
    providerMigrations: RecoveryJournalSummary;
    registryOperations: RecoveryJournalSummary;
  };
  locks: LockHealth;
  health: {
    status: "healthy" | "warning" | "unhealthy" | "unavailable";
    issues: ProviderLifecycleIssue[];
  };
}

const RETIRED_WEB_API_SECTIONS = new Set(["tavily", "firecrawl", "exa", "xai", "mysearch"]);
const SECRET_KEY_RE = /(?:api[-_]?key|token|secret|password|credential)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyReceipt(entry: ProviderDirectoryInspection): ProviderHealthEntry["receiptStatus"] {
  if (entry.receiptError) return "malformed";
  if (!entry.receipt) {
    return entry.issues.some((issue) => issue === "provider receipt is missing") ? "missing" : "unreadable";
  }
  return entry.issues.length > 0 ? "mismatched" : "healthy";
}

function bindingStatus(
  entry: ProviderDirectoryInspection,
  subscriptions: Map<string, SubscriptionView> | null,
): ProviderHealthEntry["bindingStatus"] {
  if (!entry.healthy || !entry.receipt) return "not-checkable";
  if (!entry.receipt.bound) return "unbound";
  if (!subscriptions) return "unavailable";
  const subscription = subscriptions.get(entry.receipt.subscriptionId!);
  if (!subscription) return "orphaned";
  if (!subscription.identity) return "identity-missing";
  if (subscription.status === "rebind-pending") return "rebind-pending";
  if (
    subscription.runtimeKind !== entry.runtimeKind ||
    subscription.identity.sourceFingerprint !== entry.receipt.sourceFingerprint ||
    subscription.identity.canonicalSource !== entry.receipt.canonicalSource
  ) return "mismatched";
  return "current";
}

async function inspectSubscriptions(env: NodeJS.ProcessEnv): Promise<{
  report: ProviderLifecycleHealthReport["subscriptions"];
  views: Map<string, SubscriptionView> | null;
}> {
  let views: SubscriptionView[];
  try {
    views = await listSubscriptions(env);
  } catch (error) {
    return {
      report: {
        status: "unavailable",
        error: formatError(error),
        total: 0,
        rebindPendingIds: [],
        identityMissingIds: [],
        entries: [],
      },
      views: null,
    };
  }
  const entries = await Promise.all(views.map(async (view) => {
    if (view.status === "rebind-pending") {
      return {
        id: view.id,
        runtimeKind: view.runtimeKind,
        status: view.status,
        enabled: view.enabled,
        dependents: view.dependents,
        snapshot: { status: "rebind-pending" as const },
      };
    }
    if (!view.identity) {
      return {
        id: view.id,
        runtimeKind: view.runtimeKind,
        status: view.status,
        enabled: view.enabled,
        dependents: view.dependents,
        snapshot: { status: "identity-missing" as const },
      };
    }
    try {
      const snapshot = await readCurrentRegistrySnapshot(view.id, view.identity, env);
      if (!snapshot) {
        return {
          id: view.id,
          runtimeKind: view.runtimeKind,
          status: view.status,
          enabled: view.enabled,
          dependents: view.dependents,
          snapshot: { status: "missing" as const },
        };
      }
      const fetchedAtMs = Date.parse(snapshot.summary.fetchedAt);
      return {
        id: view.id,
        runtimeKind: view.runtimeKind,
        status: view.status,
        enabled: view.enabled,
        dependents: view.dependents,
        snapshot: {
          status: "current" as const,
          registryDigest: snapshot.summary.registryDigest,
          fetchedAt: snapshot.summary.fetchedAt,
          ...(Number.isFinite(fetchedAtMs) ? { ageMs: Math.max(0, Date.now() - fetchedAtMs) } : {}),
        },
      };
    } catch (error) {
      return {
        id: view.id,
        runtimeKind: view.runtimeKind,
        status: view.status,
        enabled: view.enabled,
        dependents: view.dependents,
        snapshot: { status: "invalid" as const, error: formatError(error) },
      };
    }
  }));
  return {
    report: {
      status: "available",
      total: views.length,
      rebindPendingIds: views.filter((view) => view.status === "rebind-pending").map((view) => view.id),
      identityMissingIds: views.filter((view) => view.status === "identity-missing").map((view) => view.id),
      entries,
    },
    views: new Map(views.map((view) => [view.id, view])),
  };
}

async function inspectRecoveryJournals(options: {
  directory: string;
  filename?: (name: string) => boolean;
  subjectField: "providerId" | "subscriptionId";
  pendingStatuses: ReadonlySet<string>;
}): Promise<RecoveryJournalSummary> {
  let entries;
  try {
    entries = await readdir(options.directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { directory: options.directory, pending: [], complete: 0, corrupt: [] };
    }
    return {
      directory: options.directory,
      pending: [],
      complete: 0,
      corrupt: [{ path: options.directory, error: formatError(error) }],
    };
  }
  const summary: RecoveryJournalSummary = {
    directory: options.directory,
    pending: [],
    complete: 0,
    corrupt: [],
  };
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || (options.filename && !options.filename(entry.name))) continue;
    const filePath = path.join(options.directory, entry.name);
    try {
      const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
      if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        typeof value.status !== "string" ||
        !(value.operationId === undefined || typeof value.operationId === "string") ||
        !(value[options.subjectField] === undefined || typeof value[options.subjectField] === "string")
      ) throw new Error("invalid recovery journal shape");
      const subjectId = value[options.subjectField];
      if (options.pendingStatuses.has(value.status)) {
        summary.pending.push({
          path: filePath,
          operationId: typeof value.operationId === "string" ? value.operationId : null,
          subjectId: typeof subjectId === "string" ? subjectId : null,
          status: value.status,
        });
      } else if (value.status === "complete") {
        summary.complete += 1;
      } else {
        throw new Error(`unsupported recovery status: ${value.status}`);
      }
    } catch (error) {
      summary.corrupt.push({ path: filePath, error: formatError(error) });
    }
  }
  return summary;
}

function lockScope(root: string, filePath: string): string {
  const relative = path.relative(root, filePath).replace(/\\/g, "/").replace(/\.lock$/u, "");
  return relative.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  }).join("/");
}

async function inspectLocks(directory: string): Promise<LockHealth> {
  const report: LockHealth = { directory, observed: [], recoveryArtifacts: [], corrupt: [] };
  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && current === directory) return;
      report.corrupt.push({ path: current, error: formatError(error) });
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.includes(".lock.stale-")) {
        report.recoveryArtifacts.push(filePath);
        continue;
      }
      if (!entry.name.endsWith(".lock")) continue;
      try {
        const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
        if (
          !isRecord(value) ||
          value.schemaVersion !== 1 ||
          typeof value.pid !== "number" ||
          typeof value.hostname !== "string" ||
          typeof value.acquiredAt !== "string" ||
          typeof value.token !== "string"
        ) throw new Error("invalid lock ownership record");
        report.observed.push({
          scope: lockScope(directory, filePath),
          path: filePath,
          valid: true,
          pid: value.pid,
          hostname: value.hostname,
          acquiredAt: value.acquiredAt,
        });
      } catch (error) {
        report.observed.push({ scope: lockScope(directory, filePath), path: filePath, valid: false });
        report.corrupt.push({ path: filePath, error: formatError(error) });
      }
    }
  }
  await visit(directory);
  return report;
}

function kindHealth(
  runtimeKind: "search" | "material",
  installDir: string,
  providers: ProviderHealthEntry[],
): ProviderKindHealth {
  const selected = providers.filter((entry) => entry.runtimeKind === runtimeKind);
  return {
    installDir,
    total: selected.length,
    healthy: selected.filter((entry) => entry.healthy).length,
    unhealthy: selected.filter((entry) => !entry.healthy).length,
    bound: selected.filter((entry) => entry.bound).length,
    unbound: selected.filter((entry) => entry.healthy && !entry.bound).length,
    providers: selected,
  };
}

export async function inspectProviderLifecycleHealth(
  configuredCompatibilityRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderLifecycleHealthReport> {
  const lifecyclePaths = resolveProviderLifecyclePaths(env);
  const subscriptionPaths = resolveSubscriptionPaths(env);
  type Reconciliation = Awaited<ReturnType<typeof reconcileProviderInstallations>>;
  const reconciliationPromise: Promise<{ value: Reconciliation | null; error?: string }> =
    reconcileProviderInstallations(env).then(
      (value) => ({ value }),
      (error: unknown) => ({ value: null, error: formatError(error) }),
    );
  const [reconciliation, subscriptionInspection, providerMigrations, registryOperations, locks] = await Promise.all([
    reconciliationPromise,
    inspectSubscriptions(env),
    inspectRecoveryJournals({
      directory: lifecyclePaths.migrationStateDir,
      filename: (name) => name.startsWith("provider-"),
      subjectField: "providerId",
      pendingStatuses: new Set(["pending", "selected"]),
    }),
    inspectRecoveryJournals({
      directory: subscriptionPaths.operationsDir,
      subjectField: "subscriptionId",
      pendingStatuses: new Set(["pending"]),
    }),
    inspectLocks(subscriptionPaths.locksDir),
  ]);
  const rawInstallations = reconciliation.value?.installations ?? [];
  const providers = rawInstallations.map((entry): ProviderHealthEntry => {
    const binding = bindingStatus(entry, subscriptionInspection.views);
    const receipt = classifyReceipt(entry);
    const bindingIssue = binding === "current" || binding === "unbound" || binding === "not-checkable"
      ? []
      : [`receipt binding is ${binding}`];
    return {
      id: entry.id,
      runtimeKind: entry.runtimeKind,
      providerKind: entry.providerKind,
      version: entry.version,
      path: entry.path,
      healthy: entry.healthy && (binding === "current" || binding === "unbound"),
      bound: entry.bound,
      receiptStatus: receipt,
      bindingStatus: binding,
      issues: [...entry.issues, ...bindingIssue],
    };
  });
  const byKind = {
    search: kindHealth("search", lifecyclePaths.searchInstallDir, providers),
    material: kindHealth("material", lifecyclePaths.materialInstallDir, providers),
  };
  const receiptHealth: ProviderLifecycleHealthReport["inventory"]["receiptHealth"] = {
    healthy: 0,
    missing: 0,
    malformed: 0,
    mismatched: 0,
    unreadable: 0,
  };
  for (const provider of providers) receiptHealth[provider.receiptStatus] += 1;
  const ids = (selected: ProviderHealthEntry[]) => [...new Set(selected.map((entry) => entry.id))].sort();
  const inventory: ProviderLifecycleHealthReport["inventory"] = {
    status: reconciliation.value ? "available" : "unavailable",
    ...(reconciliation.error ? { error: reconciliation.error } : {}),
    total: providers.length,
    healthy: providers.filter((entry) => entry.healthy).length,
    unhealthy: providers.filter((entry) => !entry.healthy).length,
    bound: providers.filter((entry) => entry.bound).length,
    unbound: providers.filter((entry) => entry.healthy && !entry.bound).length,
    duplicateGlobalIds: reconciliation.value?.duplicateIds ?? [],
    healthyIds: ids(providers.filter((entry) => entry.healthy)),
    unhealthyIds: ids(providers.filter((entry) => !entry.healthy)),
    boundIds: ids(providers.filter((entry) => entry.bound)),
    unboundIds: ids(providers.filter((entry) => entry.healthy && !entry.bound)),
    byKind,
    receiptHealth,
  };
  const recovery = { providerMigrations, registryOperations };
  const issues: ProviderLifecycleIssue[] = [];
  const addIssue = (issue: ProviderLifecycleIssue) => issues.push(issue);
  if (inventory.status === "unavailable") {
    addIssue({
      code: "provider-inventory-unavailable",
      severity: "error",
      message: `Authoritative provider inventory is unavailable: ${inventory.error ?? "unknown error"}`,
      action: "Restore read access to the Paper Search data root and rerun doctor.",
    });
  }
  if (inventory.duplicateGlobalIds.length > 0) {
    addIssue({
      code: "duplicate-provider-ids",
      severity: "error",
      message: `Provider ids occupy more than one runtime namespace: ${inventory.duplicateGlobalIds.join(", ")}`,
      action: "Remove or migrate the conflicting provider before install or update.",
      ids: inventory.duplicateGlobalIds,
    });
  }
  const unhealthyProviders = providers.filter((entry) => !entry.healthy);
  if (unhealthyProviders.length > 0) {
    addIssue({
      code: "provider-integrity",
      severity: "error",
      message: `${unhealthyProviders.length} authoritative provider installation(s) have receipt, content, or binding mismatches.`,
      action: "Inspect the listed provider issues; reinstall from its bound subscription or migrate the legacy directory.",
      ids: [...new Set(unhealthyProviders.map((entry) => entry.id))].sort(),
      paths: unhealthyProviders.map((entry) => entry.path),
    });
  }
  const unboundProviders = providers.filter((entry) => entry.healthy && !entry.bound);
  if (unboundProviders.length > 0) {
    addIssue({
      code: "unbound-providers",
      severity: "warning",
      message: `${unboundProviders.length} provider installation(s) are healthy but unbound and cannot update automatically.`,
      action: "Reinstall from a saved subscription when origin-bound updates are required.",
      ids: [...new Set(unboundProviders.map((entry) => entry.id))].sort(),
    });
  }
  if (subscriptionInspection.report.status === "unavailable") {
    addIssue({
      code: "subscription-state-unavailable",
      severity: "error",
      message: `Subscription state is unavailable: ${subscriptionInspection.report.error ?? "unknown error"}`,
      action: "Run `paper-search config validate` and repair the reported subscriptions or identity state.",
    });
  }
  if (subscriptionInspection.report.rebindPendingIds.length > 0) {
    addIssue({
      code: "subscriptions-rebind-pending",
      severity: "error",
      message: `Subscription URL changes require explicit rebind: ${subscriptionInspection.report.rebindPendingIds.join(", ")}`,
      action: "Run `paper-search registries rebind <id> <url>` to review each plan, then rerun with `--apply`.",
      ids: subscriptionInspection.report.rebindPendingIds,
    });
  }
  if (subscriptionInspection.report.identityMissingIds.length > 0) {
    addIssue({
      code: "subscription-identities-missing",
      severity: "error",
      message: `Subscription identities are missing: ${subscriptionInspection.report.identityMissingIds.join(", ")}`,
      action: "Re-add or explicitly rebind the subscription before refresh or provider installation.",
      ids: subscriptionInspection.report.identityMissingIds,
    });
  }
  const invalidSnapshots = subscriptionInspection.report.entries.filter((entry) => entry.snapshot.status === "invalid");
  if (invalidSnapshots.length > 0) {
    addIssue({
      code: "registry-snapshots-invalid",
      severity: "error",
      message: `Validated registry state is corrupt or inconsistent for: ${invalidSnapshots.map((entry) => entry.id).join(", ")}`,
      action: "Inspect the snapshot error, preserve evidence, then rerun `paper-search registries refresh <id>`.",
      ids: invalidSnapshots.map((entry) => entry.id),
    });
  }
  const missingSnapshots = subscriptionInspection.report.entries.filter(
    (entry) => entry.enabled && entry.snapshot.status === "missing",
  );
  if (missingSnapshots.length > 0) {
    addIssue({
      code: "registry-snapshots-missing",
      severity: "warning",
      message: `Enabled subscriptions have no validated registry snapshot: ${missingSnapshots.map((entry) => entry.id).join(", ")}`,
      action: "Run `paper-search registries refresh <id>` before listing or installing providers.",
      ids: missingSnapshots.map((entry) => entry.id),
    });
  }
  for (const [code, label, journal] of [
    ["provider-migration-pending", "provider migration", providerMigrations],
    ["registry-operation-pending", "registry operation", registryOperations],
  ] as const) {
    if (journal.pending.length > 0) {
      addIssue({
        code,
        severity: "error",
        message: `${journal.pending.length} ${label} recovery journal(s) are pending.`,
        action: `Resume the ${label} workflow before starting another provider lifecycle mutation.`,
        paths: journal.pending.map((entry) => entry.path),
      });
    }
    if (journal.corrupt.length > 0) {
      addIssue({
        code: `${code}-corrupt`,
        severity: "error",
        message: `${journal.corrupt.length} ${label} recovery journal(s) are unreadable or malformed.`,
        action: "Preserve the journal and inspect it manually; do not delete recovery evidence blindly.",
        paths: journal.corrupt.map((entry) => entry.path),
      });
    }
  }
  if (locks.observed.length > 0) {
    addIssue({
      code: "lifecycle-locks-observed",
      severity: "info",
      message: `${locks.observed.length} lifecycle lock file(s) are currently observable.`,
      action: "Allow the owning operation to finish; stale-owner recovery occurs when the next operation acquires the lock.",
      paths: locks.observed.map((entry) => entry.path),
    });
  }
  if (locks.corrupt.length > 0) {
    addIssue({
      code: "lifecycle-locks-corrupt",
      severity: "error",
      message: `${locks.corrupt.length} lifecycle lock ownership record(s) are malformed or unreadable.`,
      action: "Inspect the lock owner and active processes before manual intervention.",
      paths: locks.corrupt.map((entry) => entry.path),
    });
  }
  if (locks.recoveryArtifacts.length > 0) {
    addIssue({
      code: "lock-recovery-artifacts",
      severity: "warning",
      message: `${locks.recoveryArtifacts.length} quarantined lock recovery artifact(s) remain.`,
      action: "Confirm no lifecycle operation is active, then inspect the recovery artifact before cleanup.",
      paths: locks.recoveryArtifacts,
    });
  }
  const unavailable = inventory.status === "unavailable" || subscriptionInspection.report.status === "unavailable";
  const healthStatus: ProviderLifecycleHealthReport["health"]["status"] = unavailable
    ? "unavailable"
    : issues.some((issue) => issue.severity === "error")
      ? "unhealthy"
      : issues.some((issue) => issue.severity === "warning")
        ? "warning"
        : "healthy";
  return {
    paths: {
      authoritativeRoot: lifecyclePaths.providersRoot,
      searchInstallDir: lifecyclePaths.searchInstallDir,
      materialInstallDir: lifecyclePaths.materialInstallDir,
      configuredCompatibilityRoot: path.resolve(configuredCompatibilityRoot),
    },
    inventory,
    subscriptions: subscriptionInspection.report,
    recovery,
    locks,
    health: { status: healthStatus, issues },
  };
}

export function registerDoctorCommand(program: Command, io: Io): void {
  program
    .command("doctor")
    .description("Return an envelope with local readiness, provider, MCP, smoke, and masked secret health.")
    .option("--json", "emit machine-readable JSON envelope")
    .action(async (_options: DoctorOptions, command: Command) => {
      const started = Date.now();
      let envelope: ResultEnvelope<DoctorReport> | ResultEnvelope<null>;
      try {
        const globalOptions = command.optsWithGlobals<{ config?: string }>();
        const config = await loadConfig({ explicitConfigPath: globalOptions.config });
        const report = await createDoctorReport(config);
        const installCounts = {
          search: report.providerLifecycle.inventory.byKind.search.total > 0
            ? {
                total: report.providerLifecycle.inventory.byKind.search.total,
                valid: report.providerLifecycle.inventory.byKind.search.healthy,
              }
            : {
                total: report.manifestHealth.searchProviders.total,
                valid: report.manifestHealth.searchProviders.valid,
              },
          material: report.providerLifecycle.inventory.byKind.material.total > 0
            ? {
                total: report.providerLifecycle.inventory.byKind.material.total,
                valid: report.providerLifecycle.inventory.byKind.material.healthy,
              }
            : {
                total: report.manifestHealth.materialProviders.total,
                valid: report.manifestHealth.materialProviders.valid,
              },
        };
        const warnings = [
          ...buildZeroProviderWarnings(report.registry.source, installCounts),
          ...formatInstallHealthWarnings({ summary: report.installation.health }),
          ...report.providerLifecycle.health.issues
            .filter((issue) => issue.severity !== "info")
            .map((issue) => `Provider lifecycle ${issue.code}: ${issue.message} ${issue.action}`),
        ];
        envelope = okEnvelope({
          capability: "operate",
          tool: "doctor",
          data: report,
          diagnostics: {
            elapsedMs: Date.now() - started,
            manifestInvalidCount:
              report.manifestHealth.searchProviders.invalid +
              report.manifestHealth.materialProviders.invalid,
            missingApiKeyCount: report.apiKeys.missing.length,
            installedProviderCounts: installCounts,
            installationHealth: report.installation.health.status,
            providerLifecycleHealth: report.providerLifecycle.health.status,
            authoritativeProviderCounts: {
              search: report.providerLifecycle.inventory.byKind.search.total,
              material: report.providerLifecycle.inventory.byKind.material.total,
            },
          },
          ...(warnings.length > 0 ? { warnings } : {}),
          provenance: {
            configPaths: config.meta.loadedFiles,
          },
        });
      } catch (error) {
        envelope = failEnvelope({
          capability: "operate",
          tool: "doctor",
          errors: [formatError(error)],
          diagnostics: { elapsedMs: Date.now() - started },
        });
      }

      io.writeJson(envelope);
    });
}

async function createDoctorReport(config: ResolvedConfig): Promise<DoctorReport> {
  const [searchProviders, materialProviders, registry, workspace, installation, providerLifecycle, externalStatic] = await Promise.all([
    listInstalledProviders(config.providers.installDir),
    listInstalledMaterialProviders(config.providers.installDir),
    inspectRegistryReachability(config.providers.registryUrl, config.meta.cwd),
    checkWorkspaceWritability(config.workspace.root),
    inspectInstallHealth(),
    inspectProviderLifecycleHealth(config.providers.installDir),
    inspectExternalSearchStatic(),
  ]);
  let externalSearch: DoctorReport["externalSearch"] = externalStatic;
  if (externalStatic.state === "configured") {
    try {
      const probe = await probeExternalSearch();
      externalSearch = probe.ok
        ? {
            state: "ready",
            enabled: true,
            configPath: externalStatic.configPath,
            reason: "External Search v1 no-network probe succeeded",
            tool: probe.data.tool,
          }
        : probe.error.code === "adapter_invalid"
          ? {
              state: "adapter-invalid",
              enabled: true,
              configPath: externalStatic.configPath,
              reason: probe.error.message,
            }
          : { ...externalStatic, reason: probe.error.message };
    } catch (error) {
      const code = error instanceof ExternalSearchError ? error.code : "protocol_schema_mismatch";
      externalSearch = code === "adapter_invalid"
        ? {
            state: "adapter-invalid",
            enabled: true,
            configPath: externalStatic.configPath,
            reason: formatError(error),
          }
        : ["malformed_json", "protocol_schema_mismatch", "protocol_incompatible", "request_id_mismatch", "operation_mismatch"].includes(code)
          ? {
              state: "protocol-incompatible",
              enabled: true,
              configPath: externalStatic.configPath,
              reason: formatError(error),
            }
          : { ...externalStatic, reason: formatError(error) };
    }
  }
  const smoke = resolveSmokePolicy(config.smoke, process.env);
  const apiKeys = collectApiKeyReport(config, searchProviders, materialProviders);
  const validSearchPaths = new Set(searchProviders.filter((entry) => entry.valid).map((entry) => path.resolve(entry.path)));
  const validMaterialPaths = new Set(materialProviders.filter((entry) => entry.valid).map((entry) => path.resolve(entry.path)));
  const endpoint =
    config.server.transport === "http"
      ? `http://${config.server.host}:${config.server.port}/mcp`
      : "stdio";

  return {
    installation: {
      checkout: installation.paths.repoRoot,
      buildPresent: Boolean(installation.build),
      installStatePresent: Boolean(installation.install),
      checkoutMatches: installation.checkoutMatches,
      launcherProtocolMatches:
        installation.build && installation.install
          ? installation.build.launcherProtocol === installation.install.launcherProtocol
          : null,
      projections: {
        healthy: installation.projections.filter((entry) => entry.healthy).length,
        total: installation.projections.length,
      },
      shims: {
        healthy: installation.shims.filter((entry) => entry.healthy).length,
        total: installation.shims.length,
      },
      binRoot: installation.path.binRoot,
      binOnPath: installation.path.onPath,
      health: installation.summary,
      checks: installation.checks,
    },
    providerInstallDir: config.providers.installDir,
    registry,
    manifestHealth: {
      searchProviders: summarizeProviderHealth(searchProviders, validMaterialPaths),
      materialProviders: summarizeProviderHealth(materialProviders, validSearchPaths),
    },
    providerLifecycle,
    workspace,
    externalSearch,
    mcp: {
      ready: config.server.transport === "stdio" || Boolean(config.server.host && config.server.port),
      config: {
        enabled: config.server.enabled,
        transport: config.server.transport,
        host: config.server.host,
        port: config.server.port,
        endpoint,
      },
      status: {
        protocolVersion: "2024-11-05",
        initialized: false,
        serverInfo: { name: "paper-search-cli-mcp", version: getSystemVersion() },
        toolsAvailable: getCanonicalToolNames().filter(
          (name) => name !== "web_search" || externalStatic.state === "configured",
        ).length,
      },
    },
    smoke: {
      enabled: smoke.enabled,
      envVar: smoke.envVar,
      envPresent: smoke.rawEnvValue.trim().length > 0,
      reason: smoke.reason,
    },
    apiKeys,
  };
}

function summarizeProviderHealth(
  providers: Array<InstalledProviderSummary | InstalledMaterialProviderSummary>,
  excludeInvalidPaths: ReadonlySet<string> = new Set(),
): ProviderManifestHealth {
  const relevantProviders = providers.filter(
    (entry) => entry.valid || !excludeInvalidPaths.has(path.resolve(entry.path)),
  );
  const invalidProviders = relevantProviders
    .filter((entry) => !entry.valid)
    .map((entry) => ({
      id: entry.id,
      path: entry.path,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  return {
    total: relevantProviders.length,
    valid: relevantProviders.length - invalidProviders.length,
    invalid: invalidProviders.length,
    invalidProviders,
  };
}

async function inspectRegistryReachability(source: string, cwd: string): Promise<RegistryReachability> {
  const sanitizedSource = sanitizeRegistrySource(source);
  if (/^https?:\/\//iu.test(source)) {
    return {
      source: sanitizedSource,
      kind: "url",
      checked: false,
      reachable: null,
      reason: "Remote registry URL was not fetched by doctor.",
    };
  }

  const local = resolveLocalRegistrySource(source, cwd);
  try {
    await access(local.path, constants.R_OK);
    const raw = await readFile(local.path, "utf8");
    const parsed = JSON.parse(raw) as { providers?: unknown };
    const providerCount = Array.isArray(parsed.providers) ? parsed.providers.length : undefined;
    return {
      source: sanitizedSource,
      kind: local.kind,
      checked: true,
      reachable: true,
      reason: providerCount === undefined ? "Registry file is readable JSON." : "Registry file is readable.",
      resolvedPath: local.path,
      ...(providerCount !== undefined ? { providerCount } : {}),
    };
  } catch (error) {
    return {
      source: sanitizedSource,
      kind: local.kind,
      checked: true,
      reachable: false,
      reason: formatError(error),
      resolvedPath: local.path,
    };
  }
}

function resolveLocalRegistrySource(source: string, cwd: string): { kind: "local" | "file"; path: string } {
  if (/^file:/iu.test(source)) {
    return { kind: "file", path: fileURLToPath(source) };
  }
  return { kind: "local", path: path.isAbsolute(source) ? source : path.resolve(cwd, source) };
}

async function checkWorkspaceWritability(root: string): Promise<WorkspaceWritability> {
  const workspaceRoot = path.resolve(root);
  const checkedPath = path.join(workspaceRoot, `.paper-search-doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(checkedPath, "doctor\n", "utf8");
    await unlink(checkedPath);
    return { root: workspaceRoot, writable: true, checkedPath };
  } catch (error) {
    await unlink(checkedPath).catch(() => undefined);
    return { root: workspaceRoot, writable: false, checkedPath, error: formatError(error) };
  }
}

function collectApiKeyReport(
  config: ResolvedConfig,
  searchProviders: InstalledProviderSummary[],
  materialProviders: InstalledMaterialProviderSummary[],
): { known: ApiKeyReportEntry[]; missing: ApiKeyReportEntry[] } {
  const entries = new Map<string, ApiKeyReportEntry>();

  for (const [providerId, section] of Object.entries(config.api)) {
    for (const [key, value] of Object.entries(getRecord(section))) {
      if (!SECRET_KEY_RE.test(key)) continue;
      if (RETIRED_WEB_API_SECTIONS.has(providerId) && !hasConfigValue(value)) continue;
      addApiKeyEntry(entries, {
        scope: "api",
        providerId,
        key,
        status: hasConfigValue(value) ? "present" : "missing",
        masked: hasConfigValue(value),
        source: "config",
        ...(RETIRED_WEB_API_SECTIONS.has(providerId) ? { unused: true } : {}),
      });
    }
  }

  for (const provider of searchProviders) {
    if (!provider.valid || !provider.manifest?.configSchema) continue;
    const providerConfig = getRecord(config.platform[provider.id]);
    for (const [key, field] of Object.entries(provider.manifest.configSchema)) {
      if (!field.secret && !SECRET_KEY_RE.test(key)) continue;
      const present = hasConfigValue(providerConfig[key]);
      addApiKeyEntry(entries, {
        scope: "platform",
        providerId: provider.id,
        key,
        status: present ? "present" : "missing",
        masked: present,
        source: "config",
      });
    }
  }

  for (const provider of materialProviders) {
    if (!provider.valid || !provider.manifest?.configSchema) continue;
    const providerConfig = getRecord(config.platform[provider.id]);
    for (const [key, field] of Object.entries(provider.manifest.configSchema)) {
      if (field.type !== "secret" && !SECRET_KEY_RE.test(key)) continue;
      const configPresent = hasConfigValue(providerConfig[key]);
      const envName = (field.env ?? []).find((name) => hasConfigValue(process.env[name]));
      const present = configPresent || Boolean(envName);
      addApiKeyEntry(entries, {
        scope: "material",
        providerId: provider.id,
        key,
        status: present ? "present" : "missing",
        masked: present,
        source: configPresent ? "config" : envName ? "env" : undefined,
        ...(envName ? { env: envName } : {}),
      });
    }
  }

  const all = [...entries.values()]
    .map((entry) => (entry.masked ? { ...entry, value: "<masked>" as const } : entry))
    .sort(compareApiKeyEntries);
  return {
    known: all.filter((entry) => entry.status === "present"),
    missing: all.filter((entry) => entry.status === "missing"),
  };
}

function addApiKeyEntry(entries: Map<string, ApiKeyReportEntry>, entry: ApiKeyReportEntry): void {
  const id = `${entry.scope}:${entry.providerId}:${entry.key}`;
  const existing = entries.get(id);
  if (!existing || (existing.status === "missing" && entry.status === "present")) {
    entries.set(id, entry);
  }
}

function compareApiKeyEntries(left: ApiKeyReportEntry, right: ApiKeyReportEntry): number {
  return (
    left.scope.localeCompare(right.scope) ||
    left.providerId.localeCompare(right.providerId) ||
    left.key.localeCompare(right.key)
  );
}

function getRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasConfigValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== undefined && value !== null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
