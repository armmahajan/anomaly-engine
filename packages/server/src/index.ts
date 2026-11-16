import { createDefaultProject } from "@anomaly/core";
import { buildAgent, narrativeAgent, type TurnRunner } from "@anomaly/agent";
import { createAuthMiddleware } from "./auth.ts";
import { ChatService } from "./chat.ts";
import { createApiHandler, type Middleware } from "./http.ts";
import { ProjectStore } from "./projectStore.ts";

export { ProjectStore } from "./projectStore.ts";
export { ChatService, describeCall } from "./chat.ts";
export { createApiHandler, type Chats, type Middleware } from "./http.ts";
export { createAuthMiddleware, generateToken, loadOrCreateToken, TOKEN_COOKIE, TOKEN_HEADER } from "./auth.ts";

/**
 * Open (or create) the project in `dir` and return middleware serving its
 * HTTP API, protected by `token` (see auth.ts). Chat turns run on `runner`.
 */
export async function createProjectServer(
  dir: string,
  options: { token: string; runner: TurnRunner },
): Promise<{ store: ProjectStore; chat: ChatService; chats: { build: ChatService; narrative: ChatService }; handler: Middleware }> {
  const store = await ProjectStore.open(dir, createDefaultProject);
  const chats = {
    build: await ChatService.open(store, options.runner, buildAgent),
    narrative: await ChatService.open(store, options.runner, narrativeAgent),
  };
  const auth = createAuthMiddleware(options.token);
  const api = createApiHandler(store, chats);
  return { store, chat: chats.build, chats, handler: (req, res, next) => auth(req, res, () => api(req, res, next)) };
}
