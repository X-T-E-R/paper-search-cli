import { describe, expect, it } from "vitest";
import vm from "node:vm";
import {
  sanitizeForPersistence,
  sanitizeUrlForDisplay,
  sanitizeUrlForPersistence,
} from "../../src/runtime/sanitizeUrl.js";

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

describe("persistent URL redaction", () => {
  it("retains origin, path, and query keys while removing every value and fragment", () => {
    const sentinel = "PERSISTENCE_SENTINEL";
    const sanitized = sanitizeUrlForPersistence(
      `https://example.test/result.zip?signature=${sentinel}&mode=${sentinel}#${sentinel}`,
    );
    expect(sanitized).toContain("https://example.test/result.zip");
    expect(sanitized).toContain("signature=");
    expect(sanitized).toContain("mode=");
    expect(sanitized).not.toContain(sentinel);
    expect(sanitized).not.toContain("#");
  });

  it("redacts URL-bearing nested metadata and error text", () => {
    const sentinel = "NESTED_SENTINEL";
    const result = sanitizeForPersistence({
      mineru: { full_zip_url: `https://oss.example/result.zip?sig=${sentinel}#${sentinel}` },
      error: `failed at https://api.example/task?ticket=${sentinel}`,
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.mineru.full_zip_url).toContain("sig=");
  });

  it("redacts provider records created in a separate vm realm", () => {
    const sentinel = "VM_REALM_SENTINEL";
    const providerValue = vm.runInNewContext(
      `({ metadata: { full_zip_url: "https://oss.example/result.zip?sig=${sentinel}#${sentinel}" } })`,
    ) as { metadata: { full_zip_url: string } };

    const result = sanitizeForPersistence(providerValue);

    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.metadata.full_zip_url).toContain("sig=");
  });
});
