import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARENA_FLOOR, exampleClips, exampleRig, ProjectSpec, toRuntimeProject } from "@anomaly/core";
import { arena, FPS } from "./simulate.ts";

// Enemy deaths (enemy.gd): the killing hit makes it harmless and fires enemyKilled at once; the
// body then plays its death clip (or a pop, flash, shrink and particle burst without one),
// lingers, fades and is gone. The probe swings the player's sword at a guard with 1 health.

const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));
const s = (seconds: number) => Math.round(seconds * FPS);

type Frame = {
  frame: number;
  dead: boolean;
  gone: boolean;
  visible: boolean;
  processing: boolean;
  alpha: number;
  clip: string;
  scaleY: number;
  layer: number;
  health: number;
  playerHealth: number;
  killed: boolean;
  bursts: number;
  corpses: number;
};

/** A guard that hurts on touch (1 health), 60 px right of the player: in sword reach, not touching. */
function guardArena(extra: Record<string, unknown> = {}): ProjectSpec {
  const base = arena([{ id: "guard", at: [220, ARENA_FLOOR], stats: { knockback: 300, contactDamage: 1, health: 1 }, initial: "idle", states: { idle: { action: { type: "wait" } } } }]);
  return ProjectSpec.parse({
    ...base,
    characters: base.characters.map((c) => (c.id === "guard" ? { ...c, ...extra } : c)),
    world: { ...base.world, handlers: [{ on: { type: "enemyKilled", character: "guard" }, do: [{ type: "setFlag", flag: "down" }] }] },
  });
}

/** The guard drawn with the example rig: with the example clips, or without its death clip. */
function withArt(project: ProjectSpec, death: boolean): ProjectSpec {
  const { death: deathClip, ...clips } = exampleClips();
  const asset = {
    id: "look",
    name: "Look",
    kind: "character",
    brief: "",
    concepts: [],
    chosen: null,
    rig: exampleRig(),
    preview: null,
    clips: death ? { ...clips, death: deathClip } : clips,
    clipPreviews: {},
    stateClips: {},
  };
  return ProjectSpec.parse({
    ...project,
    characters: project.characters.map((c) => (c.id === "guard" ? { ...c, appearance: "look" } : c)),
    art: { ...project.art, assets: [asset] },
  });
}

function probe(project: ProjectSpec, frames: number, input: { attackAt?: number; touchAt?: number; respawnAt?: number }): { hasRig: boolean; frames: Frame[] } {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-death-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ project: toRuntimeProject(project), spawn: "guard_1", frames, ...input }));
    execFileSync(process.env.GODOT ?? "godot", ["--headless", "--fixed-fps", String(FPS), "--path", GAME_DIR, "--script", "res://test/death_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")], {
      stdio: "pipe",
      timeout: 60_000,
    });
    const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
    if (out.error) throw new Error(out.error);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ATTACK = 5;
/** The sword's hit-stop (main.gd HIT_STOP_FRAMES) freezes the room, the dying body too, right after the hit. */
const HIT_STOP = 3;
const deathFrame = (frames: Frame[]) => frames.findIndex((f) => f.dead);
const goneFrame = (frames: Frame[]) => frames.findIndex((f) => f.gone);

