import { describe, expect, it } from "vitest";
import { createNodeCompatibilityApi } from "../../src/providers/runtime/createApi.js";
import type { ProviderManifest } from "../../src/providers/sdk/types.js";

const manifest: ProviderManifest = {
  id: "fixture-dom",
  name: "Fixture DOM",
  version: "1.0.0",
  sourceType: "academic",
  permissions: {
    urls: ["https://fixture.example/*"],
  },
};

describe("provider DOM/XML runtime helpers", () => {
  it("supports XML text, attribute, repeated element, and namespace-local lookups", () => {
    const api = createNodeCompatibilityApi({ manifest });
    const doc = api.xml.parse(`
      <feed xmlns:arxiv="http://arxiv.org/schemas/atom">
        <entry>
          <title>Runtime XML Probe</title>
          <author><name>Jane Doe</name></author>
          <author><name>John Roe</name></author>
          <category term="cs.IR" />
          <link rel="alternate" href="https://arxiv.org/abs/1234.5678" />
          <arxiv:doi>10.1234/arxiv-probe</arxiv:doi>
        </entry>
      </feed>
    `);

    const entry = api.xml.getElements(doc, "entry")[0]!;
    const category = api.xml.getElements(entry, "category")[0]!;
    const link = api.xml.getElements(entry, "link")[0]!;

    expect(api.xml.getText(entry, "title")).toBe("Runtime XML Probe");
    expect(api.xml.getTextAll(entry, "name")).toEqual(["Jane Doe", "John Roe"]);
    expect(api.xml.getAttribute(category, "term")).toBe("cs.IR");
    expect(api.xml.getAttribute(link, "href")).toBe("https://arxiv.org/abs/1234.5678");
    expect(api.xml.getText(entry, "doi")).toBe("10.1234/arxiv-probe");
    expect(api.xml.getTextContent(category)).toBe("");
  });

  it("supports HTML parsing with standard query selectors", () => {
    const api = createNodeCompatibilityApi({ manifest });
    const doc = api.dom.parseHTML(`
      <div class="simple-list">
        <dl>
          <dt><a articleid="A-1">HTML Probe</a></dt>
          <dd class="author"><span><a><span>Jane Doe</span></a></span></dd>
        </dl>
      </div>
    `);

    expect(doc.querySelectorAll(".simple-list dl")).toHaveLength(1);
    expect(doc.querySelector("dt > a[articleid]")?.textContent).toBe("HTML Probe");
    expect(doc.querySelector(".author span a span")?.textContent).toBe("Jane Doe");
  });
});
