import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    minWorkers: 1,
    maxWorkers: 4,
  },
});