describe("enemy deaths (headless runtime)", () => {
  it("the killing hit fires enemyKilled that frame and the enemy stops hurting at once", () => {
    const killed = probe(guardArena(), 60, { attackAt: ATTACK, touchAt: 30 });
    const dead = deathFrame(killed.frames);
    expect(dead).toBeGreaterThan(ATTACK);
    expect(dead).toBeLessThan(ATTACK + 12);
    // enemyKilled's handler ran in the frame of the killing hit (event timing is unchanged).
    expect(killed.frames.findIndex((f) => f.killed)).toBe(dead);
    expect(killed.frames[dead]!.layer).toBe(0);
    // Still on screen, but standing in it no longer hurts...
    expect(killed.frames[30]!.visible).toBe(true);
    expect(killed.frames.every((f) => f.playerHealth === 5)).toBe(true);
    // ...where the same touch on the living guard does.
    const alive = probe(guardArena(), 60, { touchAt: 30 });
    expect(alive.frames.at(-1)!.playerHealth).toBeLessThan(5);
  }, 90_000);

  it("without art: a pop, a flattening collapse and a particle burst, then it lingers, fades and is gone", () => {
    const out = probe(guardArena(), s(2), { attackAt: ATTACK });
    expect(out.hasRig).toBe(false);
    const dead = deathFrame(out.frames);
    expect(out.frames[dead]!.bursts).toBe(1);
    expect(out.frames[dead + 3]!.scaleY).toBeGreaterThan(1); // the pop
    expect(out.frames[dead + s(0.4)]!.scaleY).toBeLessThan(0.5); // collapsed onto its feet
    // Default timings: the 0.35 s fallback, 0.6 s linger, 0.4 s fade.
    const gone = goneFrame(out.frames);
    expect(gone - dead - HIT_STOP).toBeGreaterThanOrEqual(s(1.35) - 2);
    expect(gone - dead - HIT_STOP).toBeLessThanOrEqual(s(1.35) + 2);
    const fading = out.frames.slice(dead + HIT_STOP + s(0.95) + 2, gone).map((f) => f.alpha);
    expect(fading.length).toBeGreaterThan(10);
    expect(fading.every((a, i) => a < 1 && (i === 0 || a <= fading[i - 1]!))).toBe(true);
    expect(out.frames[gone]).toMatchObject({ visible: false, processing: false, corpses: 0 });
  }, 90_000);

  it("with a rig: plays its death clip (held on its last frame) until it fades; without the clip, the fallback on the rig", () => {
    const drawn = probe(withArt(guardArena(), true), s(2.2), { attackAt: ATTACK });
    expect(drawn.hasRig).toBe(true);
    const dead = deathFrame(drawn.frames);
    expect(drawn.frames[dead - 1]!.clip).toBe("idle");
    const gone = goneFrame(drawn.frames);
    expect(drawn.frames.slice(dead, gone).every((f) => f.clip === "death")).toBe(true);
    // The example death clip lasts 0.7 s; then 0.6 s linger and 0.4 s fade.
    expect(gone - dead - HIT_STOP).toBeGreaterThanOrEqual(s(1.7) - 2);
    expect(gone - dead - HIT_STOP).toBeLessThanOrEqual(s(1.7) + 2);
    expect(drawn.frames[dead]!.bursts).toBe(0); // its own animation, no fallback burst

    const noClip = probe(withArt(guardArena(), false), s(2), { attackAt: ATTACK });
    const d = deathFrame(noClip.frames);
    expect(noClip.frames[d]!.bursts).toBe(1);
    expect(noClip.frames[d + s(0.4)]!.scaleY).toBeLessThan(0.5);
    expect(goneFrame(noClip.frames) - d - HIT_STOP).toBeLessThanOrEqual(s(1.35) + 2);
  }, 90_000);

  it("its death timings are data: a short linger and fade end it sooner", () => {
    const out = probe(guardArena({ death: { linger: 0.1, fade: 0.1 } }), s(1.5), { attackAt: ATTACK });
    const gone = goneFrame(out.frames) - deathFrame(out.frames) - HIT_STOP;
    expect(gone).toBeGreaterThanOrEqual(s(0.55) - 2);
    expect(gone).toBeLessThanOrEqual(s(0.55) + 2);
  }, 90_000);

  it("a rebuilt room has no corpse: the enemy is back, alive", () => {
    const out = probe(guardArena(), 40, { attackAt: ATTACK, respawnAt: 25 });
    expect(out.frames[24]).toMatchObject({ dead: true, corpses: 1 });
    expect(out.frames[26]).toMatchObject({ dead: false, gone: false, visible: true, alpha: 1, corpses: 0, health: 1 });
  }, 90_000);
});
