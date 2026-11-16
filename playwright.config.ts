import { defineConfig } from "@playwright/test";
import { E2E_DATA_DIR, E2E_PORT as PORT, E2E_TOKEN } from "./e2e/paths.ts";

// E2E runs its own studio on a separate port with a throwaway project dir,
// so it never touches your real project or a dev server you have running.

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  use: {
    // Override to test via another address, e.g. BASE_URL=https://10.0.0.94:5173
    baseURL: process.env.BASE_URL ?? `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      // Headless Chromium has no GPU; let WebGL fall back to SwiftShader.
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    },
  },
  webServer: {
    command: `rm -rf ${E2E_DATA_DIR} && npm run dev`,
    env: {
      STUDIO_PORT: String(PORT),
      STUDIO_DATA_DIR: `${process.cwd()}/${E2E_DATA_DIR}`,
      STUDIO_TOKEN: E2E_TOKEN,
      STUDIO_CHAT_BACKEND: "fake",
    },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
