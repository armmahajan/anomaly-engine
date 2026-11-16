import { createDefaultProject } from "@anomaly/core";
import { buildAgent, narrativeAgent, type TurnRunner } from "@anomaly/agent";
import { createAuthMiddleware } from "./auth.ts";
import { ChatService } from "./chat.ts";
import { ArtService, type ArtServiceOptions } from "./art/service.ts";
import { FileStore } from "./art/files.ts";
import { createApiHandler, type Middleware } from "./http.ts";
import { ProjectStore } from "./projectStore.ts";

export { ProjectStore } from "./projectStore.ts";
export { ChatService, describeCall } from "./chat.ts";
export { createApiHandler, type ArtApi, type Chats, type Middleware } from "./http.ts";
export { ArtService, type ArtModels, type ArtServiceOptions } from "./art/service.ts";
export { FileStore } from "./art/files.ts";
export { BrowserRenderer, type Renderer } from "./art/renderer.ts";
export { createAuthMiddleware, generateToken, loadOrCreateToken, TOKEN_COOKIE, TOKEN_HEADER } from "./auth.ts";

/**
 * Open (or create) the project in `dir` and return middleware serving its
 * HTTP API, protected by `token` (see auth.ts). Chat turns run on `runner`.
 */
export async function createProjectServer(
  dir: string,
  options: { token: string; runner: TurnRunner; art?: Omit<ArtServiceOptions, "files"> },
): Promise<{
  store: ProjectStore;
  chat: ChatService;
  chats: { build: ChatService; narrative: ChatService };
  art: ArtService | null;
  handler: Middleware;
}> {
  const store = await ProjectStore.open(dir, createDefaultProject);
  const chats = {
    build: await ChatService.open(store, options.runner, buildAgent),
    narrative: await ChatService.open(store, options.runner, narrativeAgent),
  };
  const files = new FileStore(dir);
  const art = options.art ? await ArtService.open(store, { ...options.art, files }) : null;
  // The build assistant can queue art jobs; they run on the art service after its turn.
  chats.build.art = art;
  const auth = createAuthMiddleware(options.token);
  const api = createApiHandler(store, chats, art ? { service: art, files } : undefined);
  return { store, chat: chats.build, chats, art, handler: (req, res, next) => auth(req, res, () => api(req, res, next)) };
}
export { artOptionsFromEnv, DEFAULT_IMAGE_MODEL, DEFAULT_VISION_MODEL } from "./art/config.ts";
