import {
  AccessClassSchema,
  BUILT_IN_SEARCH_PRESET_NAMES,
  ContentKindSchema,
  SourceDomainSchema,
  type ResolvedConfig,
} from "../config/schema.js";
import { resolveProviderAvailability } from "../providers/runtime/availability.js";
import type { ProviderIntent } from "../providers/runtime/availability.js";
import type { ProviderManifest, SourceType } from "../providers/sdk/types.js";

export const BUILTIN_PRESET_NAMES = BUILT_IN_SEARCH_PRESET_NAMES;

export type BuiltinPresetName = (typeof BUILTIN_PRESET_NAMES)[number];

export interface ProviderSelectionRequest {
  /** Legacy singular selector. `all` keeps its literal meaning. */
  platform?: string;
  /** Legacy CLI alias of platform. */
  provider?: string;
  presets?: readonly string[];
  sources?: readonly string[];
  categories?: readonly string[];
  excludeSources?: readonly string[];
  excludeCategories?: readonly string[];
}

export interface ProviderSelectionCandidate {
  id: string;
  version?: string;
  /** Omitted by legacy callers; installed summaries default to true. */
  installed?: boolean;
  valid: boolean;
  error?: string;
  manifest?: ProviderManifest;
  catalogReadinessReasons?: readonly string[];
}

export interface ProviderSelectionPlanEntry {
  id: string;
  aliases: string[];
  sourceType: SourceType;
  entryKind: "source" | "view";
  installed: boolean;
  selected: boolean;
  runnable: boolean;
  configured: boolean;
  enabled: boolean;
  intent: ProviderIntent;
  selectionReasons: string[];
  exclusionReasons: string[];
  readinessReasons: string[];
  missingConfigKeys: string[];
}

export interface ProviderSelectionPlan {
  sourceType: SourceType;
  usedDefaults: boolean;
  defaultPresets: string[];
  requested: {
    presets: string[];
    sources: string[];
    categories: string[];
    excludeSources: string[];
    excludeCategories: string[];
  };
  selectedProviderIds: string[];
  runnableProviderIds: string[];
  skippedProviderIds: string[];
  entries: ProviderSelectionPlanEntry[];
  warnings: string[];
}

export interface ProviderSelectionDecision {
  included: boolean;
  reason: string;
}

interface UserClassificationDefinition {
  sources: readonly string[];
}

interface UserPresetDefinition {
  extends?: readonly string[];
  include?: readonly string[];
  exclude?: readonly string[];
}

interface SearchConfigView {
  defaultAcademicPresets?: readonly string[];
  defaultPatentPresets?: readonly string[];
  classifications?: Record<string, UserClassificationDefinition>;
  presets?: Record<string, UserPresetDefinition>;
  selection: {
    mode: "defaults" | "allowlist";
    includeIds: readonly string[];
    excludeIds: readonly string[];
    includeDomains: readonly string[];
    excludeDomains: readonly string[];
    includeContentKinds: readonly string[];
    excludeContentKinds: readonly string[];
    includeAccess: readonly string[];
    excludeAccess: readonly string[];
  };
}

interface BuiltinPresetDefinition extends UserPresetDefinition {
  sourceTypes: readonly SourceType[];
  publishedOnly: true;
}

interface CandidateIndex {
  all: readonly ProviderSelectionCandidate[];
  byCanonicalId: Map<string, ProviderSelectionCandidate>;
  aliases: Map<string, ProviderSelectionCandidate[]>;
}

interface ExpandedSelection {
  ids: Set<string>;
  reasons: Map<string, Set<string>>;
}

interface ExpansionContext {
  config: ResolvedConfig;
  search: SearchConfigView;
  sourceType: SourceType;
  candidates: CandidateIndex;
  warnings: string[];
  presetCache: Map<string, ExpandedSelection>;
}

