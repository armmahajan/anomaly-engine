import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeImageModel, FakeRenderer, FakeVisionModel, type GeneratedImage, type ImageRequest } from "@anomaly/art";
import { fixtureAnimatedProject, ProjectSpec, type CharacterAsset } from "@anomaly/core";
import type { TurnRunner } from "@anomaly/agent";
import { createProjectServer } from "../src/index.ts";
import { conflicts, jobKeys } from "../src/art/scheduling.ts";

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

/** The animation fixture with some objects not drawn yet. */
function undrawn(...ids: string[]): ProjectSpec {
  const p = fixtureAnimatedProject();
  return ProjectSpec.parse({
    ...p,
    art: { ...p.art, assets: p.art.assets.map((a) => (ids.includes(a.id) ? { ...a, rig: null, clips: {}, clipPreviews: {}, preview: null } : a)) },
  });
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function open(project: ProjectSpec) {
  const dir = await mkdtemp(join(tmpdir(), "anomaly-arto-"));
  dirs.push(dir);
  await writeFile(join(dir, "project.json"), JSON.stringify(project));
  await writeFile(join(dir, "history.jsonl"), "");
  const image = new GatedImage();
  const created = await createProjectServer(dir, {
    token: "t",
    runner: noChat,
    art: { models: { image, vision: new FakeVisionModel() }, renderer: new FakeRenderer(), budget: 0.25 },
  });
  const art = created.art!;
  const states: ReturnType<typeof art.getState>[] = [];
  art.subscribe((s) => states.push(s));
  const asset = (id: string) => created.store.getState().project.art.assets.find((a) => a.id === id) as CharacterAsset;
  return { art, store: created.store, image, states, asset };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("object art jobs", () => {
  it("jobKeys: an object is its own thing, like a character", () => {
    const p = fixtureAnimatedProject();
    const k = (r: Parameters<typeof jobKeys>[0]) => jobKeys(r, p);
    expect(k({ stage: "concepts", objectId: "lever" }).sort()).toEqual(["asset:lever", "object:lever"]);
    expect(k({ stage: "animate", objectId: "lever", clips: ["pull"] }).sort()).toEqual(["asset:lever", "object:lever"]);
    expect(conflicts(k({ stage: "rig", objectId: "lever" }), k({ stage: "animate", objectId: "lever" }))).toBe(true);
    expect(conflicts(k({ stage: "auto", objectId: "lever" }), k({ stage: "auto", objectId: "trap" }))).toBe(false);
    expect(conflicts(k({ stage: "auto", objectId: "lever" }), k({ stage: "auto", characterId: "charger" }))).toBe(false);
  });

  it("refuses an objectId that isn't an object asset, or no asset at all", async () => {
    const { art } = await open(fixtureAnimatedProject());
    expect(await art.start({ stage: "concepts", objectId: "charger_look" })).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringMatching(/not an object asset/) } });
    expect(await art.start({ stage: "auto", objectId: "nothing" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await art.start({ stage: "concepts", objectId: "lever", characterId: "charger" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("two objects draw side by side; a second job on the same object waits; jobs and summaries carry the objectId", async () => {
    const { art, image, states, asset } = await open(undrawn("lever", "trap"));
    image.hold();
    const a = await art.start({ stage: "auto", objectId: "lever" });
    const b = await art.start({ stage: "auto", objectId: "trap" });
    expect(a).toMatchObject({ ok: true, jobId: expect.stringMatching(/^art_/) });
    expect(b).toMatchObject({ ok: true, jobId: expect.stringMatching(/^art_/) });
    expect(art.getState().runningJobs.map((j) => j.objectId)).toEqual(["lever", "trap"]);
    await until(() => image.inFlight === 2);
    expect(await art.start({ stage: "concepts", objectId: "lever", feedback: "taller" })).toMatchObject({ ok: true, queued: true });
    expect(art.getState().pending).toEqual([{ stage: "concepts", objectId: "lever" }]);
    image.release();
    await art.drained();

    for (const s of states) expect(s.runningJobs.filter((j) => j.objectId === "lever").length).toBeLessThanOrEqual(1);
    const jobs = art.getState().jobs;
    expect(jobs.map((j) => [j.stage, j.objectId, j.outcome])).toEqual([
      ["auto", "lever", "committed"],
      ["auto", "trap", "committed"],
      ["concepts", "lever", "committed"],
    ]);
    expect(Object.keys(asset("lever").clips).sort()).toEqual(["idle", "pull"]);
    expect(Object.keys(asset("trap").clips).sort()).toEqual(["idle", "snap"]);
    expect(asset("trap").clips.snap!.markers.map((m) => m.name)).toContain("strike");
    expect(asset("lever").concepts).toHaveLength(2);
  });

  it("the game-art job draws the objects in use that need art and picks one up where it stands", async () => {
    const { art, store, asset } = await open(undrawn("trap", "bolt"));
    // The trap already has a concept sheet: it is chosen from, not drawn again.
    await art.start({ stage: "concepts", objectId: "trap" });
    await art.drained();
    expect(asset("trap").concepts).toHaveLength(1);
    expect(await art.start({ stage: "gameArt", steps: ["object:trap", "object:bolt"] })).toMatchObject({ ok: true });
    await art.drained();
    const job = art.getState().jobs.at(-1)!;
    expect(job.outcome).toBe("committed");
    expect(job.summary).toContain("animated Trap");
    expect(asset("trap").concepts).toHaveLength(1);
    expect(asset("trap").rig).toBeTruthy();
    expect(Object.keys(asset("bolt").clips).sort()).toEqual(["burst", "charge", "fly", "idle"]);
    expect(asset("bolt").clips.burst!.loop).toBe(false);

    // A clip the game starts to play later: the plan animates only that clip.
    const snap = asset("trap").clips.snap;
    const added = await store.applyBatch({
      operations: [{ name: "addHandler", input: { roomId: "arena", propId: "trap", handler: { on: { type: "hit" }, do: [{ type: "playAnimation", target: { kind: "self" }, clip: "rattle" }] } } }],
      baseRevision: store.getState().project.revision,
      author: "user",
    });
    expect(added.ok).toBe(true);
    expect(await art.start({ stage: "gameArt" })).toMatchObject({ ok: true });
    await art.drained();
    expect(art.getState().jobs.at(-1)).toMatchObject({ outcome: "committed", summary: expect.stringContaining("animated Trap (rattle)") });
    expect(asset("trap").clips.rattle?.loop).toBe(false);
    expect(asset("trap").clips.snap).toEqual(snap);
  });
});
