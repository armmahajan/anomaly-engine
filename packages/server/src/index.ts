import { join } from "node:path";
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
import { LiveService } from "./live/service.ts";
import { GameExporter } from "./export/gameExport.ts";
import type { LiveSettings } from "@anomaly/core";

export { ProjectStore } from "./projectStore.ts";
export { ChatService, describeCall } from "./chat.ts";
export { createApiHandler, type ArtApi, type Chats, type Middleware } from "./http.ts";
export { ArtService, conceptModelFor, type ArtModels, type ArtServiceOptions } from "./art/service.ts";
export { FileStore } from "./art/files.ts";
export { modelStageRunners } from "./architect/modelStages.ts";
export { LiveService, behaviorMessage, type LiveServiceOptions } from "./live/service.ts";
export { privateTurn } from "./agentTurn.ts";
export { buildGameExport, GameExporter, type GameExportOptions } from "./export/gameExport.ts";
export { zipFiles, type ZipEntry } from "./export/zip.ts";
export { ArchitectService, defaultStageRunners, clearSides, repairFor, reseed, withStatus, type StageRunContext, type StageRunner, type StageRunners, type StageRunResult } from "./architect/service.ts";
export { BrowserRenderer, type Renderer } from "./art/renderer.ts";
export { createAuthMiddleware, generateToken, loadOrCreateToken, TOKEN_COOKIE, TOKEN_HEADER } from "./auth.ts";

/**
 * Open (or create) the project in `dir` and return middleware serving its
 * HTTP API, protected by `token` (see auth.ts). Chat turns run on `runner`.
 */
export async function createProjectServer(
  dir: string,
  options: {
    token: string;
    runner: TurnRunner;
    art?: Omit<ArtServiceOptions, "files">;
    architectStages?: Partial<StageRunners>;
    /** Live cast and live rooms for a project that has no settings yet (default: both off; the studio sets them from STUDIO_LIVE), and their debounce. */
    live?: Partial<LiveSettings> & { debounceMs?: number; worker?: boolean };
    /** The Godot web export the studio plays (apps/studio/public/game): turns on game export (POST /api/export), written to <dir>/exports/. */
    runtimeDir?: string;
  },
): Promise<{
  store: ProjectStore;
  chat: ChatService;
  chats: { build: ChatService; narrative: ChatService; architect: ChatService };
  art: ArtService | null;
  architect: ArchitectService;
  live: LiveService;
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
  // The studio fills in as the creator designs: game characters from the wiki, rooms from the progression.
  const { debounceMs, worker, ...settings } = options.live ?? {};
  const live = await LiveService.open(store, { runner: options.runner, art, defaults: { cast: false, rooms: false, ...settings }, debounceMs, worker });
  const exporter = options.runtimeDir ? new GameExporter(() => store.getState().project, { runtimeDir: options.runtimeDir, outDir: join(dir, "exports"), files }) : undefined;
  const api = createApiHandler(store, chats, art ? { service: art, files } : undefined, architect, live, exporter);
  return { store, chat: chats.build, chats, art, architect, live, handler: (req, res, next) => auth(req, res, () => api(req, res, next)) };
}
export {
  artOptionsFromEnv,
  visionBackendFromEnv,
  DEFAULT_CLAUDE_VISION_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_CONCEPT_MODELS,
  IMAGE_MODEL_PARAMS,
  conceptModelIds,
  imageModelLabel,
} from "./art/config.ts";
export { ClaudeCodeVisionModel } from "./art/claudeCodeVision.ts";

/** STUDIO_LIVE: "on" (default), "off", "cast" or "rooms": what fills in live on a project with no live settings yet. */
export function liveSettingsFromEnv(env: Record<string, string | undefined>): LiveSettings {
  const value = env.STUDIO_LIVE?.trim().toLowerCase() ?? "on";
  return { cast: value === "on" || value === "cast", rooms: value === "on" || value === "rooms" };
}