const SOURCE_DOMAINS = new Set<string>(SourceDomainSchema.options);
const CONTENT_KINDS = new Set<string>(ContentKindSchema.options);
const ACCESS_CLASSES = new Set<string>(AccessClassSchema.options);

const BUILTIN_PRESETS: Record<BuiltinPresetName, BuiltinPresetDefinition> = {
  general: {
    sourceTypes: ["academic"],
    publishedOnly: true,
    include: ["domain:multidisciplinary"],
  },
  "computer-science": {
    sourceTypes: ["academic"],
    publishedOnly: true,
    include: ["domain:computer-science"],
  },
  biomedicine: {
    sourceTypes: ["academic"],
    publishedOnly: true,
    include: ["domain:biomedicine", "domain:life-sciences"],
  },
  preprints: {
    sourceTypes: ["academic"],
    publishedOnly: true,
    include: ["content:preprint"],
  },
  repositories: {
    sourceTypes: ["academic"],
    publishedOnly: true,
    include: ["content:repository-record"],
  },
  publishers: {
    sourceTypes: ["academic"],
    publishedOnly: true,
    include: ["source:ieee", "source:sciencedirect", "source:springer"],
  },
  patents: {
    sourceTypes: ["patent"],
    publishedOnly: true,
    include: ["domain:patents"],
  },
};

function searchConfig(config: ResolvedConfig): SearchConfigView {
  // The config package owns validation and defaults. This structural view keeps
  // selection independent from Zod implementation details while legacy configs
  // are still supported during the migration cycle.
  return config.search as SearchConfigView;
}

function emptySelection(): ExpandedSelection {
  return { ids: new Set(), reasons: new Map() };
}

function cloneSelection(selection: ExpandedSelection): ExpandedSelection {
  return {
    ids: new Set(selection.ids),
    reasons: new Map(
      [...selection.reasons].map(([id, reasons]) => [id, new Set(reasons)]),
    ),
  };
}

function addSelection(
  selection: ExpandedSelection,
  id: string,
  reason: string,
): void {
  selection.ids.add(id);
  const reasons = selection.reasons.get(id) ?? new Set<string>();
  reasons.add(reason);
  selection.reasons.set(id, reasons);
}

function unionSelection(
  target: ExpandedSelection,
  source: ExpandedSelection,
  reasonPrefix?: string,
): void {
  for (const id of source.ids) {
    const sourceReasons = source.reasons.get(id) ?? new Set(["selected"]);
    for (const reason of sourceReasons) {
      addSelection(target, id, reasonPrefix ? `${reasonPrefix}: ${reason}` : reason);
    }
  }
}

function removeIds(selection: ExpandedSelection, ids: Iterable<string>): void {
  for (const id of ids) {
    selection.ids.delete(id);
    selection.reasons.delete(id);
  }
}

function createCandidateIndex(
  providers: readonly ProviderSelectionCandidate[],
): CandidateIndex {
  const byCanonicalId = new Map<string, ProviderSelectionCandidate>();
  const aliases = new Map<string, ProviderSelectionCandidate[]>();
  for (const provider of providers) {
    byCanonicalId.set(provider.id, provider);
    for (const alias of provider.manifest?.inventory?.aliases ?? []) {
      const matches = aliases.get(alias) ?? [];
      matches.push(provider);
      aliases.set(alias, matches);
    }
  }
  return { all: providers, byCanonicalId, aliases };
}

function resolveCanonicalProvider(
  candidates: CandidateIndex,
  requestedId: string,
): ProviderSelectionCandidate | undefined {
  const canonical = candidates.byCanonicalId.get(requestedId);
  const aliases = candidates.aliases.get(requestedId) ?? [];
  const matches = [...(canonical ? [canonical] : []), ...aliases].filter(
    (entry, index, entries) => entries.findIndex((candidate) => candidate.id === entry.id) === index,
  );
  if (matches.length > 1) {
    throw new Error(
      `Provider selector is ambiguous: ${requestedId} -> ${matches
        .map((entry) => entry.id)
        .sort((left, right) => left.localeCompare(right))
        .join(", ")}`,
    );
  }
  return matches[0];
}

