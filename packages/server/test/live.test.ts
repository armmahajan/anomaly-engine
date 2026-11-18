import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeImageModel, FakeRenderer, FakeVisionModel } from "@anomaly/art";
import type { ProjectSpec } from "@anomaly/core";
import { callTools, FakeModel, runAgentTurn, say, toolCall, type TurnRunner } from "@anomaly/agent";
import { ArchitectService, createProjectServer, defaultStageRunners, modelStageRunners } from "../src/index.ts";

type Server = Awaited<ReturnType<typeof createProjectServer>>;

let dir: string;
let server: Server;
let vision: FakeVisionModel;
afterEach(async () => {
  server.live.close();
  await server.art?.reset();
  await rm(dir, { recursive: true, force: true });
});

const page = (id: string, title: string, fields: Record<string, string>) => toolCall("createWikiPage", { page: { id, kind: "character", title, summary: `${title}, in short.`, fields } });

/** The director drafts the player, two enemies and a story-only character. */
const draftCast: TurnRunner = (request) =>
  runAgentTurn({
    ...request,
    model: new FakeModel([
      callTools(
        page("lamplighter", "The Lamplighter", { role: "protagonist", in_game: "player", appearance: "a small figure with a lantern" }),
        page("moth_knight", "Moth Knight", { role: "guardian of the bell", in_game: "enemy (boss)", appearance: "dusty wings, a pale lance" }),
        page("grub", "Lamp Grub", { role: "vermin", in_game: "enemy" }),
        page("old_sage", "The Old Sage", { role: "mentor", in_game: "none" }),
      ),
      say("Drafted the cast."),
    ]),
  });

const PROWL = { initial: "prowl", states: { prowl: { action: { type: "patrol", speed: 180, distance: 300, turnAtLedge: true, turnAtWall: true }, transitions: [] } }, interrupts: [] };

/** The build assistant writes a behavior for every character the live cast asks about. */
const behaviors: TurnRunner = (request) => {
  const list = /their behavior: (.+?)\. They were/.exec(request.userMessage)?.[1] ?? "";
  const ids = list.split(", ").map((s) => s.split(" ")[0]!);
  return runAgentTurn({ ...request, model: new FakeModel([callTools(...ids.map((characterId) => toolCall("setBehavior", { characterId, behavior: PROWL }))), say("Done.")]) });
};

let builderCalls: string[] = [];
const runner: TurnRunner = (request) => {
  if (request.agent?.id === "narrative") return draftCast(request);
  builderCalls.push(request.userMessage);
  return behaviors(request);
};

async function open(options: { cast?: boolean; rooms?: boolean; worker?: boolean; debounceMs?: number } = {}) {
  dir = await mkdtemp(join(tmpdir(), "anomaly-live-"));
  vision = new FakeVisionModel();
  builderCalls = [];
  server = await createProjectServer(dir, {
    token: "t",
    runner,
    art: { models: { image: new FakeImageModel(), vision }, renderer: new FakeRenderer(), budget: 0.25 },
    live: { cast: options.cast ?? false, rooms: options.rooms ?? false, debounceMs: options.debounceMs ?? 10, worker: options.worker },
  });
  return server;
}

const project = () => server.store.getState().project;
const op = (name: string, input: unknown, baseRevision = project().revision) => server.store.applyOperation({ name, input, baseRevision, author: "user" });
const ok = async (result: Promise<{ ok: boolean; error?: { message: string } }>) => {
  const r = await result;
  if (!r.ok) throw new Error(r.error?.message);
  return r;
};

