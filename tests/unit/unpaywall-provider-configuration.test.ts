import { describe, expect, it, vi } from "vitest";
import {
  createProvider,
  MaterialProviderConfigurationRequiredError,
} from "../../../material-providers/src/providers/packages/unpaywall/index.js";

function runtime(email: string | undefined, get = vi.fn()) {
  return {
    http: { get },
    config: {
      get<T>(_key: string, defaultValue?: T): T {
        return (email ?? defaultValue) as T;
      },
    },
  };
}

describe("Unpaywall provider configuration gate", () => {
  it("rejects the placeholder before network access", async () => {
    const context = runtime(undefined);
    const provider = createProvider(context);
    await expect(provider.resolve({
      identifier: { scheme: "doi", value: "10.1234/placeholder" },
    })).rejects.toBeInstanceOf(MaterialProviderConfigurationRequiredError);
    expect(context.http.get).not.toHaveBeenCalled();
  });

  it("calls upstream normally with a configured email", async () => {
    const get = vi.fn(async () => ({
      data: {
        best_oa_location: { url_for_pdf: "https://example.org/article.pdf" },
      },
      status: 200,
      statusText: "OK",
      headers: {},
    }));
    const provider = createProvider(runtime("researcher@example.org", get));
    await expect(provider.resolve({
      identifier: { scheme: "doi", value: "10.1234/configured" },
    })).resolves.toMatchObject({ candidates: [{ url: "https://example.org/article.pdf" }] });
    expect(get).toHaveBeenCalledOnce();
    expect(String((get.mock.calls as unknown as Array<[string]>)[0]?.[0])).toContain("email=researcher%40example.org");
  });
});
