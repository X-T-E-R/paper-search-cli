#!/usr/bin/env node
import { writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  process.stdout.write("fixture-cli 2.0.0\n");
} else if (process.argv.includes("hang")) {
  if (process.env.PAPER_SEARCH_TEST_READY_FILE) {
    writeFileSync(process.env.PAPER_SEARCH_TEST_READY_FILE, "ready\n");
  }
  setTimeout(() => {
    if (process.env.PAPER_SEARCH_TEST_SURVIVAL_FILE) {
      writeFileSync(process.env.PAPER_SEARCH_TEST_SURVIVAL_FILE, "survived\n");
    }
  }, 750);
  setTimeout(() => {}, 60_000);
} else if (process.argv.includes("secret-stderr")) {
  process.stderr.write("token=adapter-secret must not escape\n");
} else {
  process.stdout.write(JSON.stringify({ query: process.argv.at(-1), title: "Adapted result" }));
}
