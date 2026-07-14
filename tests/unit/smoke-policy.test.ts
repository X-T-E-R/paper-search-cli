import { describe, expect, it } from "vitest";
import { resolveSmokePolicy } from "../../src/testing/smokePolicy.js";

describe("resolveSmokePolicy", () => {
  it("stays disabled when config disables smoke", () => {
    const result = resolveSmokePolicy(
      { enabled: false, envVar: "PAPER_SEARCH_RUN_SMOKE" },
      { PAPER_SEARCH_RUN_SMOKE: "1" },
    );
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("disabled");
  });

  it("requires the explicit environment switch", () => {
    const result = resolveSmokePolicy(
      { enabled: true, envVar: "PAPER_SEARCH_RUN_SMOKE" },
      { PAPER_SEARCH_RUN_SMOKE: "" },
    );
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("requires");
  });

  it("enables smoke only when both config and env agree", () => {
    const result = resolveSmokePolicy(
      { enabled: true, envVar: "PAPER_SEARCH_RUN_SMOKE" },
      { PAPER_SEARCH_RUN_SMOKE: "true" },
    );
    expect(result.enabled).toBe(true);
  });

  it("accepts explicit truthy gate variants", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      const result = resolveSmokePolicy(
        { enabled: true, envVar: "PAPER_SEARCH_RUN_SMOKE" },
        { PAPER_SEARCH_RUN_SMOKE: value },
      );
      expect(result.enabled).toBe(true);
      expect(result.reason).toContain("explicitly enabled");
    }
  });

  it("keeps default and false-like values disabled", () => {
    for (const value of [undefined, "", "0", "false", "no", "off"]) {
      const result = resolveSmokePolicy(
        { enabled: true, envVar: "PAPER_SEARCH_RUN_SMOKE" },
        value === undefined ? {} : { PAPER_SEARCH_RUN_SMOKE: value },
      );
      expect(result.enabled).toBe(false);
      expect(result.reason).toContain("requires");
    }
  });
});
