import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

const DIGEST_SCHEMA = "paper-search-build-inputs-v1";

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

function assertRelativeInput(value, fieldName) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/u).includes("..")
  ) {
    throw new Error(`Invalid paperSearch.${fieldName} entry: ${String(value)}`);
  }
  return value;
}

export function mergeInputPaths(...groups) {
  const merged = [];
  for (const group of groups) {
    for (const entry of group) {
      if (!merged.includes(entry)) merged.push(entry);
    }
  }
  return merged;
}

export async function readPackageMetadata(repoRoot) {
  const packagePath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const configuredBuildInputs = packageJson?.paperSearch?.buildInputs;
  if (!Array.isArray(configuredBuildInputs) || configuredBuildInputs.length === 0) {
    throw new Error("package.json must declare a non-empty paperSearch.buildInputs array");
  }
  const configuredVerificationInputs = packageJson?.paperSearch?.selfUpdateVerificationInputs;
  if (!Array.isArray(configuredVerificationInputs) || configuredVerificationInputs.length === 0) {
    throw new Error(
      "package.json must declare a non-empty paperSearch.selfUpdateVerificationInputs array",
    );
  }
  const buildInputs = configuredBuildInputs.map((entry) =>
    assertRelativeInput(entry, "buildInputs"),
  );
  const selfUpdateVerificationInputs = configuredVerificationInputs.map((entry) =>
    assertRelativeInput(entry, "selfUpdateVerificationInputs"),
  );
  return {
    packageJson,
    buildInputs,
    selfUpdateVerificationInputs,
    selfUpdateStagingInputs: mergeInputPaths(buildInputs, selfUpdateVerificationInputs),
  };
}

async function collectPath(repoRoot, relativePath, output) {
  const absolutePath = path.join(repoRoot, relativePath);
  const stat = await lstat(absolutePath);
  if (stat.isDirectory()) {
    const children = await readdir(absolutePath);
    children.sort((left, right) => left.localeCompare(right, "en"));
    for (const child of children) {
      await collectPath(repoRoot, path.join(relativePath, child), output);
    }
    return;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`Unsupported build input type: ${absolutePath}`);
  }
  output.push({
    absolutePath,
    relativePath: normalizeRelativePath(relativePath),
    symbolicLink: stat.isSymbolicLink(),
  });
}

export async function listBuildInputFiles(repoRoot, buildInputs) {
  const files = [];
  for (const configuredPath of buildInputs) {
    await collectPath(repoRoot, configuredPath, files);
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const seen = new Set();
  return files.filter((entry) => {
    if (seen.has(entry.relativePath)) return false;
    seen.add(entry.relativePath);
    return true;
  });
}

export async function computeBuildInputDigest(repoRoot, buildInputs) {
  const hash = createHash("sha256");
  hash.update(`${DIGEST_SCHEMA}\0`);
  const files = await listBuildInputFiles(repoRoot, buildInputs);
  for (const file of files) {
    hash.update(`${file.relativePath}\0`);
    if (file.symbolicLink) {
      hash.update(`link:${await readlink(file.absolutePath)}\0`);
    } else {
      hash.update(await readFile(file.absolutePath));
      hash.update("\0");
    }
  }
  return {
    algorithm: "sha256",
    schemaVersion: 1,
    value: hash.digest("hex"),
    fileCount: files.length,
  };
}

export async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
