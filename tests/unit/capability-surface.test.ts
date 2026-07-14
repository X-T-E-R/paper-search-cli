import { describe, expect, it } from "vitest";
import {
  CAPABILITY_GROUPS,
  CAPABILITY_MAP,
  getCapabilityGroups,
  isCapabilityGroup,
} from "../../src/surface/capabilities.js";
import {
  failEnvelope,
  isResultEnvelope,
  okEnvelope,
} from "../../src/surface/resultEnvelope.js";

describe("capability map", () => {
  it("describes every declared group exactly once", () => {
    for (const group of CAPABILITY_GROUPS) {
      expect(CAPABILITY_MAP[group]).toBeDefined();
      expect(CAPABILITY_MAP[group].group).toBe(group);
      expect(CAPABILITY_MAP[group].summary.length).toBeGreaterThan(0);
    }
    expect(Object.keys(CAPABILITY_MAP).sort()).toEqual([...CAPABILITY_GROUPS].sort());
  });

  it("keeps operate as the only management-layer group", () => {
    const management = getCapabilityGroups().filter(
      (group) => CAPABILITY_MAP[group].layer === "management",
    );
    expect(management).toEqual(["operate"]);
  });

  it("recognizes valid and invalid group names", () => {
    expect(isCapabilityGroup("discover")).toBe(true);
    expect(isCapabilityGroup("download")).toBe(false);
  });
});

describe("result envelope", () => {
  it("builds an ok envelope and omits empty optional fields", () => {
    const env = okEnvelope({ capability: "discover", tool: "academic_search", data: { items: [] } });
    expect(env.ok).toBe(true);
    expect(env.capability).toBe("discover");
    expect(env.tool).toBe("academic_search");
    expect(env.data).toEqual({ items: [] });
    expect("warnings" in env).toBe(false);
    expect("planned" in env).toBe(false);
    expect(isResultEnvelope(env)).toBe(true);
  });

  it("carries planned, diagnostics, warnings, and provenance when provided", () => {
    const env = okEnvelope({
      capability: "orchestrate",
      tool: "material_ingest",
      data: { steps: 3 },
      planned: true,
      diagnostics: { sourceCounts: { crossref: 5 }, failedSources: ["arxiv"] },
      warnings: ["arxiv timed out"],
      provenance: { providerIds: ["mineru-extractor"], policy: "default" },
    });
    expect(env.planned).toBe(true);
    expect(env.diagnostics?.failedSources).toEqual(["arxiv"]);
    expect(env.warnings).toEqual(["arxiv timed out"]);
    expect(env.provenance?.providerIds).toEqual(["mineru-extractor"]);
  });

  it("builds a failure envelope with null data and errors", () => {
    const env = failEnvelope({
      capability: "acquire",
      tool: "artifact_download",
      errors: ["no accessible URL"],
    });
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.errors).toEqual(["no accessible URL"]);
    expect(isResultEnvelope(env)).toBe(true);
  });

  it("rejects non-envelope values", () => {
    expect(isResultEnvelope(null)).toBe(false);
    expect(isResultEnvelope({ ok: true })).toBe(false);
    expect(isResultEnvelope({ ok: true, capability: "discover", tool: "x" })).toBe(false);
  });
});
