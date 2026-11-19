import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeImageModel, FakeRenderer, FakeVisionModel, LAYER_PAINT_MARK } from "@anomaly/art";
import { Rig } from "@anomaly/core";
import type { TurnRunner } from "@anomaly/agent";
import { artOptionsFromEnv, createProjectServer } from "../src/index.ts";

// Layered rigs through the art service (rigMode "layered"), on the fake backend: no spending.

const noChat: TurnRunner = async () => {
  throw new Error("chat is not used here");
};

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("layered rigs in the art service", () => {
  it("an auto job with rigMode layered builds textured meshes, paints in what's hidden once, and animates them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anomaly-layered-"));
    dirs.push(dir);
    const image = new FakeImageModel();
    const created = await createProjectServer(dir, {
      token: "t",
      runner: noChat,
      art: { models: { image, vision: new FakeVisionModel() }, renderer: new FakeRenderer({ pixels: true }), budget: 0.25 },
    });
    const art = created.art!;
    const started = await art.start({ stage: "auto", characterId: "charger", brief: "a stout beast", rigMode: "layered" });
    expect(started).toMatchObject({ ok: true });
    await art.idle();
    const state = art.getState();
    const job = state.jobs.at(-1)!;
    expect(job.outcome, JSON.stringify(job.activity.slice(-5))).toBe("committed");
    const project = created.store.getState().project;
    const appearance = project.characters.find((c) => c.id === "charger")!.appearance;
    const asset = project.art.assets.find((a) => a.id === appearance)!;
    if (asset.kind !== "character") throw new Error("no asset");
    const rig = asset.rig!;
    expect(Rig.safeParse(rig).success).toBe(true);
    expect(rig.mode).toBe("layered");
    expect(rig.parts.every((p) => p.shape.type === "mesh" && p.texture)).toBe(true);
    expect(rig.parts.some((p) => p.bendTo && p.shape.type === "mesh" && p.shape.weights?.some((w) => w > 0 && w < 1))).toBe(true);
    expect(Object.keys(asset.clips).length).toBeGreaterThan(0);
    expect(image.requests.filter((r) => r.prompt.includes(LAYER_PAINT_MARK))).toHaveLength(1);
    expect(job.activity.some((l) => l.text.startsWith("painting in what the parts hide"))).toBe(true);
  }, 120_000);

  it("STUDIO_ART_RIG_MODE=layered makes it the default", async () => {
    const options = artOptionsFromEnv({ OPENROUTER_API_KEY: "test", STUDIO_ART_RIG_MODE: "layered" }, "/nonexistent");
    expect(options.defaultRigMode).toBe("layered");
    await options.renderer.close();
  });
});
