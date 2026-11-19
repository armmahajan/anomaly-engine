import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applyOperation, ARENA_FLOOR, Effect, exampleRig, fixtureAnimatedProject, LogicRun, logicGame, ProjectSpec, toRuntimeProject, type Clip, type LogicEvent } from "@anomaly/core";

// Animation in play (core art/animation.ts) in the real runtime (game/tests/animation_probe.gd), on the
// shared fixture (core world/fixtureAnimated.ts): object props loop their idle, playAnimation on self,
// the player, a prop and a spawn (back to idle, or held), markers fire on time and in order and their
// handlers run, spawnEffect shows an object and removes it, windup projectiles charge at their origin
// and burst where they break, and the object stage.

const GAME_DIR = join(import.meta.dirname, "..");
const FPS = 60;

interface PropState { id: string; visible: boolean; solid: boolean; playing: string | null }
interface Projectile { x: number; y: number; charging: boolean; object: string | null; owner: string }
interface Frame {
  frame: number;
  props: PropState[];
  playerPlaying: string | null;
  effects: { object: string; clip: string; x: number; y: number }[];
  markers: number;
  projectiles: Projectile[];
  flags: string[];
  entities: { spawnId: string; playing: string | null; state: string | null; phase: string | null }[];
  health: number;
  shake: number;
  views: Record<string, { clip: string; time: number; held: boolean; scale: number }>;
  rigs: Record<string, { clip: string; time: number }>;
  centers: Record<string, [number, number]>;
}
interface Result {
  error: string;
  frames: Frame[];
  markers: { name: string; from: string }[];
  stage?: { state: string; built: boolean; clip: string; time: number; bones: boolean };
}
type Action =
  | { frame: number; do: "fire"; event: object }
  | { frame: number; do: "effects"; effects: object[]; context?: { prop?: string; spawn?: string } }
  | { frame: number; do: "place"; x: number; y: number };
interface Scenario { project: unknown; world?: object; frames?: number; actions?: Action[]; stage?: object }

function probe(scenarios: Scenario[]): Result[] {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-animation-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ scenarios }));
    execFileSync(process.env.GODOT ?? "godot", ["--headless", "--fixed-fps", "60", "--path", GAME_DIR, "--script", "res://tests/animation_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")], { stdio: "pipe", timeout: 120_000 });
    return (JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { results: Result[] }).results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function op(p: ProjectSpec, name: string, input: unknown): ProjectSpec {
  const r = applyOperation(p, name, input);
  if (!r.ok) throw new Error(`${name}: ${r.error.message}`);
  return r.project;
}

const oneShot = (duration: number, markers: { t: number; name: string }[] = []): Clip => ({
  duration,
  loop: false,
  tracks: [],
  motions: [{ type: "squash", bone: "body", amount: 0.3, at: 0.5, width: 0.3 }],
  visibility: [],
  markers,
});

/** The fixture plus: the player drawn (a `wave` clip with two markers), the charger able to `taunt`, and world handlers that listen to markers by name and `from`. */
function fixture(): ProjectSpec {
  let p = fixtureAnimatedProject();
  p = op(p, "createAsset", { asset: { id: "hero_look", name: "Hero", kind: "character", brief: "a hero" }, assignTo: "player" });
  p = op(p, "setRig", { assetId: "hero_look", rig: exampleRig() });
  p = op(p, "setClip", { assetId: "hero_look", clipId: "idle", clip: { ...oneShot(1), loop: true, motions: [] } });
  p = op(p, "setClip", { assetId: "hero_look", clipId: "wave", clip: oneShot(0.5, [{ t: 0.8, name: "wave_end" }, { t: 0.2, name: "wave_start" }]) });
  p = op(p, "setClip", { assetId: "charger_look", clipId: "taunt", clip: oneShot(0.4, [{ t: 0.5, name: "roar" }]) });
  const world = (on: object, flag: string) => ({ on: { type: "marker", ...on }, do: [{ type: "setFlag", flag }] });
  p = ProjectSpec.parse({ ...p, world: { ...p.world, handlers: [...p.world.handlers, world({ name: "wave_end", from: { kind: "player" } }, "waved"), world({ name: "strike", from: { kind: "prop", prop: "trap" } }, "trap_struck"), world({ name: "strike", from: { kind: "player" } }, "wrong_from"), world({ name: "roar" }, "roared")] } });
  return p;
}

