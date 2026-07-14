import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup/environment.ts"],
    minWorkers: 1,
    maxWorkers: 2,
    testTimeout: 30_000,
  },
});