/** Hold the fake vision model's calls until released. */
function gateVision() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = vision.complete.bind(vision);
  vision.complete = async (request) => {
    await gate;
    return original(request);
  };
  return release;
}

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("the live cast", () => {
  it("makes the director's game characters: enemies created and linked, behaviors written, art for all three; story-only pages ignored", async () => {
    const { chats, live, art } = await open({ cast: true });
    expect(await chats.narrative.send({ message: "Draft the cast" })).toEqual({ ok: true });
    await chats.narrative.idle();
    await live.idle();
    await art!.drained();

    const p = project();
    const enemies = p.characters.filter((c) => c.kind === "enemy" && ["moth_knight", "grub"].includes(c.id));
    expect(enemies.map((c) => [c.id, c.name, c.kind === "enemy" && c.behavior.initial])).toEqual([
      ["moth_knight", "Moth Knight", "prowl"],
      ["grub", "Lamp Grub", "prowl"],
    ]);
    const linked = Object.fromEntries(p.wiki.pages.map((pg) => [pg.id, pg.characterId]));
    expect(linked).toMatchObject({ lamplighter: "player", moth_knight: "moth_knight", grub: "grub", old_sage: undefined });
    expect(p.characters.find((c) => c.kind === "player")!.name).toBe("The Lamplighter");
    expect(p.characters.some((c) => c.id === "old_sage")).toBe(false);
    // One build turn for both, at first-region strength.
    expect(builderCalls).toHaveLength(1);
    expect(builderCalls[0]).toContain("first-region strength");
    // Art for all three, briefed from their pages.
    const drawn = art!.getState().jobs.filter((j) => j.stage === "auto" && j.outcome === "committed").map((j) => j.characterId);
    expect(drawn.sort()).toEqual(["grub", "moth_knight", "player"]);
    for (const id of ["player", "moth_knight", "grub"]) {
      const asset = p.art.assets.find((a) => a.id === project().characters.find((c) => c.id === id)!.appearance);
      expect(asset).toBeDefined();
    }
    expect(project().art.assets.find((a) => a.name === "Moth Knight")).toMatchObject({ brief: expect.stringContaining("dusty wings") });
    expect(live.getState().cast).toMatchObject({ working: [], error: null });

    // Each page is handled once: undoing the characters doesn't bring them back.
    const handledRevision = project().revision;
    await ok(op("deleteCharacter", { characterId: "grub" }));
    await live.idle();
    expect(project().characters.some((c) => c.id === "grub")).toBe(false);
    expect(project().revision).toBe(handledRevision + 1);
  });

  it("links an unlinked enemy that has the page's id instead of making another; pages already linked are only drawn", async () => {
    const { live, art } = await open({ cast: true });
    await ok(op("createWikiPage", { page: { id: "crawler", kind: "character", title: "Crawler", fields: { in_game: "enemy" }, status: "canon" } }));
    await live.idle();
    await art!.drained();
    expect(project().wiki.pages.find((p) => p.id === "crawler")!.characterId).toBe("crawler");
    expect(project().characters.filter((c) => c.id.startsWith("crawler")).map((c) => c.id)).toEqual(["crawler"]);
    expect(builderCalls).toEqual([]); // nothing new to write a behavior for
    expect(art!.getState().jobs.map((j) => [j.stage, j.characterId, j.outcome])).toEqual([["auto", "crawler", "committed"]]);
  });
});

