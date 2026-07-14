import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCanonicalToolCapability } from "../../src/surface/toolCatalog.js";

const packageRoot = path.resolve(".");
const ASSESSMENT_TOOLS = ["assessment_run", "assessment_show", "assessment_list"] as const;

async function readDoc(relativePath: string): Promise<string> {
  return readFile(path.join(packageRoot, relativePath), "utf8");
}

describe("implemented assess capability group (ADR-0003 amendment)", () => {
  it("maps the fixed assessment tools to assess", () => {
    for (const toolName of ASSESSMENT_TOOLS) {
      expect(getCanonicalToolCapability(toolName)).toBe("assess");
    }
  });

  it("documents checksum-bound assessment in README and architecture", async () => {
    const [readme, architecture, decision] = await Promise.all([
      readDoc("README.md"),
      readDoc("docs/architecture.md"),
      readDoc("docs/decisions/ADR-0003-assess-capability-group-disposition.md"),
    ]);
    for (const [label, markdown] of [["README", readme], ["architecture", architecture]] as const) {
      expect(markdown, label).toMatch(/assessment_run|assess plan/u);
      expect(markdown, label).toMatch(/checksum|SHA-256|校验和/iu);
    }
    expect(decision).toMatch(/amend|supersed|implemented|实施|修订/iu);
  });

  it("routes assessment through the companion skill instead of marking it reserved", async () => {
    const [skill, routing] = await Promise.all([
      readDoc("skills/paper-search-cli/SKILL.md"),
      readDoc("skills/paper-search-cli/references/capability-routing.md"),
    ]);
    for (const [label, markdown] of [["skill", skill], ["routing", routing]] as const) {
      expect(markdown, label).toContain("assessment_run");
      const assessLines = markdown.split(/\r?\n/u).filter((line) => /`assess`|assessment_run/u.test(line));
      expect(assessLines.some((line) => /reserved|预留/iu.test(line)), label).toBe(false);
    }
  });
});