const without = (p: ProjectSpec, ...spawns: string[]) => spawns.reduce((q, spawnId) => op(q, "removeRoomSpawn", { roomId: "arena", spawnId }), p);
const run = (p: ProjectSpec) => toRuntimeProject(p);
const prop = (f: Frame, id: string) => f.props.find((x) => x.id === id)!;
const entity = (f: Frame, id: string) => f.entities.find((e) => e.spawnId === id)!;
/** Frames from `start` until the frame when `test` first holds (-1: never). */
const after = (frames: Frame[], start: number, test: (f: Frame) => boolean) => {
  const i = frames.findIndex((f) => f.frame >= start && test(f));
  return i < 0 ? -1 : frames[i]!.frame - start;
};
/** The frame a marker (by index in the run's list) was recorded on. */
const markerFrame = (frames: Frame[], index: number) => frames.find((f) => f.markers > index)!.frame;

const TOUCH = 90;
const PULL = 150;
const PLAYER = 220;
const SPAWN = 260; // after the wave (0.5 s) is over: the logic model takes clips as instant, so overlapping ones would interleave differently
const PROP = 300;
const EFFECT = 310;
/** The props scenario: events and effects (as handlers would run them) at given frames. */
const SCRIPT: Action[] = [
  { frame: TOUCH, do: "fire", event: { type: "touch", prop: "trap" } },
  { frame: PULL, do: "fire", event: { type: "interact", prop: "lever" } },
  { frame: PLAYER, do: "effects", effects: [{ type: "playAnimation", target: { kind: "player" }, clip: "wave", then: "idle" }] },
  { frame: SPAWN, do: "effects", effects: [{ type: "playAnimation", target: { kind: "spawn", spawn: "charger_1" }, clip: "taunt" }, { type: "playAnimation", target: { kind: "player" }, clip: "nothing_like_it" }] },
  { frame: PROP, do: "effects", effects: [{ type: "playAnimation", target: { kind: "prop", prop: "trap" }, clip: "snap", then: "hold" }] },
  { frame: EFFECT, do: "effects", effects: [{ type: "spawnEffect", object: "bolt", clip: "fly", at: { kind: "point", x: 200, y: 300 } }, { type: "spawnEffect", object: "shockwave", clip: "burst", at: { kind: "self" }, offset: [0, -10], scale: 2 }], context: { prop: "lever" } },
];

/** The same script through the logic model (core interpret.ts), which takes animation as instant. */
function mirror(p: ProjectSpec): LogicRun {
  const run = LogicRun.start(logicGame(p, { room: "arena", at: { x: 160, y: ARENA_FLOOR } }), []);
  for (const a of SCRIPT) {
    if (a.do === "fire") run.fire(a.event as LogicEvent);
    if (a.do === "effects") {
      const room = run.currentRoom()!;
      run.run(
        a.effects.map((e) => Effect.parse(e)),
        { prop: room.props.find((x) => x.id === a.context?.prop), spawn: room.spawns.find((x) => x.id === a.context?.spawn) },
      );
    }
    run.flush();
  }
  return run;
}

/** The frames of the first windup during which a projectile was charging (one run of frames). */
function firstCharge(frames: Frame[]): Frame[] {
  const start = frames.findIndex((f) => f.projectiles.some((p) => p.charging));
  if (start < 0) return [];
  const end = frames.findIndex((f, i) => i > start && !f.projectiles.some((p) => p.charging));
  return frames.slice(start, end < 0 ? undefined : end);
}

