import { afterEach, describe, expect, it } from "vitest";
import { runJinaReaderUrlProbe } from "../../src/lookup/jinaReader.js";
import { setSafeExternalHttpsTestHooksForTests } from "../../src/runtime/safeExternalHttps.js";

afterEach(() => {
  setSafeExternalHttpsTestHooksForTests(undefined);
});

describe("Jina Reader exact-URL probe", () => {
  it("returns markdown and exact source identity through the shared reader adapter", async () => {
    const sourceUrl = "https://official.example/product/launch/";
    let requestedUrl = "";
    setSafeExternalHttpsTestHooksForTests({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      requestPinned: async (url, init) => {
        requestedUrl = url.toString();
        expect(init.headers).toMatchObject({ "X-Return-Format": "markdown" });
        return new Response(`Title: Product Launch\nURL Source: ${sourceUrl}\n\nMarkdown Content:\nOfficial details.`, {
          status: 200,
          headers: { "content-type": "text/markdown" },
        });
      },
    });

    const result = await runJinaReaderUrlProbe(sourceUrl, "url-metadata-fallback");

    expect(requestedUrl).toBe(`https://r.jina.ai/${sourceUrl}`);
    expect(result).toMatchObject({
      source: { kind: "url", url: sourceUrl },
      markdown: expect.stringContaining("Product Launch"),
      cacheHit: false,
      provider: { id: "jina-reader", version: "reader-api-v1" },
      policy: "url-metadata-fallback",
      metadata: {
        endpoint: "https://r.jina.ai",
        finalProviderUrl: `https://r.jina.ai/${sourceUrl}`,
        contentType: "text/markdown",
      },
    });
  });

  it("rejects challenge content instead of treating it as page metadata", async () => {
    setSafeExternalHttpsTestHooksForTests({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      requestPinned: async () => new Response("Title: Just a moment\nEnable JavaScript and cookies to continue", { status: 200 }),
    });

    await expect(runJinaReaderUrlProbe(
      "https://official.example/challenged/",
      "url-metadata-fallback",
    )).rejects.toThrow("challenge page");
  });

  it("rejects content whose provider-reported source is not the requested URL", async () => {
    setSafeExternalHttpsTestHooksForTests({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      requestPinned: async () => new Response(
        "Title: Wrong Page\nURL Source: https://unrelated.example/page/\n\nMarkdown Content:\nWrong content.",
        { status: 200 },
      ),
    });

    await expect(runJinaReaderUrlProbe(
      "https://official.example/expected/",
      "url-metadata-fallback",
    )).rejects.toThrow("source identity mismatch");
  });
});