describe("background work and the creator", () => {
  it("while an art job runs, the creator's wiki edits and a director turn go through; the job's saves wait for the turn and land on top", async () => {
    const { chats, art, store } = await open();
    let releaseChat!: () => void;
    const chatGate = new Promise<void>((resolve) => (releaseChat = resolve));
    const releaseVision = gateVision();
    expect(await art!.start({ stage: "concepts", characterId: "charger", brief: "a horned beetle" })).toMatchObject({ ok: true });
    expect(art!.getState().running).toMatchObject({ underLock: false });

    // The creator edits the wiki while the job runs.
    const before = project().revision;
    await ok(op("createWikiPage", { page: { id: "notes", kind: "lore", title: "Notes", status: "canon" } }));
    // A second job queues instead of failing.
    expect(await art!.start({ stage: "concepts", characterId: "crawler", brief: "a slug" })).toMatchObject({ ok: true, queued: true });
    expect(art!.getState().pending).toEqual([{ stage: "concepts", characterId: "crawler" }]);

    // A director turn runs (and holds the project) while the job finishes its stage.
    const original = chats.narrative;
    const slowDirector: TurnRunner = async (request) => {
      await chatGate;
      return draftCast(request);
    };
    const director = await (await import("../src/chat.ts")).ChatService.open(store, slowDirector, original.agent);
    expect(await director.send({ message: "Draft the cast" })).toEqual({ ok: true });
    releaseVision();
    await until(() => art!.getState().running?.waiting === "the AI is working on the project");
    expect(project().art.assets).toEqual([]); // nothing saved under the turn
    releaseChat();
    await director.idle();
    await art!.drained();

    const history = store.getHistory().slice(-4);
    expect(history.map((h) => h.author)).toEqual(["user", "ai", "ai", "ai"]);
    expect(history[1]!.summary).toContain("createWikiPage"); // the director's turn first
    expect(project().wiki.pages.some((p) => p.id === "notes")).toBe(true);
    expect(project().wiki.pages.some((p) => p.id === "moth_knight")).toBe(true);
    expect(project().art.assets.map((a) => a.name).sort()).toEqual(["Charger", "Crawler"]);
    expect(project().revision).toBe(before + 4);

    // An edit made on the revision before a background save still applies; undo stays strict.
    const stale = project().revision - 1;
    expect(await op("updateWikiPage", { pageId: "notes", changes: { summary: "kept" } }, stale)).toMatchObject({ ok: true });
    expect((await store.undo({ baseRevision: project().revision - 1, author: "user" })).ok).toBe(false);
  });

  it("a background save that no longer applies fails the job cleanly (its character was deleted meanwhile)", async () => {
    const { art } = await open();
    const release = gateVision();
    await art!.start({ stage: "auto", characterId: "charger", brief: "a horned beetle" });
    await ok(op("deleteCharacter", { characterId: "charger" }));
    release();
    await art!.drained();
    const job = art!.getState().jobs.at(-1)!;
    expect(job.outcome).toBe("failed");
    expect(job.error).toMatch(/charger/);
    expect(project().characters.some((c) => c.id === "charger")).toBe(false);
  });

  it("background saves wait while a playtest runs, then land", async () => {
    const { live, store, art } = await open({ cast: true, debounceMs: 30 });
    await ok(op("createWikiPage", { page: { id: "grub", kind: "character", title: "Lamp Grub", fields: { in_game: "enemy" }, status: "canon" } }));
    const revision = project().revision;
    expect(await store.setPlaytest({ active: true, clientId: "studio" })).toMatchObject({ ok: true });
    await until(() => live.getState().waiting === "a playtest is running" && live.getState().cast.working.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(project().revision).toBe(revision);
    expect(project().characters.some((c) => c.id === "grub")).toBe(false);
    await store.setPlaytest({ active: false, clientId: "studio" });
    await live.idle();
    await art!.drained();
    expect(project().characters.some((c) => c.id === "grub")).toBe(true);
    expect(project().revision).toBeGreaterThan(revision);
    // Only background saves since the creator's last look: a reset (which replaces everything) still goes through.
    expect((await store.reset({ baseRevision: revision })).ok).toBe(true);
  });

  it("the Architect's game-art job makes a running background art job stop (it draws what is missing)", async () => {
    const { art, store } = await open();
    const release = gateVision();
    await art!.start({ stage: "concepts", characterId: "charger", brief: "a horned beetle" });
    const architect = new ArchitectService(store, defaultStageRunners({ art }));
    expect(await architect.start({ from: "art", to: "art" })).toEqual({ ok: true });
    release();
    await architect.idle();
    const jobs = art!.getState().jobs;
    expect(jobs.map((j) => [j.stage, j.outcome])).toEqual([
      ["concepts", "cancelled"],
      ["gameArt", "committed"],
    ]);
  });
});

/** Two regions joined, a dash found in the second: rooms for each, with a start and an ending. */
async function draftProgression() {
  await ok(op("createRegion", { region: { id: "gate", name: "Sunken Gate", rooms: 2, enemies: ["crawler"], status: "draft" } }));
  await ok(op("createRegion", { region: { id: "city", name: "Drowned City", rooms: 3, enemies: ["charger"], status: "draft" } }));
  await ok(op("createAbility", { ability: { id: "dash", name: "Dash", mechanic: "dash", obtainedIn: { regionId: "city", source: "pickup" }, status: "draft" } }));
  await ok(op("createConnection", { connection: { id: "gate_city", from: "gate", to: "city", status: "draft" } }));
  await ok(op("setProgressionEnds", { start: "gate", ending: "city" }));
}

const regionRooms = (p: ProjectSpec) => p.world.rooms.filter((r) => r.regionId !== undefined);

describe("the live rooms", () => {
  it("builds proven rooms for the progression's regions, and rebuilds them when it changes", async () => {
    const { live } = await open({ rooms: true });
    await draftProgression();
    await live.idle();
    let p = project();
    expect(p.architect.rooms.map((r) => r.id)).toEqual(["gate_1", "gate_2", "city_1", "city_2", "city_3"]);
    expect(regionRooms(p).map((r) => [r.id, r.regionId])).toEqual(p.architect.rooms.map((r) => [r.id, r.regionId]));
    expect(p.architect.stages.geometry).toMatchObject({ status: "done" });
    expect(p.architect.stages.plan).toBeUndefined();
    expect(p.world.start?.room).toBe("gate_1");
    expect(p.world.playtest?.room).toBe("arena"); // the creator's playtest spot stays
    expect(live.getState().rooms).toMatchObject({ status: "idle", error: null, message: expect.stringContaining("built 5 of 5 room(s)") });
    expect(server.store.getHistory().at(-1)).toMatchObject({ author: "ai", summary: expect.stringContaining("architect preview") });

    await ok(op("updateRegion", { regionId: "city", changes: { rooms: 1 } }));
    await live.idle();
    p = project();
    expect(p.architect.rooms.map((r) => r.id)).toEqual(["gate_1", "gate_2", "city_1"]);
    expect(regionRooms(p).map((r) => r.id)).toEqual(["gate_1", "gate_2", "city_1"]);
  });

  it("stops rebuilding once the creator edits the plan, and marks the Architect's stages stale instead", async () => {
    const { live } = await open({ rooms: true });
    await draftProgression();
    await live.idle();
    await ok(op("updateRoomPlan", { roomId: "city_1", changes: { notes: "a quiet square" } }));
    const plan = project().architect.rooms;
    await ok(op("updateRegion", { regionId: "city", changes: { rooms: 1 } }));
    await live.idle();
    const p = project();
    expect(p.architect.rooms).toEqual(plan);
    expect(p.architect.stages.geometry?.status).toBe("stale");
    expect(regionRooms(p)).toHaveLength(5);
    expect(live.getState().rooms.message).toContain("marked stale");
  });

  it("never touches a pinned room: pinning one stops the rebuilds", async () => {
    const { live } = await open({ rooms: true, worker: false });
    await draftProgression();
    await live.idle();
    await ok(op("setRoomPinned", { roomId: "gate_2", pinned: true }));
    const pinned = project().world.rooms.find((r) => r.id === "gate_2");
    await ok(op("updateRegion", { regionId: "gate", changes: { rooms: 1 } }));
    await live.idle();
    expect(project().world.rooms.find((r) => r.id === "gate_2")).toEqual(pinned);
    expect(project().architect.rooms.map((r) => r.id)).toContain("gate_2");
    expect(project().architect.stages.layout?.status).toBe("stale");
  });

  it("the Architect's model plan treats an untouched preview as a fresh plan, and its run takes the plan over", async () => {
    const { live } = await open({ rooms: true, worker: false });
    await draftProgression();
    await live.idle();
    const messages: string[] = [];
    const planner: TurnRunner = (request) => {
      messages.push(request.userMessage);
      return runAgentTurn({ ...request, model: new FakeModel([say("Planned.")]) });
    };
    const architect = new ArchitectService(server.store, defaultStageRunners({ overrides: modelStageRunners(planner) }));
    expect(await architect.start({ to: "plan" })).toEqual({ ok: true });
    await architect.idle();
    expect(messages[0]).toMatch(/^Plan the game world now/);
    expect(project().architect.stages.plan?.status).toBe("done");
    // From now on a progression change marks stages stale instead of rebuilding.
    const plan = project().architect.rooms;
    await ok(op("updateRegion", { regionId: "gate", changes: { rooms: 1 } }));
    await live.idle();
    expect(project().architect.rooms).toEqual(plan);
    expect(project().architect.stages.plan?.status).toBe("stale");
  });

  it("an undone preview isn't rebuilt until the progression changes again", async () => {
    const { live, store } = await open({ rooms: true });
    await draftProgression();
    await live.idle();
    expect((await store.undo({ baseRevision: project().revision, author: "user" })).ok).toBe(true);
    await live.idle();
    expect(project().architect.rooms).toEqual([]);
    await ok(op("updateRegion", { regionId: "gate", changes: { name: "The Gate" } }));
    await live.idle();
    expect(project().architect.rooms.map((r) => r.name)[0]).toBe("The Gate 1");
  });
});
