import { describe, expect, it } from "vitest";
import { localHtmlToMarkdown } from "../../src/material/htmlToMarkdown.js";

describe("stored HTML to Markdown", () => {
  it("uses semantic article content and excludes page chrome", () => {
    const result = localHtmlToMarkdown(`
      <html>
        <head><meta name="citation_title" content="Stored Article"></head>
        <body>
          <nav>Account and navigation controls</nav>
          <article>
            <h1>Stored Article</h1>
            <p>A complete paragraph with <strong>evidence</strong>.</p>
            <h2>Methods</h2>
            <ul><li>Stored bytes only</li><li>No refetch</li></ul>
          </article>
        </body>
      </html>
    `);

    expect(result).toMatchObject({ title: "Stored Article", rootSelector: "article" });
    expect(result.markdown).toContain("# Stored Article");
    expect(result.markdown).toContain("A complete paragraph with **evidence**.");
    expect(result.markdown).toContain("## Methods");
    expect(result.markdown).toContain("- Stored bytes only");
    expect(result.markdown).not.toContain("Account and navigation controls");
  });
});
