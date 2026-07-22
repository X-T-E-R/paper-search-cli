import { parseHTML } from "linkedom/worker";

const CONTENT_ROOT_SELECTORS = [
  "article",
  "main article",
  "main",
  "[role='main']",
  ".article-body",
  ".article-content",
  "#article-body",
  "#main-content",
];

const REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "nav",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "[aria-hidden='true']",
];

function normalizeInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>])/gu, "\\$1");
}

function renderChildren(node: Node): string {
  return Array.from(node.childNodes).map(renderNode).join("");
}

function renderListItem(element: Element): string {
  const nested = Array.from(element.children).filter((child) => {
    const tag = child.tagName.toLowerCase();
    return tag === "ul" || tag === "ol";
  });
  for (const child of nested) child.remove();
  const text = normalizeInline(renderChildren(element));
  const suffix = nested.map((child) => `\n${renderNode(child)}`).join("");
  return `${text}${suffix}`.trim();
}

function renderTable(element: Element): string {
  const rows = Array.from(element.querySelectorAll("tr")).map((row) =>
    Array.from(row.querySelectorAll("th, td")).map((cell) => normalizeInline(cell.textContent ?? "")),
  ).filter((row) => row.length > 0);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
  const header = normalizedRows[0]!;
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...normalizedRows.slice(1).map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

function renderNode(node: Node): string {
  if (node.nodeType === 3) return escapeMarkdown(node.nodeValue ?? "");
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  const content = renderChildren(element);

  if (/^h[1-6]$/u.test(tag)) {
    return `\n\n${"#".repeat(Number(tag.slice(1)))} ${normalizeInline(content)}\n\n`;
  }
  if (tag === "p" || tag === "figcaption" || tag === "caption") {
    const text = normalizeInline(content);
    return text ? `\n\n${text}\n\n` : "";
  }
  if (tag === "br") return "\n";
  if (tag === "hr") return "\n\n---\n\n";
  if (tag === "strong" || tag === "b") return `**${normalizeInline(content)}**`;
  if (tag === "em" || tag === "i") return `*${normalizeInline(content)}*`;
  if (tag === "code" && element.parentElement?.tagName.toLowerCase() !== "pre") {
    return `\`${normalizeInline(element.textContent ?? "").replace(/`/gu, "\\`")}\``;
  }
  if (tag === "pre") return `\n\n\`\`\`\n${(element.textContent ?? "").trim()}\n\`\`\`\n\n`;
  if (tag === "a") {
    const label = normalizeInline(content);
    const href = element.getAttribute("href")?.trim();
    return href && label ? `[${label}](${href})` : label;
  }
  if (tag === "img") {
    const alt = normalizeInline(element.getAttribute("alt") ?? "");
    const src = element.getAttribute("src")?.trim();
    return src ? `![${alt}](${src})` : alt;
  }
  if (tag === "blockquote") {
    const text = normalizeInline(content);
    return text ? `\n\n> ${text}\n\n` : "";
  }
  if (tag === "ul" || tag === "ol") {
    const ordered = tag === "ol";
    const items = Array.from(element.children)
      .filter((child) => child.tagName.toLowerCase() === "li")
      .map((item, index) => `${ordered ? `${index + 1}.` : "-"} ${renderListItem(item)}`);
    return items.length > 0 ? `\n\n${items.join("\n")}\n\n` : "";
  }
  if (tag === "table") return `\n\n${renderTable(element)}\n`;
  if (["article", "main", "section", "div", "header", "footer", "aside"].includes(tag)) {
    return `\n${content}\n`;
  }
  return content;
}

function documentTitle(document: Document): string {
  const citationTitle = document.querySelector("meta[name='citation_title']")?.getAttribute("content");
  const openGraphTitle = document.querySelector("meta[property='og:title']")?.getAttribute("content");
  return normalizeInline(citationTitle ?? openGraphTitle ?? document.title ?? "");
}

export interface LocalHtmlMarkdownResult {
  markdown: string;
  title?: string;
  rootSelector: string;
}

/** Convert already acquired HTML with the CLI's existing LinkeDOM dependency. */
export function localHtmlToMarkdown(html: string): LocalHtmlMarkdownResult {
  const document = parseHTML(html).document as unknown as Document;
  for (const selector of REMOVE_SELECTORS) {
    for (const element of Array.from(document.querySelectorAll(selector))) element.remove();
  }
  const selected = CONTENT_ROOT_SELECTORS
    .map((selector) => ({ selector, element: document.querySelector(selector) }))
    .find((candidate) => candidate.element !== null);
  const root = selected?.element ?? document.body;
  if (!root) throw new Error("Stored HTML does not contain a document body");

  const title = documentTitle(document);
  let markdown = renderChildren(root)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (title && !markdown.toLowerCase().startsWith(`# ${title.toLowerCase()}`)) {
    markdown = `# ${escapeMarkdown(title)}\n\n${markdown}`.trim();
  }
  if (!markdown) throw new Error("Stored HTML did not contain extractable article text");
  return {
    markdown: `${markdown}\n`,
    ...(title ? { title } : {}),
    rootSelector: selected?.selector ?? "body",
  };
}
