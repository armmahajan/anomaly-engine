import type { IncomingMessage, ServerResponse } from "node:http";
import { fail, type ErrorCode, type ProjectEvent } from "@anomaly/core";
import type { ProjectStore } from "./projectStore.ts";

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
export function createApiHandler(store: ProjectStore): Middleware {
  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return next();
    route(store, req, res, url).catch((error: unknown) => {
      console.error("[project-server]", error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: "internal", message: String(error), issues: [] } });
      else res.end();
    });
  };
}

async function route(store: ProjectStore, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const key = `${req.method} ${url.pathname}`;
  switch (key) {
    case "GET /api/project":
      return sendJson(res, 200, store.getState());
    case "GET /api/history":
      return sendJson(res, 200, { entries: store.getHistory() });
    case "GET /api/events":
      return openEventStream(store, req, res, url.searchParams.get("clientId"));
    case "POST /api/ops":
      return respond(res, await withBody(req, (body) => store.applyOperation(body)));
    case "POST /api/batch":
      return respond(res, await withBody(req, (body) => store.applyBatch(body)));
    case "POST /api/undo":
      return respond(res, await withBody(req, (body) => store.undo(body)));
    case "POST /api/playtest":
      return respond(res, await withBody(req, (body) => store.setPlaytest(body)));
    default:
      return sendJson(res, 404, fail("not_found", `no route ${key}`));
  }
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

/** Server-sent events: the current project on connect, then every change. */
function openEventStream(store: ProjectStore, req: IncomingMessage, res: ServerResponse, clientId: string | null) {
  // No `connection` header: it is illegal over HTTP/2 (used by the HTTPS dev server).
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const send = (event: ProjectEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: "project", ...store.getState(), cause: null });

  const unsubscribe = store.subscribe(send);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    if (clientId) store.releasePlaytest(clientId);
  });
}
