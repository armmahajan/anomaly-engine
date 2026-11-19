import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeImageModel, FakeRenderer, FakeVisionModel } from "@anomaly/art";
import { gameArtPlan, type ArtState, type ChangeResult, type ProjectState } from "@anomaly/core";
import { callTools, FakeModel, runAgentTurn, say, toolCall, type TurnRunner } from "@anomaly/agent";
import { createProjectServer, type ArtService } from "../src/index.ts";

const TOKEN = "test-token";
const headers = { "x-studio-token": TOKEN, "content-type": "application/json" };
const noChat: TurnRunner = async () => {
  throw new Error("chat is not used here");
};

let dir: string;
let server: Server;
let base: string;
let art: ArtService;
let vision: FakeVisionModel;

async function start(options: { budget?: number; models?: boolean; runner?: TurnRunner } = {}) {
  dir = await mkdtemp(join(tmpdir(), "anomaly-art-"));
  vision = new FakeVisionModel();
  const created = await createProjectServer(dir, {
    token: TOKEN,
    runner: options.runner ?? noChat,
    art: {
      models: options.models === false ? null : { image: new FakeImageModel(), vision },
      renderer: new FakeRenderer(),
      budget: options.budget ?? 0.25,
      unavailableReason: "needs a key",
    },
  });
  art = created.art!;
  server = createServer((req, res) => created.handler(req, res, () => res.end()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => start());
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const post = async (path: string, body: unknown) =>
  (await (await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })).json()) as { ok: boolean; error?: { code: string; message: string } };
const get = async <T>(path: string) => (await (await fetch(base + path, { headers })).json()) as T;

