import { defineConfig } from "@playwright/test";
import { E2E_INDEX, E2E_PORT as PORT, E2E_TOKEN, E2E_WORKERS, e2eDataDir } from "./e2e/paths.ts";

// E2E runs its own studios on separate ports with throwaway project dirs, so it never touches
// your real project or a dev server you have running. E2E_WORKERS=N runs N studios and N workers
// (one studio each; see e2e/paths.ts). Heavy: run it through scripts/heavy.sh (npm run e2e does).

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: E2E_WORKERS,
  fullyParallel: false,
  use: {
    // Override to test via another address, e.g. BASE_URL=https://10.0.0.94:5173
    baseURL: process.env.BASE_URL ?? `http://localhost:${PORT + E2E_INDEX}`,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      // Headless Chromium has no GPU; let WebGL fall back to SwiftShader.
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    },
  },
  webServer: Array.from({ length: E2E_WORKERS }, (_, i) => ({
    command: `rm -rf ${e2eDataDir(i)} && npm run dev`,
    env: {
      STUDIO_PORT: String(PORT + i),
      STUDIO_DATA_DIR: `${process.cwd()}/${e2eDataDir(i)}`,
      STUDIO_TOKEN: E2E_TOKEN,
      STUDIO_CHAT_BACKEND: "fake",
      // Scripted art models (no spend); renders still go through the real runtime.
      STUDIO_ART_BACKEND: "fake",
      // Live cast and rooms start off; the specs that test them turn them on (e2e/live.spec.ts).
      STUDIO_LIVE: "off",
    },
    url: `http://localhost:${PORT + i}`,
    reuseExistingServer: false,
    timeout: 120_000,
  })),
});
