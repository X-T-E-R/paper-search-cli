import { describe, expect, it, vi } from "vitest";
import {
  createPlanEnvelope,
  PlanValidationError,
  type PlannedOperationStep,
} from "../../src/surface/plan.js";
import { isResultEnvelope } from "../../src/surface/resultEnvelope.js";

function materialIngestSteps(): PlannedOperationStep[] {
  return [
    {
      id: "resolve-input",
      action: "read",
      description: "Resolve the source item before choosing artifact work.",
      targetPaths: ["workspace/items.jsonl"],
    },
    {
      id: "download-artifact",
      action: "network",
      description: "Fetch the artifact bytes through the selected provider.",
      providerId: "fixture-downloader",
      targetPaths: ["workspace/artifacts/item-1.pdf"],
    },
    {
      id: "record-artifact",
      action: "write",
      description: "Record artifact provenance in the local workspace.",
      targetPaths: ["workspace/artifacts.jsonl", "workspace/artifacts/item-1.pdf"],
    },
  ];
}

describe("shared plan envelope", () => {
  it("returns a planned ResultEnvelope with stable plan data", () => {
    const env = createPlanEnvelope({
      capability: "orchestrate",
      tool: "material_ingest",
      selectedPolicy: "workspace-safe",
      selectedProvider: {
        id: "fixture-downloader",
        kind: "material",
        capabilities: ["acquire", "extract"],
      },
      targetPaths: ["workspace/artifacts/item-1.pdf"],
      intendedSteps: materialIngestSteps(),
      diagnostics: { elapsedMs: 0 },
      warnings: ["full-text extraction will run as a later step"],
      provenance: { configPaths: ["paper-search.toml"] },
    });

    expect(isResultEnvelope(env)).toBe(true);
    expect(env.ok).toBe(true);
    expect(env.planned).toBe(true);
    expect(env.capability).toBe("orchestrate");
    expect(env.tool).toBe("material_ingest");
    expect(env.data).not.toBeNull();
    if (!env.data) throw new Error("expected plan data");
    expect(env.data.selectedPolicy).toBe("workspace-safe");
    expect(env.data.selectedProvider).toEqual({
      id: "fixture-downloader",
      kind: "material",
      capabilities: ["acquire", "extract"],
    });
    expect(env.data.intendedSteps.map((step) => step.id)).toEqual([
      "resolve-input",
      "download-artifact",
      "record-artifact",
    ]);
    expect(env.data.targetPaths).toEqual([
      "workspace/artifacts/item-1.pdf",
      "workspace/items.jsonl",
      "workspace/artifacts.jsonl",
    ]);
    expect(env.provenance).toEqual({
      configPaths: ["paper-search.toml"],
      providerIds: ["fixture-downloader"],
      policy: "workspace-safe",
    });
    expect(env.warnings).toEqual(["full-text extraction will run as a later step"]);
  });

  it("does not execute write or network callbacks on a dry-run plan path", () => {
    const writeRecord = vi.fn(() => {
      throw new Error("write callback should not run");
    });
    const fetchBytes = vi.fn(() => {
      throw new Error("network callback should not run");
    });

    function runWithDryRun(enabled: boolean) {
      if (enabled) {
        return createPlanEnvelope({
          capability: "acquire",
          tool: "artifact_download",
          selectedPolicy: "workspace-safe",
          selectedProvider: { id: "fixture-downloader", kind: "material" },
          intendedSteps: [
            {
              id: "fetch-artifact",
              action: "network",
              description: "Fetch artifact bytes.",
              targetPaths: ["workspace/artifacts/item-1.pdf"],
            },
            {
              id: "write-artifact-record",
              action: "write",
              description: "Write artifact metadata.",
              targetPaths: ["workspace/artifacts.jsonl"],
            },
          ],
        });
      }
      fetchBytes();
      writeRecord();
      throw new Error("execution path is outside this dry-run assertion");
    }

    const env = runWithDryRun(true);

    expect(env.planned).toBe(true);
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it("rejects invalid plan contracts before producing an envelope", () => {
    expect(() =>
      createPlanEnvelope({
        capability: "download" as never,
        tool: "artifact_download",
        selectedProvider: { id: "fixture-downloader", kind: "material" },
        intendedSteps: materialIngestSteps(),
      }),
    ).toThrow(PlanValidationError);

    expect(() =>
      createPlanEnvelope({
        capability: "acquire",
        tool: "",
        selectedProvider: { id: "fixture-downloader", kind: "material" },
        intendedSteps: materialIngestSteps(),
      }),
    ).toThrow("tool must be a non-empty string");

    expect(() =>
      createPlanEnvelope({
        capability: "acquire",
        tool: "artifact_download",
        selectedProvider: { id: "fixture-downloader", kind: "material" },
        intendedSteps: [],
      }),
    ).toThrow("intendedSteps must be a non-empty array");
  });
});