describe("art jobs over HTTP", () => {
  it("runs an auto job: one saved AI change per stage, files stored and served, costs logged", async () => {
    expect(await post("/api/art/jobs", { stage: "auto", characterId: "charger", brief: "a horned beetle" })).toMatchObject({ ok: true });
    await art.idle();

    const state = await get<ArtState>("/api/art");
    const job = state.jobs.at(-1)!;
    expect(job).toMatchObject({ outcome: "committed", stage: "auto", characterId: "charger" });
    expect(job.revisions).toHaveLength(4);
    expect(job.cost).toBeGreaterThan(0);
    expect(state.totalCost).toBeCloseTo(job.cost);
    expect(state.running).toBeNull();

    const { project } = await get<ProjectState>("/api/project");
    const asset = project.art.assets[0]!;
    expect(project.characters.find((c) => c.id === "charger")?.appearance).toBe(asset.id);
    expect(asset.kind === "character" && asset.rig?.parts.length).toBeGreaterThan(0);
    expect(asset.kind === "character" && Object.keys(asset.clips).sort()).toEqual(["attack", "death", "idle", "walk", "windup"]);

    const stored = await readdir(join(dir, "files"));
    expect(stored.length).toBeGreaterThan(3);
    const res = await fetch(`${base}/api/files/${asset.concepts[0]!.file}`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${base}/api/files/..%2Fproject.json`, { headers })).status).toBe(404);

    // The job log survives a restart.
    expect((await readFile(join(dir, "art-jobs.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);

    // Each stage is its own undo step: undo removes the animations only.
    const undone = (await post("/api/undo", { baseRevision: project.revision })) as unknown as ChangeResult;
    expect(undone.ok && undone.project.art.assets[0]).toMatchObject({ clips: {} });
  });

  it("doesn't lock the creator out while a job runs (another job queues), and cancel saves nothing more", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = vision.complete.bind(vision);
    vision.complete = async (request) => {
      await gate;
      return original(request);
    };
    expect(await post("/api/art/jobs", { stage: "concepts", characterId: "charger" })).toMatchObject({ ok: true });
    const { project } = await get<ProjectState>("/api/project");
    const edit = await post("/api/ops", {
      name: "moveRoomSpawn",
      input: { roomId: "arena", spawnId: "crawler_1", x: 10 },
      baseRevision: project.revision,
    });
    expect(edit).toMatchObject({ ok: true });
    // Another job on the same character waits for this one.
    expect(await post("/api/art/jobs", { stage: "concepts", characterId: "charger", feedback: "taller" })).toMatchObject({ ok: true, queued: true });
    expect((await get<ArtState>("/api/art")).pending).toEqual([{ stage: "concepts", characterId: "charger" }]);

    await post("/api/art/cancel", {});
    release();
    await art.idle();
    expect((await get<ArtState>("/api/art")).jobs.at(-1)?.outcome).toBe("cancelled");
    expect((await get<ProjectState>("/api/project")).project.art.assets).toEqual([]);
  });

  it("reports stage order problems and unknown characters clearly", async () => {
    expect(await post("/api/art/jobs", { stage: "rig", characterId: "charger" })).toMatchObject({ ok: true });
    await art.idle();
    const job = (await get<ArtState>("/api/art")).jobs.at(-1)!;
    expect(job.outcome).toBe("failed");
    expect(job.error).toMatch(/no art yet/);
    expect((await post("/api/art/jobs", { stage: "rig", characterId: "ghost" })).error?.code).toBe("not_found");
  });

  it("stops a job that goes over budget", async () => {
    await rm(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await start({ budget: 0.0025 });
    await post("/api/art/jobs", { stage: "auto", characterId: "charger" });
    await art.idle();
    const job = (await get<ArtState>("/api/art")).jobs.at(-1)!;
    expect(job.outcome).toBe("over_budget");
  });

  it("refuses jobs without models, with the reason", async () => {
    await rm(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await start({ models: false });
    expect((await get<ArtState>("/api/art")).available).toBe(false);
    expect(await post("/api/art/jobs", { stage: "concepts", characterId: "charger" })).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: "needs a key" },
    });
  });
});

describe("world jobs over HTTP", () => {
  it("a new biome gets its kit and a first room (two AI changes), and can dress the arena", async () => {
    expect(await post("/api/art/jobs", { stage: "worldKit", brief: "a fungal cathedral", quality: "draft", dressRoom: "arena" })).toMatchObject({ ok: true });
    await art.idle();
    const job = (await get<ArtState>("/api/art")).jobs.at(-1)!;
    expect(job).toMatchObject({ outcome: "committed", stage: "worldKit", biomeId: "a_fungal_cathedral" });
    expect(job.revisions).toHaveLength(2);
    const { project } = await get<ProjectState>("/api/project");
    const biome = project.art.assets.find((a) => a.kind === "biome")!;
    expect(biome.kind === "biome" && biome.kit?.pieces.length).toBeGreaterThan(0);
    expect(biome.kind === "biome" && biome.rooms).toHaveLength(1);
    expect(project.world.rooms[0]!.dressing).toMatchObject({ biome: biome.id, room: biome.kind === "biome" ? biome.rooms[0]!.id : "" });

    // More rooms are one cheap call each; a repaint redoes one part of the kit.
    expect(await post("/api/art/jobs", { stage: "worldCompose", biomeId: biome.id, newLayout: true })).toMatchObject({ ok: true });
    await art.idle();
    expect(await post("/api/art/jobs", { stage: "worldRepaint", biomeId: biome.id, part: "backdrop" })).toMatchObject({ ok: true });
    await art.idle();
    const after = (await get<ProjectState>("/api/project")).project.art.assets.find((a) => a.id === biome.id)!;
    expect(after.kind === "biome" && after.rooms).toHaveLength(2);
    expect((await get<ArtState>("/api/art")).jobs.at(-1)!.revisions).toHaveLength(1); // a backdrop doesn't move pieces

    // New piece sheets hold different pieces, so every room is recomposed to fit them (same rooms, same ids).
    expect(await post("/api/art/jobs", { stage: "worldRepaint", biomeId: biome.id, part: "props" })).toMatchObject({ ok: true });
    await art.idle();
    const repaint = (await get<ArtState>("/api/art")).jobs.at(-1)!;
    expect(repaint).toMatchObject({ outcome: "committed" });
    expect(repaint.revisions).toHaveLength(3);
    const recomposed = (await get<ProjectState>("/api/project")).project.art.assets.find((a) => a.id === biome.id)!;
    expect(recomposed.kind === "biome" && recomposed.rooms.map((r) => r.id)).toEqual(after.kind === "biome" ? after.rooms.map((r) => r.id) : []);
    expect(after.kind === "biome" && biome.kind === "biome" && after.kit!.backdrop).not.toBe(biome.kit!.backdrop);
  });

  it("the game-art job draws everything the plan lists, each step saved; leaving only what the models did not make", async () => {
    await start({ budget: 0.05 }); // the job's own budget comes from its plan
    expect(gameArtPlan((await get<ProjectState>("/api/project")).project).map((s) => s.id)).toEqual([
      "character:player",
      "character:crawler",
      "character:charger",
      "biome:world",
      "room:arena",
    ]);
    expect(await post("/api/art/jobs", { stage: "gameArt" })).toMatchObject({ ok: true });
    await art.idle();
    const job = (await get<ArtState>("/api/art")).jobs.at(-1)!;
    expect(job).toMatchObject({ outcome: "committed", stage: "gameArt" });
    expect(job.revisions.length).toBe(3 * 4 + 2); // four stages per character, kit, room
    const { project } = await get<ProjectState>("/api/project");
    expect(project.characters.every((c) => project.art.assets.some((a) => a.id === c.appearance && a.kind === "character" && a.rig))).toBe(true);
    expect(project.world.rooms[0]!.dressing?.tiles).toBeTruthy();
    // Only animations are left: the fake model always returns the same few clips.
    expect(gameArtPlan(project).map((s) => [s.kind, s.reason])).toEqual([["character", "incomplete"], ["character", "incomplete"], ["character", "incomplete"]]);
  });

  it("writes the art direction from the wiki first (its own job, and the game-art job's first step)", async () => {
    const overview = { id: "overview", kind: "overview", title: "Tidewinder", summary: "A courier crosses sunlit seas.", body: "", fields: { tone: "playful" }, status: "canon" };
    let { project } = await get<ProjectState>("/api/project");
    expect((await post("/api/ops", { name: "createWikiPage", input: { page: overview }, baseRevision: project.revision })).ok).toBe(true);
    project = (await get<ProjectState>("/api/project")).project;
    expect(gameArtPlan(project)[0]!.id).toBe("direction");
    expect(await post("/api/art/jobs", { stage: "artDirection" })).toMatchObject({ ok: true });
    await art.idle();
    const job = (await get<ArtState>("/api/art")).jobs.at(-1)!;
    expect(job).toMatchObject({ outcome: "committed", stage: "artDirection", summary: "wrote the art direction from the wiki" });
    project = (await get<ProjectState>("/api/project")).project;
    expect(project.art.direction.style).toContain("Tidewinder");
    expect(gameArtPlan(project).some((s) => s.id === "direction")).toBe(false);
  });

  it("validates world requests", async () => {
    expect((await post("/api/art/jobs", { stage: "worldCompose" })).error?.code).toBe("invalid_request");
    expect((await post("/api/art/jobs", { stage: "worldKit" })).error?.code).toBe("invalid_request");
    expect((await post("/api/art/jobs", { stage: "worldCompose", biomeId: "nope" })).error?.code).toBe("not_found");
    expect((await post("/api/art/jobs", { stage: "rig" })).error?.code).toBe("invalid_request");
  });
});

describe("art jobs from the chat", () => {
  it("a chat turn queues a world; it runs after the turn as its own AI changes", async () => {
    await rm(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await start({
      runner: (request) =>
        runAgentTurn({
          ...request,
          model: new FakeModel([callTools(toolCall("generateWorld", { theme: "a sunken garden of giant ferns" })), say("Painting a sunken garden.")]),
        }),
    });
    expect(await post("/api/chat", { message: "make me a sunken garden world" })).toMatchObject({ ok: true });
    await expect.poll(async () => (await get<ArtState>("/api/art")).jobs.length, { timeout: 10_000 }).toBe(1);
    await art.idle();
    const job = (await get<ArtState>("/api/art")).jobs.at(-1)!;
    expect(job).toMatchObject({ stage: "worldKit", outcome: "committed" });
    const { project } = await get<ProjectState>("/api/project");
    expect(project.art.assets.find((a) => a.kind === "biome")?.name).toBe("A sunken garden of giant ferns");
    const chat = await get<{ entries: { role: string; changes?: string[] }[] }>("/api/chat");
    expect(chat.entries.at(-1)?.changes).toEqual([expect.stringMatching(/^queued: paint world/)]);
  });

  it("the art tools refuse when art generation is off", async () => {
    await rm(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    let result: unknown;
    await start({
      models: false,
      runner: async (request) => {
        const turn = await runAgentTurn({
          ...request,
          model: new FakeModel([callTools(toolCall("generateWorld", { theme: "a garden" })), say("ok")]),
          onEvent: (e) => {
            if (e.type === "tool_result") result = e.result;
          },
        });
        return turn;
      },
    });
    await post("/api/chat", { message: "world please" });
    await expect.poll(() => result, { timeout: 10_000 }).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
