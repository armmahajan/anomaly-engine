import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARENA_FLOOR, exampleClips, exampleRig, ProjectSpec, toRuntimeProject } from "@anomaly/core";
import { FPS } from "./simulate.ts";
import { mite, showcaseArena, toad, warden } from "./fixtures/combatShowcase.ts";

// Heavy enemies drawn with a rig play a clip per attack phase (character_art.gd): the attack
// primitives report windup / active / recovery (entity state `phase`) and the rig follows.

const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));

/** The showcase enemy drawn with the example rig, with a clip for every slot its attacks use. */
function withArt(project: ProjectSpec, characterId: string): ProjectSpec {
  const clips = exampleClips();
  const asset = {
    id: "look",
    name: "Look",
    kind: "character",
    brief: "",
    concepts: [],
    chosen: null,
    rig: exampleRig(),
    preview: null,
    clips: { idle: clips.idle, run: clips.walk, windup: clips.windup, strike: clips.attack, slam: clips.attack, leap: clips.attack, recover: clips.idle },
    clipPreviews: {},
    stateClips: {},
  };
  return ProjectSpec.parse({
    ...project,
    characters: project.characters.map((c) => (c.id === characterId ? { ...c, appearance: "look" } : c)),
    art: { ...project.art, assets: [asset] },
  });
}

type Frame = { state: string; phase: string | null; clip: string };

function probe(project: ProjectSpec, spawn: string, frames: number, hit?: { at: number; damage: number }): { hasRig: boolean; frames: Frame[] } {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-art-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ project: toRuntimeProject(project), spawn, frames, ...(hit ? { hitAt: hit.at, hit: hit.damage } : {}) }));
    execFileSync(process.env.GODOT ?? "godot", ["--headless", "--fixed-fps", String(FPS), "--path", GAME_DIR, "--script", "res://test/art_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")], {
      stdio: "pipe",
      timeout: 60_000,
    });
    return JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What happened in a state, run-length encoded: "phase:clip" in order. */
function story(frames: Frame[], state: string): string[] {
  const out: string[] = [];
  for (const f of frames) {
    if (f.state !== state) continue;
    const step = `${f.phase ?? "-"}:${f.clip}`;
    if (out[out.length - 1] !== step) out.push(step);
  }
  return out;
}

describe("attack clips by phase (headless runtime)", () => {
  it("the warden's cleave plays windup, strike, recover as its phase runs windup, active, recovery", () => {
    const project = withArt(showcaseArena([{ character: warden, at: [420, ARENA_FLOOR] }], [], [120, ARENA_FLOOR]), "iron_warden");
    const out = probe(project, "iron_warden_1", 300);
    expect(out.hasRig).toBe(true);
    expect(story(out.frames, "cleave").slice(0, 4)).toEqual(["windup:windup", "active:strike", "recovery:recover", "windup:windup"]); // and again
    expect(story(out.frames, "stalk")[0]).toBe("-:run"); // not an attack: no phase
    // The phases last as long as the strike's params say (0.55 s windup, 0.2 s active).
    const first = out.frames.findIndex((f) => f.state === "cleave");
    const cleave = out.frames.slice(first, first + out.frames.slice(first).findIndex((f) => f.state !== "cleave"));
    expect(cleave.filter((f) => f.phase === "windup").length).toBeCloseTo(0.55 * FPS, -1);
    expect(cleave.filter((f) => f.phase === "active").length).toBeCloseTo(0.2 * FPS, -1);
  }, 90_000);

  it("the warden's quake (a slam) and the toad's hop and stomp (a leap, then a slam) wind up, then hit", () => {
    const project = withArt(showcaseArena([{ character: warden, at: [700, ARENA_FLOOR] }], [], [120, ARENA_FLOOR]), "iron_warden");
    // Below half health it roars, then quakes.
    const quake = probe(project, "iron_warden_1", 150, { at: 5, damage: 6 });
    expect(story(quake.frames, "quake")[0]).toBe("windup:windup");

    const toads = withArt(showcaseArena([{ character: toad, at: [500, ARENA_FLOOR] }], [mite], [200, ARENA_FLOOR]), "quake_toad");
    const out = probe(toads, "quake_toad_1", 240);
    expect(story(out.frames, "hop").slice(0, 2)).toEqual(["windup:windup", "active:leap"]);
    expect(story(out.frames, "stomp").slice(0, 2)).toEqual(["windup:windup", "active:slam"]);
  }, 90_000);
});
