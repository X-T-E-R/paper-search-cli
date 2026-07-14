import { describe, expect, it } from "vitest";
import { expandRegistryUrlCandidates } from "../../src/providers/registry/urlCandidates.js";

describe("expandRegistryUrlCandidates", () => {
  it("keeps explicit JSON URLs unchanged", () => {
    expect(expandRegistryUrlCandidates("https://example.com/registry.json")).toEqual([
      "https://example.com/registry.json",
    ]);
  });

  it("expands GitHub repository URLs into release and raw candidates", () => {
    expect(expandRegistryUrlCandidates("https://github.com/X-T-E-R/resource-search-providers")).toEqual([
      "https://github.com/X-T-E-R/resource-search-providers/releases/download/providers-registry-latest/registry.json",
      "https://github.com/X-T-E-R/resource-search-providers/releases/latest/download/registry.json",
      "https://raw.githubusercontent.com/X-T-E-R/resource-search-providers/main/registry.json",
      "https://raw.githubusercontent.com/X-T-E-R/resource-search-providers/master/registry.json",
    ]);
  });
});
