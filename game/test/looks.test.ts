import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applyOperation, fixtureAnimatedProject, ProjectSpec, toRuntimeProject } from "@anomaly/core";

// Looks in the real runtime (game/tests/look_probe.gd, art/look_view.gd, art/particles.gd, fx.gd): setLook
// (tint, brightness, opacity, scale, aura, afterimages, emitter) on a rigged enemy, a box enemy, the
// player, an object prop and a colour prop, and its time limit; clearLook; dissolve out and in; emit;
// cameraZoom; stateEntered (in order, an interrupt included, spawn vs world/room filtering); a behavior
// state's look; the character stage's look. Pixels are checked in the web export (e2e/looks-play.spec.ts).

const GAME_DIR = join(import.meta.dirname, "..");

interface LookView {
  keys: string[] | null;
  layers: string[];
  modulate: [number, number, number, number];
  scale: number;
  grouped: boolean;
  aura: number;
  opacity: number;
  auraColor: string | null;
  ghosts: number;
  emitters: number;
  dissolve: number;
  dissolved: boolean;
  material: boolean;
  rigScale: number;
}
interface Frame {
  frame: number;
  entities: { spawnId: string; state: string | null; look: string[] | null; dissolved: boolean; health: number }[];
  props: { id: string; look: string[] | null; dissolved: boolean }[];
  playerLook: string[] | null;
  playerDissolved: boolean;
  emitters: number;
  zoom: number;
  flags: string[];
  items: Record<string, number>;
  looks: Record<string, LookView>;
}
interface Result {
  error: string;
  frames: Frame[];
  stage?: Partial<LookView>[];
}
type Action =
  | { frame: number; do: "fire"; event: object }
  | { frame: number; do: "effects"; effects: object[]; context?: { prop?: string; spawn?: string } }
  | { frame: number; do: "hurt"; spawn: string; damage: number };
interface Scenario {
  project: unknown;
  frames?: number;
  actions?: Action[];
  stage?: object;
}

function probe(scenarios: Scenario[]): Result[] {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-looks-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ scenarios }));
    execFileSync(process.env.GODOT ?? "godot", ["--headless", "--fixed-fps", "60", "--path", GAME_DIR, "--script", "res://tests/look_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")], { stdio: "pipe", timeout: 120_000 });
    return (JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { results: Result[] }).results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function op(p: ProjectSpec, name: string, input: unknown): ProjectSpec {
  const r = applyOperation(p, name, input);
  if (!r.ok) throw new Error(`${name}: ${r.error.message} ${JSON.stringify(r.error.issues)}`);
  return r.project;
}

const at = (frames: Frame[], n: number) => frames.find((f) => f.frame === n)!;
const look = (f: Frame, id: string) => f.looks[id]!;
const entity = (f: Frame, id: string) => f.entities.find((e) => e.spawnId === id)!;

/** The charger waits calm, glows for 0.5 s (its state's look), calms again; below half health it enters `rage` (an interrupt). */
function statesProject(): ProjectSpec {
  let p = fixtureAnimatedProject();
  p = op(p, "setBehavior", {
    characterId: "charger",
    behavior: {
      initial: "calm",
      states: {
        calm: { action: { type: "wait" }, transitions: [{ when: { type: "after", seconds: 0.5 }, to: "glow" }] },
        glow: { action: { type: "wait" }, transitions: [{ when: { type: "after", seconds: 0.5 }, to: "calm" }], look: { brightness: 2.5, aura: { color: "#ff3300", size: 10 } } },
        rage: { action: { type: "wait" }, transitions: [], look: { tint: { color: "#ff0000", amount: 0.8 } } },
      },
      interrupts: [{ when: { type: "healthBelow", fraction: 0.5 }, to: "rage" }],
    },
  });
  for (const id of ["entered_charger", "glow_own", "fire_any", "entered_crawler", "glow_world"]) p = op(p, "createItem", { id, name: id });
  const give = (item: string) => [{ type: "giveItem", item }];
  p = op(p, "addHandler", { roomId: "arena", spawnId: "charger_1", handler: { on: { type: "stateEntered" }, do: give("entered_charger") } });
  p = op(p, "addHandler", { roomId: "arena", spawnId: "charger_1", handler: { on: { type: "stateEntered", state: "glow" }, do: give("glow_own") } });
  p = op(p, "addHandler", { roomId: "arena", spawnId: "charger_1", handler: { on: { type: "stateEntered", state: "rage" }, do: [{ type: "setFlag", flag: "raged" }, { type: "shake", strength: 6, seconds: 0.2 }] } });
  // A spawn's handlers hear only its own enemy: the crawler's handlers would not hear the charger's glow.
  p = op(p, "addHandler", { roomId: "arena", spawnId: "crawler_1", handler: { on: { type: "stateEntered", state: "glow" }, do: [{ type: "setFlag", flag: "crawler_heard_glow" }] } });
  p = op(p, "addHandler", { roomId: "arena", handler: { on: { type: "stateEntered", state: "fire" }, do: give("fire_any") } });
  p = op(p, "addHandler", { handler: { on: { type: "stateEntered", from: { kind: "spawn", spawn: "crawler_1" } }, do: give("entered_crawler") } });
  p = op(p, "addHandler", { handler: { on: { type: "stateEntered", state: "glow" }, do: give("glow_world") } });
  return p;
}

