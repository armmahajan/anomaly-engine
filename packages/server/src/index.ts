import { createDefaultProject } from "@anomaly/core";
import { architectAgent, buildAgent, narrativeAgent, type TurnRunner } from "@anomaly/agent";
import { createAuthMiddleware } from "./auth.ts";
import { ChatService } from "./chat.ts";
import { ArtService, type ArtServiceOptions } from "./art/service.ts";
import { FileStore } from "./art/files.ts";
import { createApiHandler, type Middleware } from "./http.ts";
import { ProjectStore } from "./projectStore.ts";
import { ArchitectService, defaultStageRunners, type StageRunners } from "./architect/service.ts";
import { modelStageRunners } from "./architect/modelStages.ts";

export { ProjectStore } from "./projectStore.ts";
export { ChatService, describeCall } from "./chat.ts";
export { createApiHandler, type ArtApi, type Chats, type Middleware } from "./http.ts";
export { ArtService, type ArtModels, type ArtServiceOptions } from "./art/service.ts";
export { FileStore } from "./art/files.ts";
export { modelStageRunners } from "./architect/modelStages.ts";
export { ArchitectService, defaultStageRunners, clearSides, repairFor, reseed, withStatus, type StageRunContext, type StageRunner, type StageRunners, type StageRunResult } from "./architect/service.ts";
export { BrowserRenderer, type Renderer } from "./art/renderer.ts";
export { createAuthMiddleware, generateToken, loadOrCreateToken, TOKEN_COOKIE, TOKEN_HEADER } from "./auth.ts";

/**
 * Open (or create) the project in `dir` and return middleware serving its
 * HTTP API, protected by `token` (see auth.ts). Chat turns run on `runner`.
 */
export async function createProjectServer(
  dir: string,
  options: { token: string; runner: TurnRunner; art?: Omit<ArtServiceOptions, "files">; architectStages?: Partial<StageRunners> },
): Promise<{
  store: ProjectStore;
  chat: ChatService;
  chats: { build: ChatService; narrative: ChatService; architect: ChatService };
  art: ArtService | null;
  architect: ArchitectService;
  handler: Middleware;
}> {
  const store = await ProjectStore.open(dir, createDefaultProject);
  const chats = {
    build: await ChatService.open(store, options.runner, buildAgent),
    narrative: await ChatService.open(store, options.runner, narrativeAgent),
    architect: await ChatService.open(store, options.runner, architectAgent),
  };
  const files = new FileStore(dir);
  const art = options.art ? await ArtService.open(store, { ...options.art, files }) : null;
  // The build assistant can queue art jobs; they run on the art service after its turn.
  chats.build.art = art;
  const auth = createAuthMiddleware(options.token);
  // The plan and cast stages are agent turns (Claude Code, or the scripted fake in e2e); the rest is code.
  const overrides = { ...modelStageRunners(options.runner), ...options.architectStages };
  const architect = new ArchitectService(store, defaultStageRunners({ art, overrides }), { repairPacing: true });
  // The Architect chat can queue build runs; they start after its turn.
  chats.architect.architect = architect;
  const api = createApiHandler(store, chats, art ? { service: art, files } : undefined, architect);
  return { store, chat: chats.build, chats, art, architect, handler: (req, res, next) => auth(req, res, () => api(req, res, next)) };
}
export { artOptionsFromEnv, DEFAULT_IMAGE_MODEL, DEFAULT_VISION_MODEL } from "./art/config.ts";