describe("animation in play (headless runtime)", () => {
  let props: Result;
  let charger: Result;
  let crawler: Result;
  let weapon: Result;
  let stage: Result;

  beforeAll(() => {
    const p = fixture();
    const results = probe([
      {
        // The props, playAnimation on every kind of target, markers and their handlers, spawnEffect. The crawler is gone; the charger stays behind the door.
        project: run(without(p, "crawler_1")),
        frames: 380,
        actions: SCRIPT,
      },
      {
        // The charger runs at a player beside it: its attack clip's `impact` marker spawns a shockwave and shakes the screen.
        project: run(without(p, "crawler_1")),
        world: { room: "arena", x: 860, y: ARENA_FLOOR, abilities: [] },
        frames: 150,
      },
      {
        // The crawler's bolt charges above its head through the windup, flies, and bursts on the door.
        project: run(without(p, "charger_1")),
        frames: 260,
      },
      {
        // A weapon projectile with the same look, wielded by the charger: charges at its origin, then flies.
        project: run(weaponProject(without(p, "crawler_1"))),
        world: { room: "arena", x: 1000, y: ARENA_FLOOR, abilities: [] },
        frames: 120,
      },
      { project: run(p), stage: { mode: "object", assetId: "lever", clip: "pull", time: 0.3, speed: 1, bones: true, onion: { image: null, alpha: 0 } } },
    ]);
    for (const r of results) expect(r.error).toBe("");
    [props, charger, crawler, weapon, stage] = results as [Result, Result, Result, Result, Result];
  }, 180_000);

  it("draws object props looping their idle clip, fitted to their rectangle", () => {
    const before = props.frames.filter((f) => f.frame < TOUCH);
    for (const f of before) {
      expect(f.views.trap!.clip).toBe("idle");
      expect(f.views.lever!.clip).toBe("idle");
      expect(prop(f, "trap").playing).toBeNull();
    }
    // The trap's 1 s idle has looped by the time it is touched (its clock is past one loop, still idle).
    expect(before.at(-1)!.views.trap!.time).toBeGreaterThan(1);
    expect(before[0]!.views.trap!.scale).toBeGreaterThan(0);
    expect(props.frames[0]!.views.door).toBeUndefined(); // a colour prop has no object
  });

  it("plays a clip on the prop whose handler it is (the trap's touch), then goes back to idle", () => {
    const f = props.frames.find((x) => x.frame === TOUCH)!;
    expect(prop(f, "trap").playing).toBe("snap");
    expect(f.views.trap!.clip).toBe("snap");
    const back = after(props.frames, TOUCH, (x) => prop(x, "trap").playing === null);
    expect(Math.abs(back - 0.5 * FPS)).toBeLessThanOrEqual(1);
    expect(props.frames.find((x) => x.frame === TOUCH + back)!.views.trap!.clip).toBe("idle");
  });

  it("fires the trap's `strike` marker on time; its handler hurts the player; world handlers filter by `from`", () => {
    const i = props.markers.findIndex((m) => m.name === "strike");
    expect(props.markers[i]).toEqual({ name: "strike", from: "prop:trap" });
    expect(Math.abs(markerFrame(props.frames, i) - TOUCH - 0.4 * 0.5 * FPS)).toBeLessThanOrEqual(1);
    const hurt = after(props.frames, TOUCH, (x) => x.health < props.frames[0]!.health);
    expect(Math.abs(hurt - 0.4 * 0.5 * FPS)).toBeLessThanOrEqual(2);
    const last = props.frames.at(-1)!;
    expect(last.flags).toContain("trap_struck");
    expect(last.flags).not.toContain("wrong_from");
  });

  it("holds the lever's pull, whose `click` sets lever_pulled and opens the door", () => {
    const i = props.markers.findIndex((m) => m.name === "click");
    expect(props.markers[i]).toEqual({ name: "click", from: "prop:lever" });
    expect(Math.abs(markerFrame(props.frames, i) - PULL - 0.7 * 0.6 * FPS)).toBeLessThanOrEqual(1);
    const late = props.frames.find((x) => x.frame === PULL + 60)!;
    expect(late.views.lever!.clip).toBe("pull");
    expect(late.views.lever!.held).toBe(true);
    expect(prop(late, "lever").playing).toBeNull();
    expect(late.flags).toContain("lever_pulled");
    expect(prop(late, "door")).toMatchObject({ visible: false, solid: false });
    expect(prop(props.frames.find((x) => x.frame === PULL)!, "door")).toMatchObject({ visible: true, solid: true });
  });

  it("plays a clip on the player and on a spawn, then back to their usual clips; a missing clip is ignored", () => {
    const f = props.frames.find((x) => x.frame === PLAYER)!;
    expect(f.playerPlaying).toBe("wave");
    expect(f.rigs.player!.clip).toBe("wave");
    const back = after(props.frames, PLAYER, (x) => x.playerPlaying === null);
    expect(Math.abs(back - 0.5 * FPS)).toBeLessThanOrEqual(1);
    expect(props.frames.find((x) => x.frame === PLAYER + back + 1)!.rigs.player!.clip).toBe("idle");
    // The player's markers, in time order though listed out of order; `from: player` hears them.
    const waves = props.markers.filter((m) => m.name.startsWith("wave"));
    expect(waves).toEqual([{ name: "wave_start", from: "player" }, { name: "wave_end", from: "player" }]);
    expect(props.frames.at(-1)!.flags).toContain("waved");
    // The spawn: taunt, its roar heard by the world, back to the behavior's clips.
    const s = props.frames.find((x) => x.frame === SPAWN)!;
    expect(entity(s, "charger_1").playing).toBe("taunt");
    expect(s.rigs.charger_1!.clip).toBe("taunt");
    expect(s.playerPlaying).toBeNull(); // the unknown clip played nothing
    expect(s.rigs.player!.clip).toBe("idle");
    expect(props.markers).toContainEqual({ name: "roar", from: "spawn:charger_1" });
    expect(props.frames.at(-1)!.flags).toContain("roared");
    const done = after(props.frames, SPAWN, (x) => entity(x, "charger_1").playing === null);
    expect(Math.abs(done - 0.4 * FPS)).toBeLessThanOrEqual(1);
    expect(props.frames.at(-1)!.rigs.charger_1!.clip).not.toBe("taunt");
  });

  it("plays a clip on another prop and holds it; its markers reach that prop's handlers", () => {
    const f = props.frames.find((x) => x.frame === PROP)!;
    expect(prop(f, "trap").playing).toBe("snap");
    const late = props.frames.find((x) => x.frame === PROP + 50)!;
    expect(late.views.trap!).toMatchObject({ clip: "snap", held: true });
    expect(props.markers.filter((m) => m.name === "strike")).toHaveLength(2);
  });

  it("shows spawnEffect objects at a point or a target and removes one-shot ones when they end", () => {
    const f = props.frames.find((x) => x.frame === EFFECT)!;
    expect(f.effects).toContainEqual({ object: "bolt", clip: "fly", x: 200, y: 300 });
    const wave = f.effects.find((e) => e.object === "shockwave")!;
    // The lever's centre (440 + 16, floor - 24), offset up 10.
    expect(wave).toMatchObject({ clip: "burst", x: 456, y: ARENA_FLOOR - 24 - 10 });
    const gone = after(props.frames, EFFECT, (x) => !x.effects.some((e) => e.object === "shockwave"));
    expect(Math.abs(gone - 0.5 * FPS)).toBeLessThanOrEqual(2);
    // The looping one stays.
    expect(props.frames.at(-1)!.effects).toContainEqual({ object: "bolt", clip: "fly", x: 200, y: 300 });
  });

  it("fires an enemy's behavior clip markers: the charger's impact spawns a shockwave and shakes the screen", () => {
    const start = charger.frames.find((f) => f.rigs.charger_1?.clip === "attack")!.frame;
    const i = charger.markers.findIndex((m) => m.name === "impact");
    expect(charger.markers[i]).toEqual({ name: "impact", from: "spawn:charger_1" });
    expect(Math.abs(markerFrame(charger.frames, i) - start - 0.5 * 0.6 * FPS)).toBeLessThanOrEqual(1);
    const shown = charger.frames.find((f) => f.effects.some((e) => e.object === "shockwave"))!;
    expect(shown.frame - markerFrame(charger.frames, i)).toBeLessThanOrEqual(1);
    expect(shown.shake).toBeGreaterThan(0);
    const at = shown.effects.find((e) => e.object === "shockwave")!;
    const c = shown.centers.charger_1!;
    expect(Math.abs(at.x - c[0])).toBeLessThan(12);
    expect(Math.abs(at.y - (c[1] + 20))).toBeLessThan(2);
    const gone = after(charger.frames, shown.frame, (f) => !f.effects.some((e) => e.object === "shockwave"));
    expect(gone).toBeGreaterThan(0.5 * FPS - 3);
    expect(gone).toBeLessThanOrEqual(0.5 * FPS + 2);
  });

  it("charges the crawler's bolt at its origin through the windup, then launches it and bursts where it breaks", () => {
    const charging = firstCharge(crawler.frames);
    // The windup is 0.8 s: it sits there all through it.
    expect(charging.length).toBeGreaterThanOrEqual(0.8 * FPS - 2);
    for (const f of charging) {
      const shot = f.projectiles.find((p) => p.charging)!;
      const c = f.centers.crawler_1!;
      expect(shot).toMatchObject({ object: "bolt", owner: "crawler_1" });
      expect(shot.x).toBeCloseTo(c[0], 3);
      expect(shot.y).toBeCloseTo(c[1] - 60, 3);
      expect(entity(f, "crawler_1").phase).toBe("windup");
    }
    const launched = charging.at(-1)!.frame + 1;
    const flying = crawler.frames.find((f) => f.frame === launched + 2)!.projectiles;
    expect(flying).toHaveLength(1);
    expect(flying[0]!.charging).toBe(false);
    expect(flying[0]!.x).toBeLessThan(charging.at(-1)!.projectiles[0]!.x); // toward the player, on the left
    // It breaks on the door (solid until the lever is pulled): its burst plays there.
    const burst = crawler.frames.find((f) => f.effects.some((e) => e.object === "bolt" && e.clip === "burst"));
    expect(burst).toBeDefined();
    const at = burst!.effects.find((e) => e.clip === "burst")!;
    expect(at.x).toBeGreaterThan(540);
    expect(at.x).toBeLessThan(580);
    const gone = after(crawler.frames, burst!.frame, (f) => !f.effects.some((e) => e.clip === "burst"));
    expect(Math.abs(gone - 0.3 * FPS)).toBeLessThanOrEqual(2);
  });

  it("charges a weapon projectile with a windup look at its origin on the wielder, then fires it", () => {
    const charging = firstCharge(weapon.frames);
    expect(charging.length).toBeGreaterThanOrEqual(WINDUP * FPS - 1);
    for (const f of charging) {
      const shot = f.projectiles.find((p) => p.charging)!;
      const c = f.centers.charger_1!;
      expect(shot).toMatchObject({ object: "bolt", owner: "charger_1" });
      // Facing right (toward the player at 1000): origin [20, -10] as is.
      expect(shot.x).toBeCloseTo(c[0] + 20, 3);
      expect(shot.y).toBeCloseTo(c[1] - 10, 3);
    }
    const next = weapon.frames.find((f) => f.frame === charging.at(-1)!.frame + 3)!;
    expect(next.projectiles.length).toBeGreaterThan(0);
    expect(next.projectiles.every((p) => !p.charging)).toBe(true);
  });

  it("agrees with the logic model (interpret.ts) on the order of marker events and what their handlers did", () => {
    const logic = mirror(without(fixture(), "crawler_1"));
    expect(props.markers.length).toBe(6);
    expect(logic.markers).toEqual(props.markers);
    const runtime = props.frames.at(-1)!.flags.filter((f) => !f.includes(":")).sort();
    expect([...logic.flags].filter((f) => !f.includes(":")).sort()).toEqual(runtime);
    expect(runtime).toEqual(["lever_pulled", "roared", "trap_struck", "waved"]);
  });

  it("shows one object on the object stage", () => {
    expect(stage.stage).toMatchObject({ state: "object", built: true, clip: "pull", bones: true });
    expect(stage.stage!.time).toBeCloseTo(0.3, 5);
  });
});

const WINDUP = 0.5;

/** The charger wields a projectile weapon whose bolt charges at [20, -10] through a 0.5 s windup. */
function weaponProject(p: ProjectSpec): ProjectSpec {
  p = op(p, "createWeapon", { id: "caster", name: "Caster" });
  p = op(p, "setWeaponAttack", {
    weaponId: "caster",
    attack: {
      id: "bolt",
      name: "Bolt",
      timing: { windup: WINDUP, active: 0.1, recovery: 0.3 },
      shape: { type: "projectile", projectile: { speed: 300, lifetime: 2, look: { origin: [20, -10], appear: "windup", art: { object: "bolt", charge: "charge", fly: "fly", burst: "burst" } } } },
    },
  });
  return op(p, "setBehavior", {
    characterId: "charger",
    behavior: {
      initial: "wait",
      states: {
        wait: { action: { type: "wait" }, transitions: [{ when: { type: "after", seconds: 0.3 }, to: "cast" }] },
        cast: { action: { type: "useWeapon", weapon: "caster", aim: "player" }, transitions: [{ when: { type: "actionDone" }, to: "wait" }] },
      },
      interrupts: [],
    },
  });
}
