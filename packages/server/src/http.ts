import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AgentId, ExportRequest, fail, type ErrorCode, type ServerEvent } from "@anomaly/core";
import type { ArtService } from "./art/service.ts";
import type { ArchitectService } from "./architect/service.ts";
import type { LiveService } from "./live/service.ts";
import { FILE_MEDIA_TYPES, type FileStore } from "./art/files.ts";
import type { ChatService } from "./chat.ts";
import type { ProjectStore } from "./projectStore.ts";
import type { GameExporter } from "./export/gameExport.ts";

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const MAX_BODY_BYTES = 1_000_000;
const HEARTBEAT_MS = 15_000;

const STATUS_FOR: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_input: 422,
  invalid_result: 422,
  not_found: 404,
  locked: 409,
  stale_revision: 409,
  nothing_to_undo: 409,
  unavailable: 503,
  unauthorized: 401,
};

/** HTTP API over a ProjectStore. See packages/core/src/api.ts for the contract. */
/** Chat services by agent; requests pick one with ?agent= (default: build). */
export type Chats = Partial<Record<AgentId, ChatService>>;

/** Optional art pipeline: the job service and the project's file store. */
export interface ArtApi {
  service: ArtService;
  files: FileStore;
}

export function createApiHandler(
  store: ProjectStore,
  chats: Chats = {},
  art?: ArtApi,
  architect?: ArchitectService,
  live?: LiveService,
  exporter?: GameExporter,
): Middleware {
  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return next();
    route(store, chats, art, architect, live, exporter, req, res, url).catch((error: unknown) => {
      console.error("[project-server]", error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: "internal", message: String(error), issues: [] } });
      else res.end();
    });
  };
}

async function route(
  store: ProjectStore,
  chats: Chats,
  art: ArtApi | undefined,
  architect: ArchitectService | undefined,
  live: LiveService | undefined,
  exporter: GameExporter | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const key = `${req.method} ${url.pathname}`;
  switch (key) {
    case "GET /api/project":
      return sendJson(res, 200, store.getState());
    case "GET /api/history":
      return sendJson(res, 200, { entries: store.getHistory() });
    case "GET /api/events":
      return openEventStream(store, chats, art, architect, live, req, res, url.searchParams.get("clientId"));
    case "POST /api/ops":
      return respond(res, await withBody(req, (body) => store.applyOperation(body)));
    case "POST /api/batch":
      return respond(res, await withBody(req, (body) => store.applyBatch(body)));
    case "POST /api/undo":
      return respond(res, await withBody(req, (body) => store.undo(body)));
    case "POST /api/playtest":
      return respond(res, await withBody(req, (body) => store.setPlaytest(body)));
    case "POST /api/reset": {
      const result = await withBody(req, (body) => store.reset(body));
      if (result.ok) {
        await Promise.all(Object.values(chats).map((c) => c.reset()));
        await art?.service.reset();
        architect?.reset();
        await live?.reset();
      }
      return respond(res, result);
    }
  }
  if (live) {
    switch (key) {
      case "GET /api/live":
        return sendJson(res, 200, live.getState());
      case "POST /api/live":
        return respond(res, await withBody(req, (body) => live.configure(body)));
    }
  }
  const agent = AgentId.safeParse(url.searchParams.get("agent") ?? "build");
  const chat = agent.success ? chats[agent.data] : undefined;
  if (chat) {
    switch (key) {
      case "GET /api/chat":
        return sendJson(res, 200, chat.getState());
      case "POST /api/chat":
        return respond(res, await withBody(req, (body) => chat.send(body)));
      case "POST /api/chat/cancel":
        return respond(res, chat.cancel());
    }
  }
  if (architect) {
    switch (key) {
      case "GET /api/architect":
        return sendJson(res, 200, architect.getState());
      case "POST /api/architect/run":
        return respond(res, await withBody(req, (body) => architect.start(body)));
      case "POST /api/architect/cancel":
        return respond(res, architect.cancel());
    }
  }
  if (exporter) {
    if (key === "POST /api/export") {
      return respond(
        res,
        await withBody(req, async (body) => {
          const request = ExportRequest.safeParse(body);
          return request.success ? exporter.build() : fail("invalid_request", "the export request takes no options: send {}");
        }),
      );
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/export/")) {
      const file = url.pathname.slice("/api/export/".length);
      const zip = await exporter.zip(file);
      if (!zip) return sendJson(res, 404, fail("not_found", `no export "${file}": build one with POST /api/export`));
      res.statusCode = 200;
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${file}"`);
      res.setHeader("cache-control", "no-store");
      return void res.end(zip);
    }
  }
  if (art) {
    switch (key) {
      case "GET /api/art":
        return sendJson(res, 200, art.service.getState());
      case "POST /api/art/jobs":
        return respond(res, await withBody(req, (body) => art.service.start(body)));
      case "POST /api/art/cancel":
        return respond(res, art.service.cancel());
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/files/")) {
      return sendFile(res, art.files, url.pathname.slice("/api/files/".length));
    }
  }
  sendJson(res, 404, fail("not_found", `no route ${key}`));
}