function isSourceCandidate(
  provider: ProviderSelectionCandidate,
  sourceType: SourceType,
): boolean {
  return provider.manifest?.sourceType === sourceType;
}

function isView(provider: ProviderSelectionCandidate): boolean {
  return provider.manifest?.inventory?.entryKind === "view";
}

function isPublished(provider: ProviderSelectionCandidate): boolean {
  return provider.manifest?.inventory?.publication.status === "published";
}

function addPortableSource(
  context: ExpansionContext,
  selection: ExpandedSelection,
  requestedId: string,
  reason: string,
  options: { allowView: boolean; warnWhenMissing: boolean },
): void {
  const provider = resolveCanonicalProvider(context.candidates, requestedId);
  if (!provider) {
    if (options.warnWhenMissing) {
      context.warnings.push(`Configured source is not installed: ${requestedId}`);
    }
    return;
  }
  if (!isSourceCandidate(provider, context.sourceType)) {
    if (options.warnWhenMissing) {
      context.warnings.push(
        `Configured source does not match ${context.sourceType}: ${requestedId}`,
      );
    }
    return;
  }
  if (!options.allowView && isView(provider)) {
    if (options.warnWhenMissing) {
      context.warnings.push(`Configured source is a view and was ignored by ${reason}: ${requestedId}`);
    }
    return;
  }
  const aliasReason = provider.id === requestedId ? reason : `${reason} (${requestedId} -> ${provider.id})`;
  addSelection(selection, provider.id, aliasReason);
}

function resolveRequestSource(
  context: ExpansionContext,
  requestedId: string,
): ProviderSelectionCandidate {
  const provider = resolveCanonicalProvider(context.candidates, requestedId);
  if (!provider) {
    throw new Error(`${context.sourceType} provider is not installed: ${requestedId}`);
  }
  if (!provider.valid) {
    return provider;
  }
  if (provider.manifest?.sourceType !== context.sourceType) {
    throw new Error(
      `Provider ${requestedId} is ${provider.manifest?.sourceType ?? "unknown"}, not ${context.sourceType}`,
    );
  }
  return provider;
}

function matchingCategoryIds(
  context: ExpansionContext,
  selector: string,
): Set<string> {
  const separator = selector.indexOf(":");
  if (separator <= 0 || separator === selector.length - 1) {
    throw new Error(`Category selector must use namespace:value syntax: ${selector}`);
  }
  const namespace = selector.slice(0, separator);
  const value = selector.slice(separator + 1);

  if (namespace === "tag") {
    const classification = context.search.classifications?.[value];
    if (!classification) {
      throw new Error(`Unknown user classification: ${value}`);
    }
    const selection = emptySelection();
    for (const source of classification.sources) {
      addPortableSource(context, selection, source, `tag:${value}`, {
        allowView: false,
        warnWhenMissing: true,
      });
    }
    return selection.ids;
  }

  if (namespace === "domain" && !SOURCE_DOMAINS.has(value)) {
    throw new Error(`Unknown source domain: ${value}`);
  }
  if (namespace === "content" && !CONTENT_KINDS.has(value)) {
    throw new Error(`Unknown content kind: ${value}`);
  }
  if (namespace === "access" && !ACCESS_CLASSES.has(value)) {
    throw new Error(`Unknown access class: ${value}`);
  }
  if (namespace === "type" && !["academic", "patent", "web"].includes(value)) {
    throw new Error(`Unknown source type: ${value}`);
  }
  if (namespace === "transport" && !["api", "html"].includes(value)) {
    throw new Error(`Unknown transport: ${value}`);
  }
  if (!["domain", "content", "access", "type", "transport"].includes(namespace)) {
    throw new Error(`Unknown category namespace: ${namespace}`);
  }

  const ids = new Set<string>();
  for (const provider of context.candidates.all) {
    if (!isSourceCandidate(provider, context.sourceType) || isView(provider)) continue;
    const manifest = provider.manifest!;
    const inventory = manifest.inventory;
    const matched =
      namespace === "domain"
        ? inventory?.domains.includes(value as never)
        : namespace === "content"
          ? inventory?.contentKinds.includes(value as never)
          : namespace === "access"
            ? inventory?.access.includes(value as never)
            : namespace === "type"
              ? manifest.sourceType === value
              : inventory?.transport === value;
    if (matched) ids.add(provider.id);
  }
  return ids;
}

