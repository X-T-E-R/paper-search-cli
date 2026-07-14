#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { replaceDirectoryWithPrevious } from "./lib/dist-swap.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-dist-swap-"));
const current = path.join(root, "dist");
const previous = path.join(root, "dist.previous");
const next = path.join(root, "candidate");

async function directoryWithMarker(directory, marker) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "marker.txt"), marker, "utf8");
}

async function marker(directory) {
  return readFile(path.join(directory, "marker.txt"), "utf8");
}

try {
  await directoryWithMarker(current, "current-v1");
  await directoryWithMarker(previous, "older-v0");
  await directoryWithMarker(next, "candidate-v2");
  await replaceDirectoryWithPrevious({ nextPath: next, currentPath: current, previousPath: previous });
  if ((await marker(current)) !== "candidate-v2" || (await marker(previous)) !== "current-v1") {
    throw new Error("successful swap did not retain the prior selected directory");
  }

  await rm(current, { recursive: true, force: true });
  await rm(next, { recursive: true, force: true });
  await directoryWithMarker(next, "candidate-v3");
  await replaceDirectoryWithPrevious({ nextPath: next, currentPath: current, previousPath: previous });
  if ((await marker(current)) !== "candidate-v3" || (await marker(previous)) !== "current-v1") {
    throw new Error("interrupted current-to-previous state was not recovered deterministically");
  }

  await rm(next, { recursive: true, force: true });
  let failed = false;
  try {
    await replaceDirectoryWithPrevious({ nextPath: next, currentPath: current, previousPath: previous });
  } catch {
    failed = true;
  }
  if (!failed || (await marker(current)) !== "candidate-v3") {
    throw new Error("candidate selection failure did not restore the selected directory");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, deterministicRecovery: true })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
