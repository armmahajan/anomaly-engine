/**
 * The e2e studios. With E2E_WORKERS=N (default 1), Playwright starts N studio servers on ports
 * E2E_PORT..E2E_PORT+N-1, each with its own throwaway project dir, and worker i uses server i:
 * workers never share a project, so spec files run in parallel safely. (Playwright evaluates the
 * config in every worker process with TEST_PARALLEL_INDEX set; the runner itself has none.)
 */
export const E2E_WORKERS = Math.max(1, Number(process.env.E2E_WORKERS ?? 1) || 1);
/** Override with E2E_PORT to run two checkouts (e.g. worktrees) side by side. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 5199);
/** This worker's server (0 in the runner and with one worker). */
export const E2E_INDEX = Number(process.env.TEST_PARALLEL_INDEX ?? 0) % E2E_WORKERS;
/** Throwaway project directory of server `i` (outside test-results/, which Playwright wipes). */
export const e2eDataDir = (i: number) => (i === 0 ? ".e2e-data/project" : `.e2e-data/project-${i}`);
/** This worker's project directory. */
export const E2E_DATA_DIR = e2eDataDir(E2E_INDEX);
/** Fixed studio token for the e2e servers. */
export const E2E_TOKEN = "e2e-test-token";
