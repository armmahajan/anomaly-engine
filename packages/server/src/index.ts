import { createDefaultProject } from "@anomaly/core";
import { createAuthMiddleware } from "./auth.ts";
import { createApiHandler, type Middleware } from "./http.ts";
import { ProjectStore } from "./projectStore.ts";

export { ProjectStore } from "./projectStore.ts";
export { createApiHandler, type Middleware } from "./http.ts";
export { createAuthMiddleware, generateToken, loadOrCreateToken, TOKEN_COOKIE, TOKEN_HEADER } from "./auth.ts";

/**
 * Open (or create) the project in `dir` and return middleware serving its
 * HTTP API, protected by `token` (see auth.ts).
 */
export async function createProjectServer(
  dir: string,
  options: { token: string },
): Promise<{ store: ProjectStore; handler: Middleware }> {
  const store = await ProjectStore.open(dir, createDefaultProject);
  const auth = createAuthMiddleware(options.token);
  const api = createApiHandler(store);
  return { store, handler: (req, res, next) => auth(req, res, () => api(req, res, next)) };
}
