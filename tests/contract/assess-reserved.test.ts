import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCanonicalToolCapability, getCanonicalToolNames } from "../../src/surface/toolCatalog.js";

const packageRoot = path.resolve(".");

const RESERVED_MARKERS = [/reserved/i, /预留/];

async function readDoc(relativePath: string): Promise<string> {
  return readFile(path.join(packageRoot, relativePath), "utf8");
}

function expectAssessReserved(section: string, label: string): void {
  const assessLine = section
    .split("\n")
    .find((line) => line.includes("`assess`") || /\|\s*`assess`\s*\|/.test(line));
  expect(assessLine, `${label} should mention assess`).toBeDefined();
  expect(
    RESERVED_MARKERS.some((marker) => marker.test(assessLine ?? "")),
    `${label} should mark assess as reserved`,
  ).toBe(true);
}

describe("assess capability group disposition (ADR-0003)", () => {
  it("does not map any canonical tool to assess", () => {
    for (const toolName of getCanonicalToolNames()) {
      expect(getCanonicalToolCapability(toolName)).not.toBe("assess");
    }
  });

  it("documents assess as reserved in README and architecture", async () => {
    const readme = await readDoc("README.md");
    const architecture = await readDoc("docs/architecture.md");
    expectAssessReserved(readme, "README.md");
    expectAssessReserved(architecture, "docs/architecture.md");
    expect(readme).toMatch(/ADR-0003/i);
    expect(architecture).toMatch(/ADR-0003/i);
  });

  it("documents assess as reserved in the companion skill", async () => {
    const skill = await readDoc("skills/paper-search-cli/SKILL.md");
    const routing = await readDoc("skills/paper-search-cli/references/capability-routing.md");
    expectAssessReserved(skill, "skills/paper-search-cli/SKILL.md");
    expectAssessReserved(routing, "skills/paper-search-cli/references/capability-routing.md");
    expect(skill).toMatch(/ADR-0003/i);
    expect(routing).toMatch(/ADR-0003/i);
  });
});