function addCategory(
  context: ExpansionContext,
  selection: ExpandedSelection,
  selector: string,
  reasonPrefix?: string,
): void {
  for (const id of matchingCategoryIds(context, selector)) {
    addSelection(
      selection,
      id,
      reasonPrefix ? `${reasonPrefix}: category:${selector}` : `category:${selector}`,
    );
  }
}

function partitionSelectors(selectors: readonly string[]): {
  sources: string[];
  categories: string[];
} {
  const sources: string[] = [];
  const categories: string[] = [];
  for (const selector of selectors) {
    if (selector.startsWith("source:")) {
      const id = selector.slice("source:".length);
      if (!id) throw new Error(`Source selector is missing an id: ${selector}`);
      sources.push(id);
      continue;
    }
    if (selector.startsWith("preset:")) {
      throw new Error(`Use extends for preset composition: ${selector}`);
    }
    categories.push(selector);
  }
  return { sources, categories };
}

function getPresetDefinition(
  context: ExpansionContext,
  name: string,
): { definition: UserPresetDefinition; builtIn: boolean; publishedOnly: boolean } {
  if ((BUILTIN_PRESET_NAMES as readonly string[]).includes(name)) {
    const definition = BUILTIN_PRESETS[name as BuiltinPresetName];
    return {
      definition,
      builtIn: true,
      publishedOnly: definition.publishedOnly,
    };
  }
  const definition = context.search.presets?.[name];
  if (!definition) throw new Error(`Unknown search preset: ${name}`);
  return { definition, builtIn: false, publishedOnly: false };
}

function expandPreset(
  context: ExpansionContext,
  name: string,
  stack: readonly string[] = [],
): ExpandedSelection {
  const cached = context.presetCache.get(name);
  if (cached) return cloneSelection(cached);
  if (stack.includes(name)) {
    throw new Error(`Search preset inheritance cycle: ${[...stack, name].join(" -> ")}`);
  }

  const { definition, builtIn, publishedOnly } = getPresetDefinition(context, name);
  if (builtIn) {
    const builtin = definition as BuiltinPresetDefinition;
    if (!builtin.sourceTypes.includes(context.sourceType)) {
      context.warnings.push(`Preset ${name} does not apply to ${context.sourceType}`);
      return emptySelection();
    }
  }

  const selection = emptySelection();
  for (const parent of definition.extends ?? []) {
    unionSelection(
      selection,
      expandPreset(context, parent, [...stack, name]),
      `preset:${name} extends preset:${parent}`,
    );
  }

  const included = partitionSelectors(definition.include ?? []);
  for (const category of included.categories) {
    addCategory(context, selection, category, `preset:${name}`);
  }

  const excluded = partitionSelectors(definition.exclude ?? []);
  for (const category of excluded.categories) {
    removeIds(selection, matchingCategoryIds(context, category));
  }

  for (const source of included.sources) {
    addPortableSource(context, selection, source, `preset:${name} source:${source}`, {
      allowView: !builtIn,
      warnWhenMissing: !builtIn,
    });
  }
  for (const source of excluded.sources) {
    const provider = resolveCanonicalProvider(context.candidates, source);
    if (provider) removeIds(selection, [provider.id]);
  }

  if (publishedOnly) {
    removeIds(
      selection,
      [...selection.ids].filter((id) => {
        const provider = context.candidates.byCanonicalId.get(id);
        return !provider || !isPublished(provider);
      }),
    );
  }

  context.presetCache.set(name, cloneSelection(selection));
  return selection;
}

