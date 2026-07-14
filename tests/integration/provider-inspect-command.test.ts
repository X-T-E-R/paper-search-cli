import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";
import { isResultEnvelope } from "../../src/surface/resultEnvelope.js";

const fixturePackagePath = path.resolve(
  "tests",
  "fixtures",
  "provider-packages",
  "fixture-academic",
);

describe("providers inspect-package command", () => {
  it("reports runtime capabilities for a built provider package", async () => {
    let stdout = "";
    let stderr = "";

    await buildProgram({
      stdout: {
        write(chunk: string) {
          stdout += chunk;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
        },
      },
    }).parseAsync(["node", "paper-search", "providers", "inspect-package", fixturePackagePath, "--json"]);

    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(isResultEnvelope(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      capability: "operate",
      tool: "provider_inspect_package",
    });
    expect(parsed.data.manifest.id).toBe("fixture-academic");
    expect(parsed.data.inspection.hasSearch).toBe(true);
    expect(parsed.data.inspection.hasGetDetail).toBe(false);
  });
});
