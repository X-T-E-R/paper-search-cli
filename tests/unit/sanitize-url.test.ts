import { describe, expect, it } from "vitest";
import { sanitizeUrlForDisplay } from "../../src/runtime/sanitizeUrl.js";

describe("sanitizeUrlForDisplay", () => {
  it("masks credentials in absolute URLs", () => {
    const sanitized = sanitizeUrlForDisplay(
      "https://user:password@example.test/registry.json?api_key=secret&mode=full",
    );
    expect(sanitized).not.toContain("user:password");
    expect(sanitized).not.toContain("api_key=secret");
    expect(sanitized).toContain("api_key=%3Cmasked%3E");
    expect(sanitized).toContain("mode=full");
  });

  it("masks secret-like query values in relative references", () => {
    expect(
      sanitizeUrlForDisplay("./alpha.zip?token=secret&mode=full"),
    ).toBe("./alpha.zip?token=<masked>&mode=full");
  });

  it("preserves ordinary paths and query parameters", () => {
    expect(sanitizeUrlForDisplay("./alpha.zip?channel=stable")).toBe(
      "./alpha.zip?channel=stable",
    );
  });
});