const FULL_LOOK = {
  tint: { color: "#00ff00", amount: 1 },
  brightness: 1.5,
  opacity: 0.6,
  scale: 1.5,
  aura: { color: "#ff00ff", size: 8, pulse: 0 },
  afterimages: { count: 3, interval: 0.05, fade: 0.3 },
  emitter: { shape: "spark", rate: 30, color: "#ffcc00" },
};
const SET = 10;
const ZOOM = 30;
const CLEAR = 100;
const DISSOLVE_OUT = 130;
const DISSOLVE_IN = 200;

const LOOKS_SCRIPT: Action[] = [
  {
    frame: SET,
    do: "effects",
    effects: [
      { type: "setLook", target: { kind: "spawn", spawn: "charger_1" }, look: FULL_LOOK, seconds: 1, fade: 0.1 },
      { type: "setLook", target: { kind: "spawn", spawn: "crawler_1" }, look: { opacity: 0.5, scale: 2, afterimages: { count: 2 } }, seconds: null, fade: 0 },
      { type: "setLook", target: { kind: "player" }, look: { brightness: 2 }, seconds: null, fade: 0 },
      { type: "setLook", target: { kind: "prop", prop: "trap" }, look: { aura: { color: "#00ffff", size: 6 } }, seconds: null, fade: 0 },
      { type: "setLook", target: { kind: "self" }, look: { tint: { color: "#0000ff", amount: 0.5 } }, seconds: null, fade: 0 },
    ],
    context: { prop: "door" },
  },
  {
    frame: ZOOM,
    do: "effects",
    effects: [
      { type: "cameraZoom", amount: 1.5, seconds: 0.5 },
      { type: "emit", at: { kind: "point", x: 300, y: 300 }, emitter: { burst: 20, rate: 0, lifetime: 0.3 }, seconds: 0 },
      { type: "emit", at: { kind: "self" }, emitter: { rate: 40, lifetime: 0.2 }, seconds: 0.5 },
    ],
    context: { prop: "lever" },
  },
  { frame: CLEAR, do: "effects", effects: [{ type: "clearLook", target: { kind: "spawn", spawn: "crawler_1" }, fade: 0.2 }] },
  {
    frame: DISSOLVE_OUT,
    do: "effects",
    effects: [
      { type: "dissolve", target: { kind: "spawn", spawn: "charger_1" }, to: "out", seconds: 0.4, color: "#ffffff" },
      { type: "dissolve", target: { kind: "prop", prop: "door" }, to: "out", seconds: 0.2, color: "#ff8800" },
    ],
  },
  { frame: DISSOLVE_IN, do: "effects", effects: [{ type: "dissolve", target: { kind: "spawn", spawn: "charger_1" }, to: "in", seconds: 0.3 }] },
];

