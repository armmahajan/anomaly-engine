import { createDefaultProject } from "@anomaly/core";
import { createApiHandler, type Middleware } from "./http.ts";
import { ProjectStore } from "./projectStore.ts";

export { ProjectStore } from "./projectStore.ts";
export { createApiHandler, type Middleware } from "./http.ts";

/** Open (or create) the project in `dir` and return its HTTP API middleware. */
export async function createProjectServer(dir: string): Promise<{ store: ProjectStore; handler: Middleware }> {
  const store = await ProjectStore.open(dir, createDefaultProject);
  return { store, handler: createApiHandler(store) };
}
