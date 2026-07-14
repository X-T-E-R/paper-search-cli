/**
 * The capability map is the stable contract the companion skill routes over.
 * Commands, canonical tools, and provider kinds are projections of it. Adding a
 * command or installing a provider must not change this map.
 *
 * See analyses/brainstorm/paper-search-cli-design/research/capability-first-target-shape.md.
 */

export const CAPABILITY_GROUPS = [
  "discover",
  "identify",
  "assess",
  "acquire",
  "extract",
  "organize",
  "orchestrate",
  "operate",
] as const;

export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

export interface CapabilityDescriptor {
  group: CapabilityGroup;
  /** Stable one-line statement of what this group lets a user/agent do. */
  summary: string;
  /** Whether this is research/material work or the management layer. */
  layer: "work" | "management";
}

export const CAPABILITY_MAP: Record<CapabilityGroup, CapabilityDescriptor> = {
  discover: {
    group: "discover",
    summary: "Search academic, patent, and web sources with per-source diagnostics.",
    layer: "work",
  },
  identify: {
    group: "identify",
    summary: "Resolve a known identifier, URL, or provider-native id to normalized metadata.",
    layer: "work",
  },
  assess: {
    group: "assess",
    summary: "Preserve source-backed observations, conflicts, and explicit policy traces without an opaque universal score.",
    layer: "work",
  },
  acquire: {
    group: "acquire",
    summary: "Acquire or record an artifact through installed material providers with provenance and attempt history.",
    layer: "work",
  },
  extract: {
    group: "extract",
    summary: "Turn an artifact, URL, or file into Markdown/JSON/assets via extractor providers.",
    layer: "work",
  },
  organize: {
    group: "organize",
    summary: "Store, tag, collect, and export workspace records.",
    layer: "work",
  },
  orchestrate: {
    group: "orchestrate",
    summary: "Run multi-step workflows over the primitives, with a plan-first option.",
    layer: "work",
  },
  operate: {
    group: "operate",
    summary: "Inspect readiness and config, manage providers, and run the server surface.",
    layer: "management",
  },
};

export function getCapabilityGroups(): CapabilityGroup[] {
  return [...CAPABILITY_GROUPS];
}

export function isCapabilityGroup(value: string): value is CapabilityGroup {
  return (CAPABILITY_GROUPS as readonly string[]).includes(value);
}
