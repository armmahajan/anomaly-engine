import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "game/test/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    // Generous: a busy machine (agents, renders) must not turn a slow test into a failure.
    testTimeout: 20_000,
  },
});
