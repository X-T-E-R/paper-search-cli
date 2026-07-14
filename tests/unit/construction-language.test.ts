import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "../..");

const SCAN_TARGETS = [
  "src",
  "skills/paper-search-cli",
] as const;

const CONSTRUCTION_PHASE_PATTERN = /phase(?:\s+|-)1/i;

function listFiles(targetPath: string): string[] {
  const status = statSync(targetPath);
  if (status.isFile()) {
    return [targetPath];
  }

  const files: string[] = [];
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    const childPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(childPath));
    } else if (entry.isFile()) {
      files.push(childPath);
    }
  }
  return files;
}

describe("contract surface language", () => {
  it("does not expose construction milestone wording in public tool and skill surfaces", () => {
    const violations: string[] = [];

    for (const relativeTarget of SCAN_TARGETS) {
      const targetPath = path.join(packageRoot, relativeTarget);
      for (const filePath of listFiles(targetPath)) {
        const relativeFile = path.relative(packageRoot, filePath).replace(/\\/g, "/");
        const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
        lines.forEach((line, index) => {
          if (CONSTRUCTION_PHASE_PATTERN.test(line)) {
            violations.push(`${relativeFile}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }

    expect(violations).toEqual([]);
  });
});