function commandDefaultPresets(
  search: SearchConfigView,
  sourceType: SourceType,
): string[] {
  if (sourceType === "academic") {
    return [...(search.defaultAcademicPresets ?? ["general"])];
  }
  if (sourceType === "patent") {
    return [...(search.defaultPatentPresets ?? ["patents"])];
  }
  return [];
}

function expandAll(context: ExpansionContext): ExpandedSelection {
  const selection = emptySelection();
  for (const provider of context.candidates.all) {
    if (
      provider.installed === false ||
      !provider.valid ||
      !isSourceCandidate(provider, context.sourceType) ||
      isView(provider) ||
      !readinessReasons(context.config, provider).runnable
    ) continue;
    addSelection(selection, provider.id, "all runnable non-view sources");
  }
  return selection;
}

function applyLegacyDefaultPolicy(
  context: ExpansionContext,
  defaults: ExpandedSelection,
): ExpandedSelection {
  const policy = context.search.selection;
  const selection = policy.mode === "defaults" ? cloneSelection(defaults) : emptySelection();

  for (const domain of policy.includeDomains) addCategory(context, selection, `domain:${domain}`, "legacy selection");
  for (const content of policy.includeContentKinds) addCategory(context, selection, `content:${content}`, "legacy selection");
  for (const access of policy.includeAccess) addCategory(context, selection, `access:${access}`, "legacy selection");

  for (const domain of policy.excludeDomains) removeIds(selection, matchingCategoryIds(context, `domain:${domain}`));
  for (const content of policy.excludeContentKinds) removeIds(selection, matchingCategoryIds(context, `content:${content}`));
  for (const access of policy.excludeAccess) removeIds(selection, matchingCategoryIds(context, `access:${access}`));

  for (const source of policy.includeIds) {
    addPortableSource(context, selection, source, `legacy selection source:${source}`, {
      allowView: true,
      warnWhenMissing: true,
    });
  }
  for (const source of policy.excludeIds) {
    const provider = resolveCanonicalProvider(context.candidates, source);
    if (provider) removeIds(selection, [provider.id]);
  }
  return selection;
}