describe("looks (headless runtime)", () => {
  let looks: Result;
  let states: Result;
  let stage: Result;

  beforeAll(() => {
    const results = probe([
      { project: toRuntimeProject(fixtureAnimatedProject()), frames: 260, actions: LOOKS_SCRIPT },
      { project: toRuntimeProject(statesProject()), frames: 200, actions: [{ frame: 150, do: "hurt", spawn: "charger_1", damage: 3 }] },
      {
        project: toRuntimeProject(fixtureAnimatedProject()),
        stage: { mode: "character", characterId: "charger", clip: null, time: null, speed: 1, flip: false, bones: false, onion: { image: null, alpha: 0 }, look: { aura: { color: "#ff0000" }, tint: { color: "#ffaa00", amount: 0.5 } } },
      },
    ]);
    [looks, states, stage] = results as [Result, Result, Result];
  }, 180_000);

  it("runs without errors", () => {
    for (const r of [looks, states, stage]) expect(r.error).toBe("");
  });

  it("setLook shows every field on a rigged enemy: tint and brightness, opacity and the aura in its group, scale, afterimages, an emitter", () => {
    const f = at(looks.frames, SET + 12);
    const charger = look(f, "charger_1");
    expect(charger.keys).toEqual(["afterimages", "aura", "brightness", "emitter", "opacity", "scale", "tint"]);
    expect(entity(f, "charger_1").look).toEqual(charger.keys);
    expect(charger.modulate[0]).toBeCloseTo(0, 2);
    expect(charger.modulate[1]).toBeCloseTo(1.5, 2);
    expect(charger.modulate[2]).toBeCloseTo(0, 2);
    expect(charger.grouped).toBe(true);
    expect(charger.opacity).toBeCloseTo(0.6, 2);
    expect(charger.aura).toBeCloseTo(1, 2);
    expect(charger.auraColor).toBe("ff00ff");
    expect(charger.rigScale).toBeCloseTo(1.5, 2);
    expect(charger.emitters).toBe(1);
    // The charger patrols: afterimages are left behind, at most `count`.
    const ghosts = looks.frames.filter((x) => x.frame > SET && x.frame < SET + 60).map((x) => look(x, "charger_1").ghosts);
    expect(Math.max(...ghosts)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...ghosts)).toBeLessThanOrEqual(3);
    // It fades in over `fade` (0.1 s).
    expect(look(at(looks.frames, SET), "charger_1").layers[0]).toMatch(/^set:0\.[0-2]/);
  });

  it("its `seconds` end it: it fades out and the drawing is back as it was", () => {
    const gone = at(looks.frames, SET + 60 + 8);
    const charger = look(gone, "charger_1");
    expect(charger.keys).toBeNull();
    expect(entity(gone, "charger_1").look).toBeNull();
    expect(charger.grouped).toBe(false);
    expect(charger.modulate).toEqual([1, 1, 1, 1]);
    expect(charger.rigScale).toBeCloseTo(1, 3);
    expect(charger.emitters).toBe(0);
    expect(look(at(looks.frames, SET + 60 + 30), "charger_1").ghosts).toBe(0);
    // Still on at the end of its time.
    expect(look(at(looks.frames, SET + 55), "charger_1").keys).not.toBeNull();
  });

  it("works on a box enemy, the player and props (object art and a colour); clearLook takes it off", () => {
    const f = at(looks.frames, SET + 12);
    const crawler = look(f, "crawler_1");
    expect(crawler.keys).toEqual(["afterimages", "opacity", "scale"]);
    expect(crawler.grouped).toBe(true);
    expect(crawler.opacity).toBeCloseTo(0.5, 2);
    expect(crawler.rigScale).toBeCloseTo(2, 3);
    expect(f.playerLook).toEqual(["brightness"]);
    expect(look(f, "player").modulate.slice(0, 3)).toEqual([2, 2, 2]);
    expect(f.props.find((p) => p.id === "trap")!.look).toEqual(["aura"]);
    expect(look(f, "prop:trap").grouped).toBe(true);
    expect(f.props.find((p) => p.id === "door")!.look).toEqual(["tint"]);
    expect(look(f, "prop:door").modulate.slice(0, 3)).toEqual([0.5, 0.5, 1]);
    const cleared = at(looks.frames, CLEAR + 14);
    expect(look(cleared, "crawler_1").keys).toBeNull();
    expect(look(cleared, "crawler_1").rigScale).toBeCloseTo(1, 3);
    expect(look(at(looks.frames, CLEAR + 5), "crawler_1").rigScale).toBeGreaterThan(1.05); // fading out
    // Without a time limit or clearLook it stays.
    expect(at(looks.frames, 259).playerLook).toEqual(["brightness"]);
  });

  it("dissolve out hides the drawing (still in play) and in restores it", () => {
    const during = look(at(looks.frames, DISSOLVE_OUT + 10), "charger_1");
    expect(during.material).toBe(true);
    expect(during.dissolve).toBeGreaterThan(0.2);
    expect(during.dissolved).toBe(false);
    const out = at(looks.frames, DISSOLVE_OUT + 30);
    expect(look(out, "charger_1").dissolve).toBe(1);
    expect(entity(out, "charger_1").dissolved).toBe(true);
    expect(entity(out, "charger_1").health).toBeGreaterThan(0);
    expect(out.props.find((p) => p.id === "door")!.dissolved).toBe(true);
    expect(entity(at(looks.frames, DISSOLVE_IN + 1), "charger_1").dissolved).toBe(false);
    const back = look(at(looks.frames, DISSOLVE_IN + 25), "charger_1");
    expect(back.dissolve).toBe(0);
    expect(back.material).toBe(false);
  });

  it("cameraZoom punches the camera in, then eases back", () => {
    const base = at(looks.frames, ZOOM - 1).zoom;
    const during = looks.frames.filter((f) => f.frame > ZOOM && f.frame < ZOOM + 30).map((f) => f.zoom);
    expect(Math.max(...during)).toBeGreaterThan(base * 1.4);
    expect(Math.max(...during)).toBeLessThanOrEqual(base * 1.5 + 1e-6);
    expect(at(looks.frames, ZOOM + 40).zoom).toBeCloseTo(base, 5);
  });

  it("emit shows particles at a point (a burst) and at a target for its seconds, then they are gone", () => {
    const before = at(looks.frames, ZOOM - 1).emitters;
    expect(at(looks.frames, ZOOM + 2).emitters).toBe(before + 2);
    expect(at(looks.frames, ZOOM + 70).emitters).toBe(before);
  });

  it("stateEntered fires on every state change, in order, the first state and an interrupt included", () => {
    const frames = states.frames;
    const entries = (id: string) => {
      const out: { frame: number; state: string }[] = [];
      let last: string | null = null;
      for (const f of frames) {
        const s = entity(f, id).state;
        if (s !== null && s !== last) out.push({ frame: f.frame, state: s });
        last = s;
      }
      return out;
    };
    const charger = entries("charger_1");
    expect(charger.map((e) => e.state).slice(0, 4)).toEqual(["calm", "glow", "calm", "glow"]);
    expect(charger.at(-1)!.state).toBe("rage");
    // Each entry is heard the frame it happens (the run handles its events after the physics step); the
    // first state is entered on the enemy's first physics step (the state reports it from the start).
    charger.forEach((e, i) => expect(at(frames, e.frame + (i === 0 ? 1 : 0)).items.entered_charger ?? 0).toBe(i + 1));
    const glows = charger.filter((e) => e.state === "glow").length;
    expect(frames.at(-1)!.items.glow_own).toBe(glows);
    expect(frames.at(-1)!.items.glow_world).toBe(glows);
    expect(frames.at(-1)!.flags).toContain("raged");
    expect(frames.at(-1)!.flags).not.toContain("crawler_heard_glow");
    const crawler = entries("crawler_1");
    expect(frames.at(-1)!.items.entered_crawler).toBe(crawler.length);
    expect(frames.at(-1)!.items.fire_any).toBe(crawler.filter((e) => e.state === "fire").length);
    expect(crawler.length).toBeGreaterThan(2);
  });

  it("a behavior state's look shows while in the state and goes after (0.15 s), and the interrupt's state shows its own", () => {
    const frames = states.frames;
    const glowing = frames.filter((f) => entity(f, "charger_1").state === "glow");
    const mid = glowing[15]!;
    expect(look(mid, "charger_1").keys).toEqual(["aura", "brightness"]);
    expect(look(mid, "charger_1").grouped).toBe(true);
    expect(look(mid, "charger_1").modulate[0]).toBeCloseTo(2.5, 2);
    const calmAgain = frames.find((f) => f.frame > glowing.at(-1)!.frame + 12 && entity(f, "charger_1").state === "calm")!;
    expect(look(calmAgain, "charger_1").keys).toBeNull();
    expect(look(calmAgain, "charger_1").grouped).toBe(false);
    expect(look(calmAgain, "charger_1").modulate).toEqual([1, 1, 1, 1]);
    const raging = at(frames, 199);
    expect(entity(raging, "charger_1").state).toBe("rage");
    expect(look(raging, "charger_1").keys).toEqual(["tint"]);
    expect(look(raging, "charger_1").modulate[1]).toBeCloseTo(0.2, 2);
  });

  it("the character stage shows a look sent with the stage, and drops it when the stage has none", () => {
    const [early, later, cleared] = stage.stage!;
    expect(early!.keys).toEqual(["aura", "tint"]);
    expect(later!.grouped).toBe(true);
    expect(later!.aura).toBeGreaterThan(0.5);
    expect(cleared!.keys).toBeNull();
    expect(cleared!.grouped).toBe(false);
  });
});
