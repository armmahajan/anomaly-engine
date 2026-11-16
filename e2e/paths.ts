/** Throwaway project directory used by the e2e studio server (outside test-results/, which Playwright wipes). */
export const E2E_DATA_DIR = ".e2e-data/project";
/** Override with E2E_PORT to run two checkouts (e.g. worktrees) side by side. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 5199);
/** Fixed studio token for the e2e server. */
export const E2E_TOKEN = "e2e-test-token";