function readinessReasons(
  config: ResolvedConfig,
  provider: ProviderSelectionCandidate,
): {
  enabled: boolean;
  intent: ProviderIntent;
  configured: boolean;
  runnable: boolean;
  missingConfigKeys: string[];
  reasons: string[];
} {
  if (provider.installed === false && provider.manifest) {
    const availability = resolveProviderAvailability(config, provider.manifest);
    return {
      enabled: availability.enabled,
      intent: availability.intent,
      configured: false,
      runnable: false,
      missingConfigKeys: [],
      reasons: [
        "provider package is not installed",
        ...(availability.enabled ? [] : ["provider disabled"]),
        ...(provider.catalogReadinessReasons ?? []),
      ],
    };
  }
  if (!provider.valid || !provider.manifest) {
    return {
      enabled: false,
      intent: "disabled",
      configured: false,
      runnable: false,
      missingConfigKeys: [],
      reasons: [provider.error ? `invalid provider package: ${provider.error}` : "invalid provider package"],
    };
  }
  const availability = resolveProviderAvailability(config, provider.manifest);
  const reasons: string[] = [];
  if (!availability.enabled) reasons.push("provider disabled");
  if (!availability.configured) {
    reasons.push(`missing required config: ${availability.missingConfigKeys.join(", ")}`);
  }
  return {
    enabled: availability.enabled,
    intent: availability.intent,
    configured: availability.configured,
    runnable: provider.valid && availability.available,
    missingConfigKeys: availability.missingConfigKeys,
    reasons,
  };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function resolveProviderSelection(
  config: ResolvedConfig,
  sourceType: SourceType,
  providers: readonly ProviderSelectionCandidate[],
  request: ProviderSelectionRequest = {},
): ProviderSelectionPlan {
  const candidates = createCandidateIndex(providers);
  const search = searchConfig(config);
  const warnings: string[] = [];
  const context: ExpansionContext = {
    config,
    search,
    sourceType,
    candidates,
    warnings,
    presetCache: new Map(),
  };

  const requestedPresets = [...(request.presets ?? [])];
  const requestedSources = [
    ...(request.platform ? [request.platform] : []),
    ...(request.provider ? [request.provider] : []),
    ...(request.sources ?? []),
  ];
  const requestedCategories = [...(request.categories ?? [])];
  const requestedExcludeSources = [...(request.excludeSources ?? [])];
  const requestedExcludeCategories = [...(request.excludeCategories ?? [])];
  const hasPositiveSelectors =
    requestedPresets.length > 0 ||
    requestedSources.length > 0 ||
    requestedCategories.length > 0;
  const defaults = commandDefaultPresets(search, sourceType);
  const selected = emptySelection();

  if (!hasPositiveSelectors) {
    const expandedDefaults = emptySelection();
    for (const preset of defaults) {
      unionSelection(expandedDefaults, expandPreset(context, preset), `default preset:${preset}`);
    }
    unionSelection(selected, applyLegacyDefaultPolicy(context, expandedDefaults));
  } else {
    for (const preset of requestedPresets) {
      unionSelection(selected, expandPreset(context, preset), `request preset:${preset}`);
    }
    for (const category of requestedCategories) {
      addCategory(context, selected, category, "request");
    }
    for (const source of requestedSources.filter((entry) => entry === "all")) {
      unionSelection(selected, expandAll(context), `request source:${source}`);
    }
  }

  const requestExactSources = requestedSources.filter((entry) => entry !== "all");
  const exclusionReasons = new Map<string, Set<string>>();
  for (const category of requestedExcludeCategories) {
    for (const id of matchingCategoryIds(context, category)) {
      if (!selected.ids.has(id)) continue;
      selected.ids.delete(id);
      selected.reasons.delete(id);
      const reasons = exclusionReasons.get(id) ?? new Set<string>();
      reasons.add(`request excluded category:${category}`);
      exclusionReasons.set(id, reasons);
    }
  }

  // Exact source selection is more specific than a category exclusion.
  for (const source of requestExactSources) {
    const provider = resolveRequestSource(context, source);
    addSelection(
      selected,
      provider.id,
      provider.id === source ? `request source:${source}` : `request source:${source} -> ${provider.id}`,
    );
    exclusionReasons.delete(provider.id);
  }

  // Exact request exclusions are the final selection veto.
  for (const source of requestedExcludeSources) {
    const provider = resolveRequestSource(context, source);
    selected.ids.delete(provider.id);
    selected.reasons.delete(provider.id);
    const reasons = exclusionReasons.get(provider.id) ?? new Set<string>();
    reasons.add(`request excluded source:${source}`);
    exclusionReasons.set(provider.id, reasons);
  }

  for (const provider of providers) {
    if (!selected.ids.has(provider.id) || !isView(provider)) continue;
    for (const backingSourceId of provider.manifest?.inventory?.backingSourceIds ?? []) {
      for (const backingProvider of providers) {
        if (
          selected.ids.has(backingProvider.id) &&
          backingProvider.manifest?.inventory?.entryKind === "source" &&
          backingProvider.manifest.inventory.sourceId === backingSourceId
        ) {
          warnings.push(
            `Selected view ${provider.id} overlaps backing source ${backingProvider.id} (${backingSourceId})`,
          );
        }
      }
    }
  }

  const entries: ProviderSelectionPlanEntry[] = [];
  for (const provider of providers) {
    const manifest = provider.manifest;
    const selectedByRequest = selected.ids.has(provider.id);
    if (!selectedByRequest && manifest?.sourceType !== sourceType) continue;
    if (!selectedByRequest && !provider.valid) continue;
    const readiness = readinessReasons(config, provider);
    const providerExclusionReasons = new Set(exclusionReasons.get(provider.id) ?? []);
    if (
      !selectedByRequest &&
      manifest?.sourceType === sourceType &&
      !manifest.inventory
    ) {
      providerExclusionReasons.add(
        "provider has no inventory classification; select it by exact id or literal all",
      );
    }
    entries.push({
      id: provider.id,
      aliases: manifest?.inventory?.aliases ?? [],
      sourceType: manifest?.sourceType ?? sourceType,
      entryKind: manifest?.inventory?.entryKind ?? "source",
      installed: provider.installed !== false,
      selected: selectedByRequest,
      runnable: selectedByRequest && readiness.runnable,
      configured: readiness.configured,
      enabled: readiness.enabled,
      intent: readiness.intent,
      selectionReasons: uniqueSorted(selected.reasons.get(provider.id) ?? []),
      exclusionReasons: uniqueSorted(providerExclusionReasons),
      readinessReasons: readiness.reasons,
      missingConfigKeys: readiness.missingConfigKeys,
    });
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));

  const selectedProviderIds = entries.filter((entry) => entry.selected).map((entry) => entry.id);
  const runnableProviderIds = entries.filter((entry) => entry.runnable).map((entry) => entry.id);
  const skippedProviderIds = entries
    .filter((entry) => entry.selected && !entry.runnable)
    .map((entry) => entry.id);

  return {
    sourceType,
    usedDefaults: !hasPositiveSelectors,
    defaultPresets: !hasPositiveSelectors ? defaults : [],
    requested: {
      presets: requestedPresets,
      sources: requestedSources,
      categories: requestedCategories,
      excludeSources: requestedExcludeSources,
      excludeCategories: requestedExcludeCategories,
    },
    selectedProviderIds,
    runnableProviderIds,
    skippedProviderIds,
    entries,
    warnings: uniqueSorted(warnings),
  };
}

