import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectServer } from "../src/index.ts";

const TOKEN = "test-token";
const auth = { "x-studio-token": TOKEN };

let dir: string;
let server: Server;
let base: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anomaly-http-"));
  const { handler } = await createProjectServer(dir, { token: TOKEN });
  server = createServer((req, res) =>
    handler(req, res, () => {
      res.statusCode = 418;
      res.end("not api");
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: string) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...auth }, body });
const get = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...auth, ...init.headers } });

const op = (runSpeed: number, baseRevision: number) =>
  JSON.stringify({
    name: "updateCharacter",
    input: { characterId: "player", changes: { stats: { runSpeed } } },
    baseRevision,
  });

describe("project HTTP API", () => {
  it("serves the project and applies operations", async () => {
    const initial = await (await get("/api/project")).json();
    expect(initial).toMatchObject({ project: { revision: 0 }, canUndo: false });

    const res = await post("/api/ops", op(150, 0));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, project: { revision: 1 }, canUndo: true });
  });

  it("maps failures to status codes with structured bodies", async () => {
    expect((await post("/api/ops", "{not json")).status).toBe(400);
    expect((await post("/api/ops", op(-1, 0))).status).toBe(422);
    const stale = await post("/api/ops", op(150, 7));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, error: { code: "stale_revision" } });
    expect((await post("/api/undo", JSON.stringify({ baseRevision: 0 }))).status).toBe(409);
    expect((await get("/api/nope")).status).toBe(404);
  });

  it("passes non-API requests through", async () => {
    expect((await fetch(`${base}/index.html`)).status).toBe(418);
  });

  it("streams the current project, then changes", async () => {
    const res = await get("/api/events?clientId=test");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const nextEvent = async () => {
      let buffer = "";
      while (!buffer.includes("\n\n")) buffer += (await reader.read()).value ?? "";
      return JSON.parse(buffer.trim().replace(/^data: /, ""));
    };

    expect(await nextEvent()).toMatchObject({ type: "project", project: { revision: 0 }, cause: null });
    await post("/api/ops", op(150, 0));
    expect(await nextEvent()).toMatchObject({ project: { revision: 1 }, cause: { author: "user" } });
    await reader.cancel();
  });

  it("releases the playtest lock when the holder's event stream closes", async () => {
    const controller = new AbortController();
    const stream = await get("/api/events?clientId=tab_a", { signal: controller.signal });
    await stream.body!.getReader().read(); // connected

    await post("/api/playtest", JSON.stringify({ active: true, clientId: "tab_a" }));
    expect((await post("/api/ops", op(150, 0))).status).toBe(409);

    controller.abort();
    await expect.poll(async () => (await post("/api/ops", op(150, 0))).status).toBe(200);
  });
});

describe("studio token", () => {
  it("rejects API requests without the token", async () => {
    const res = await fetch(`${base}/api/project`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect((await fetch(`${base}/api/project`, { headers: { "x-studio-token": "wrong" } })).status).toBe(401);
    expect(
      (await fetch(`${base}/api/ops`, { method: "POST", body: op(150, 0), headers: { "content-type": "application/json" } }))
        .status,
    ).toBe(401);
  });

  it("trades ?token= on a page load for a cookie and a clean URL", async () => {
    const res = await fetch(`${base}/?token=${TOKEN}&x=1`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?x=1");
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(`anomaly_token=${TOKEN}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");

    const cookie = setCookie.split(";")[0]!;
    expect((await fetch(`${base}/api/project`, { headers: { cookie } })).status).toBe(200);
  });

  it("ignores a wrong ?token= and leaves non-API requests alone", async () => {
    const wrong = await fetch(`${base}/?token=nope`, { redirect: "manual" });
    expect(wrong.status).toBe(418); // passed through to the next handler, no cookie
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect((await fetch(`${base}/game/index.html`)).status).toBe(418);
  });
});
