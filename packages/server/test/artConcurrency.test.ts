import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeImageModel, FakeRenderer, FakeVisionModel, type GeneratedImage, type ImageRequest } from "@anomaly/art";
import { createDefaultProject, type ArtState, type ProjectSpec } from "@anomaly/core";
import type { TurnRunner } from "@anomaly/agent";
import { createProjectServer, ProjectStore, type ArtService } from "../src/index.ts";

const noChat: TurnRunner = async () => {
  throw new Error("chat is not used here");
};

/** Images that wait for `release()` while held, and count how many are painted at once. */
class GatedImage extends FakeImageModel {
  inFlight = 0;
  most = 0;
  private gate: Promise<void> | null = null;
  private open: () => void = () => {};

  hold(): void {
    this.gate = new Promise((resolve) => (this.open = resolve));
  }

  release(): void {
    this.gate = null;
    this.open();
  }

  override async generate(request: ImageRequest): Promise<GeneratedImage> {
    this.inFlight++;
    this.most = Math.max(this.most, this.inFlight);
    try {
      if (this.gate) await this.gate;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await super.generate(request);
    } finally {
      this.inFlight--;
    }
  }
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function open(options: { concurrency?: number; budget?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "anomaly-artc-"));
  dirs.push(dir);
  const image = new GatedImage();
  const created = await createProjectServer(dir, {
    token: "t",
    runner: noChat,
    art: {
      models: { image, vision: new FakeVisionModel() },
      renderer: new FakeRenderer(),
      budget: options.budget ?? 0.25,
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    },
  });
  const art = created.art!;
  // Every state the studio would see, to check what ran together.
  const states: ArtState[] = [];
  art.subscribe((s) => states.push(s));
  return { art, store: created.store, image, states };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const running = (art: ArtService) => art.getState().runningJobs.map((j) => `${j.stage}:${j.characterId ?? j.biomeId ?? ""}`);

describe("art jobs at once", () => {
  it("runs jobs that touch different characters together (default 3 at once); one on the same character queues and starts after", async () => {
    const { art, store, image, states } = await open();
    expect(art.getState().concurrency).toBe(3);
    image.hold();
    const a = await art.start({ stage: "concepts", characterId: "charger", brief: "a horned beetle" });
    const b = await art.start({ stage: "concepts", characterId: "crawler", brief: "a slug" });
    expect(a).toMatchObject({ ok: true, jobId: expect.stringMatching(/^art_/) });
    expect(b).toMatchObject({ ok: true, jobId: expect.stringMatching(/^art_/) });
    expect(a.ok && b.ok && a.jobId !== b.jobId).toBe(true);
    expect(running(art)).toEqual(["concepts:charger", "concepts:crawler"]);
    expect(art.getState().running?.characterId).toBe("charger"); // the oldest, for older readers
    await until(() => image.inFlight === 2);

    // The same character: waits for its running job.
    expect(await art.start({ stage: "concepts", characterId: "charger", feedback: "taller" })).toMatchObject({ ok: true, queued: true });
    expect(art.getState().pending).toEqual([{ stage: "concepts", characterId: "charger" }]);
    image.release();
    await art.drained();

    const jobs = art.getState().jobs;
    expect(jobs.map((j) => [j.characterId, j.outcome])).toEqual(
      expect.arrayContaining([
        ["charger", "committed"],
        ["crawler", "committed"],
      ]),
    );
    expect(jobs.filter((j) => j.outcome === "committed")).toHaveLength(3);
    // The queued charger job never ran beside the first one.
    for (const s of states) expect(s.runningJobs.filter((j) => j.characterId === "charger").length).toBeLessThanOrEqual(1);
    expect(states.some((s) => s.runningJobs.length === 2)).toBe(true);
    const charger = store.getState().project.art.assets.find((x) => x.name === "Charger");
    expect(charger?.kind === "character" && charger.concepts).toHaveLength(2);
    // Each job saved its own revisions; together they are every AI revision since.
    const revisions = jobs.flatMap((j) => j.revisions).sort((x, y) => x - y);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(revisions.at(-1)).toBe(store.getState().project.revision);
  });

  it("STUDIO_ART_CONCURRENCY=1 keeps one job at a time", async () => {
    const { art, image } = await open({ concurrency: 1 });
    image.hold();
    expect(await art.start({ stage: "concepts", characterId: "charger", brief: "a beetle" })).toMatchObject({ ok: true });
    expect(await art.start({ stage: "concepts", characterId: "crawler", brief: "a slug" })).toMatchObject({ ok: true, queued: true });
    expect(running(art)).toEqual(["concepts:charger"]);
    image.release();
    await art.drained();
    expect(image.most).toBe(1);
    expect(art.getState().jobs.map((j) => j.outcome)).toEqual(["committed", "committed"]);
  });

  it("the art direction and game art run alone, and later jobs don't pass them in the queue", async () => {
    const { art, image } = await open();
    image.hold();
    await art.start({ stage: "concepts", characterId: "charger", brief: "a beetle" });
    expect(await art.start({ stage: "gameArt" })).toMatchObject({ queued: true });
    // Touches nothing the running job touches, but the queued game-art job comes first.
    expect(await art.start({ stage: "concepts", characterId: "crawler", brief: "a slug" })).toMatchObject({ queued: true });
    expect(art.getState().pending.map((p) => p.stage)).toEqual(["gameArt", "concepts"]);
    image.release();
    await until(() => art.getState().runningJobs.some((j) => j.stage === "gameArt"));
    expect(running(art)).toEqual(["gameArt:"]);
    expect(art.getState().pending.map((p) => p.stage)).toEqual(["concepts"]);
    await art.drained();
    expect(art.getState().jobs.map((j) => j.stage)).toEqual(["concepts", "gameArt", "concepts"]);
  });

  it("cancels one job by id; the other keeps going and saves", async () => {
    const { art, store, image } = await open();
    image.hold();
    const a = await art.start({ stage: "concepts", characterId: "charger", brief: "a beetle" });
    const b = await art.start({ stage: "concepts", characterId: "crawler", brief: "a slug" });
    if (!a.ok || !b.ok) throw new Error("not started");
    expect(art.cancel("nope")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(art.cancel(a.jobId)).toEqual({ ok: true });
    image.release();
    expect(await art.finished(a.jobId)).toMatchObject({ outcome: "cancelled", revisions: [] });
    expect(await art.finished(b.jobId)).toMatchObject({ outcome: "committed" });
    expect(store.getState().project.art.assets.map((x) => x.name)).toEqual(["Crawler"]);
  });

  it("each job has its own budget", async () => {
    // What one concepts job costs with the fake models.
    const probe = await open();
    await probe.art.start({ stage: "concepts", characterId: "charger", brief: "a beetle" });
    await probe.art.drained();
    const cost = probe.art.getState().jobs[0]!.cost;
    expect(cost).toBeGreaterThan(0);

    // A budget for one job, not two: both still finish, side by side.
    const { art, image } = await open({ budget: cost * 1.5 });
    image.hold();
    await art.start({ stage: "concepts", characterId: "charger", brief: "a beetle" });
    await art.start({ stage: "concepts", characterId: "crawler", brief: "a slug" });
    await until(() => image.inFlight === 2);
    image.release();
    await art.drained();
    const jobs = art.getState().jobs;
    expect(jobs.map((j) => j.outcome)).toEqual(["committed", "committed"]);
    expect(jobs.map((j) => j.cost)).toEqual([cost, cost]);
    expect(art.getState().totalCost).toBeCloseTo(2 * cost);
  });

  it("two jobs that save at the same moment both land, one revision each", async () => {
    const { art, store, image } = await open();
    const before = store.getState().project.revision;
    image.hold();
    const a = await art.start({ stage: "concepts", characterId: "charger", brief: "a beetle" });
    const b = await art.start({ stage: "concepts", characterId: "crawler", brief: "a slug" });
    if (!a.ok || !b.ok) throw new Error("not started");
    await until(() => image.inFlight === 2);
    image.release(); // both finish their stage together and save at once
    const [ja, jb] = await Promise.all([art.finished(a.jobId), art.finished(b.jobId)]);
    expect(ja).toMatchObject({ outcome: "committed" });
    expect(jb).toMatchObject({ outcome: "committed" });
    expect([...ja!.revisions, ...jb!.revisions].sort((x, y) => x - y)).toEqual([before + 1, before + 2]);
    expect(store.getState().project.art.assets.map((x) => x.name).sort()).toEqual(["Charger", "Crawler"]);
    expect(store.getHistory().slice(-2).map((h) => h.author)).toEqual(["ai", "ai"]);
  });

  it("the game-art job runs independent steps side by side (characters, the world) and saves every step, also inside the Architect's lock", async () => {
    for (const underLock of [false, true]) {
      const { art, store } = await open();
      const started = await art.start({ stage: "gameArt" }, { underLock });
      if (!started.ok) throw new Error("not started");
      const job = await art.finished(started.jobId);
      expect(job).toMatchObject({ outcome: "committed", stage: "gameArt" });
      expect(job!.revisions.length).toBe(3 * 4 + 2); // four stages per character, kit, room
      expect(new Set(job!.revisions).size).toBe(job!.revisions.length);
      // The characters' steps started together, before any step saved (one at a time, a step saves before the next starts).
      const lines = job!.activity.map((e) => e.text);
      const firstSave = lines.findIndex((t) => t.startsWith("saved:"));
      expect(lines.slice(0, firstSave).filter((t) => t.startsWith("step character:"))).toHaveLength(3);
      const project = store.getState().project;
      expect(project.characters.every((c) => project.art.assets.some((x) => x.id === c.appearance && x.kind === "character" && x.rig))).toBe(true);
      expect(project.world.rooms[0]!.dressing?.tiles).toBeTruthy();
    }
  });

  it("with concurrency 1 the game-art job keeps the plan's order", async () => {
    const { art } = await open({ concurrency: 1 });
    const started = await art.start({ stage: "gameArt" });
    if (!started.ok) throw new Error("not started");
    const job = await art.finished(started.jobId);
    expect(job).toMatchObject({ outcome: "committed" });
    const lines = job!.activity.map((e) => e.text).filter((t) => t.startsWith("step ") || t.startsWith("saved:"));
    const steps = lines.filter((t) => t.startsWith("step ")).map((t) => t.split(":").slice(0, 2).join(":"));
    expect(steps).toEqual(["step character:player", "step character:crawler", "step character:charger", "step biome:world", "step room:arena"]);
    // Each step saves before the next starts.
    expect(lines.findIndex((t) => t.startsWith("step character:crawler"))).toBeGreaterThan(lines.findIndex((t) => t.startsWith("saved:")));
  });
});

describe("the store serializes background saves", () => {
  it("two saves made at the same moment both land, each on the revision before it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anomaly-saves-"));
    dirs.push(dir);
    const store = await ProjectStore.open(dir, createDefaultProject);
    const before = store.getState().project.revision;
    const page = (id: string) => ({ name: "createWikiPage", input: { page: { id, kind: "lore", title: id, status: "canon" } } });
    const [a, b] = await Promise.all([
      store.commitBackground(() => ({ operations: [page("one")] })),
      store.commitBackground(() => ({ operations: [page("two")] })),
    ]);
    expect(a).toMatchObject({ ok: true, revision: before + 1 });
    expect(b).toMatchObject({ ok: true, revision: before + 2 });
    const project: ProjectSpec = store.getState().project;
    expect(project.wiki.pages.filter((p) => p.id === "one" || p.id === "two")).toHaveLength(2);
    expect(store.getHistory()).toHaveLength(2);
  });
});