/** Stored images are immutable (content-addressed), so they cache forever. */
async function sendFile(res: ServerResponse, files: FileStore, ref: string): Promise<void> {
  let data: Buffer;
  try {
    data = await readFile(files.path(ref));
  } catch {
    return sendJson(res, 404, fail("not_found", `no file "${ref}"`));
  }
  res.statusCode = 200;
  res.setHeader("content-type", FILE_MEDIA_TYPES[ref.split(".").pop() ?? ""] ?? "application/octet-stream");
  res.setHeader("cache-control", "private, max-age=31536000, immutable");
  res.end(data);
}

type Result = { ok: true } | { ok: false; error: { code: ErrorCode } };

function respond(res: ServerResponse, result: Result): void {
  sendJson(res, result.ok ? 200 : STATUS_FOR[result.error.code], result);
}

async function withBody<T extends Result>(req: IncomingMessage, handle: (body: unknown) => Promise<T>) {
  const body = await readJson(req);
  return body.ok ? handle(body.value) : body.failure;
}

async function readJson(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; failure: ReturnType<typeof fail> }> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return { ok: false, failure: fail("invalid_request", "request body too large") };
    chunks.push(chunk as Buffer);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, failure: fail("invalid_request", "request body must be JSON") };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

/** Server-sent events: the current project and chat on connect, then every change. */
function openEventStream(
  store: ProjectStore,
  chats: Chats,
  art: ArtApi | undefined,
  architect: ArchitectService | undefined,
  live: LiveService | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  clientId: string | null,
) {
  // No `connection` header: it is illegal over HTTP/2 (used by the HTTPS dev server).
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const send = (event: ServerEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: "project", ...store.getState(), cause: null });
  for (const chat of Object.values(chats)) send({ type: "chat", agent: chat.agent.id, chat: chat.getState() });
  if (art) send({ type: "art", art: art.service.getState() });
  if (architect) send({ type: "architect", architect: architect.getState() });
  if (live) send({ type: "live", live: live.getState() });

  const unsubscribeProject = store.subscribe(send);
  const unsubscribeChats = Object.values(chats).map((chat) =>
    chat.subscribe((state) => send({ type: "chat", agent: chat.agent.id, chat: state })),
  );
  const unsubscribeArt = art?.service.subscribe((state) => send({ type: "art", art: state }));
  const unsubscribeArchitect = architect?.subscribe((state) => send({ type: "architect", architect: state }));
  const unsubscribeLive = live?.subscribe((state) => send({ type: "live", live: state }));
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribeProject();
    for (const unsubscribe of unsubscribeChats) unsubscribe();
    unsubscribeArt?.();
    unsubscribeArchitect?.();
    unsubscribeLive?.();
    if (clientId) store.releasePlaytest(clientId);
  });
}