/**
 * Compatibility helper for callers that only need literal `all` membership.
 * Configuration policy no longer changes the meaning of `all`.
 */
export function evaluateProviderInAll(
  _config: ResolvedConfig,
  manifest: ProviderManifest,
): ProviderSelectionDecision {
  if (manifest.inventory?.entryKind === "view") {
    return { included: false, reason: "view excluded from all" };
  }
  return { included: true, reason: "non-view source included in all" };
}

export function resolveExplicitProvider<T extends ProviderSelectionCandidate>(
  providers: readonly T[],
  requestedId: string,
): T | undefined {
  return resolveCanonicalProvider(createCandidateIndex(providers), requestedId) as T | undefined;
}

export function manifestMatchesCategory(
  manifest: ProviderManifest,
  selector: string,
): boolean {
  const inventory = manifest.inventory;
  const [namespace, value, ...rest] = selector.split(":");
  if (!namespace || !value || rest.length > 0 || inventory?.entryKind === "view") return false;
  if (namespace === "domain") return inventory?.domains.includes(value as never) ?? false;
  if (namespace === "content") return inventory?.contentKinds.includes(value as never) ?? false;
  if (namespace === "access") return inventory?.access.includes(value as never) ?? false;
  if (namespace === "type") return manifest.sourceType === value;
  if (namespace === "transport") return inventory?.transport === value;
  return false;
}

export function inventoryIsGeneralMember(
  inventory: {
    sourceType: string;
    entryKind: string;
    publication: { status: string };
    domains: readonly string[];
  } | undefined,
): boolean {
  return Boolean(
    inventory &&
      inventory.sourceType === "academic" &&
      inventory.entryKind === "source" &&
      inventory.publication.status === "published" &&
      inventory.domains.includes("multidisciplinary"),
  );
}
