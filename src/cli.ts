#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { buildProgram } from "./program.js";

export async function run(argv = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
  process.exit(process.exitCode ?? 0);
}
