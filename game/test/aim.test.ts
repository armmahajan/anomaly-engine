import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  aimAt,
  ARENA_FLOOR,
  attackFrames,
  circleHitsBox,
  fanHeadings,
  hitPolygons,
  pickAttack,
  polygonHitsBox,
  projectilePath,
  ProjectSpec,
  Rig,
  toRuntimeProject,
  toWorld,
  Weapon,
  WeaponAttack,
  wielderAim,
  type EntityState,
  type HitBox,
  type XY,
} from "@anomaly/core";
import { arena, entity, FPS, range, simulate, type EnemySetup, type Input, type Sample, type Scenario } from "./simulate.ts";

// Mouse aiming (controls.aim "mouse", the default) in the real runtime, mirrored against the core
// weapon model (weaponModel.ts): every shape aimed off the axes hits on the frame the model says and
// reaches as far; attacks are picked by the aim's bucket; the player turns toward the aim for the
// attack and back after; mouse buttons are keys; the aim keys win while held; and a project aiming
// with the keys plays frame for frame as it did, the mouse ignored.

const FLOOR = ARENA_FLOOR;
const PLAYER = { width: 28, height: 44 };
const DUMMY = { width: 32, height: 32 };
const PRESS = 5;
const LAG = 2;
const press = (action: Input, from: number, to = from + 2) => ({ action, from, to });
const track = (samples: Sample[], id: string) => samples.map((x) => entity(x, id));
const rest = { action: { type: "wait" } };
const slow = { windup: 0.2, active: 0.2, recovery: 0.2 };

type AttackInput = Record<string, unknown>;
const attack = (a: AttackInput) => ({ id: "a", name: "A", hitStop: 0, ...a });
const weapon = (id: string, attacks: AttackInput[]) => ({ id, name: id, attacks: attacks.map(attack) });

function armed(project: ProjectSpec, weapons: object[], main: string | null, opts: { more?: object[]; aim?: "mouse" | "keys" } = {}): ProjectSpec {
  return ProjectSpec.parse({
    ...project,
    controls: { ...project.controls, aim: opts.aim ?? "mouse" },
    weapons: { list: weapons, loadout: { slots: [{ id: "main", label: "Main", action: "attack", start: main }, ...(opts.more ?? [])], cycle: false } },
  });
}
const run = (project: ProjectSpec, frames: number, input: Scenario["input"] = [], aim: Scenario["aim"] = []): Scenario => ({ project, frames, samples: range(0, frames), input, aim });
const flyer = (id: string, at: [number, number], extra: Partial<EnemySetup> = {}): EnemySetup => ({ id, at, movement: "flying", stats: { health: 99 }, initial: "idle", states: { idle: rest }, ...extra });

// --- every shape off the axes -----------------------------------------------------------------

const SHAPES = {
  arc: { shape: { type: "arc", radius: 80, from: -90, to: 90 }, timing: slow },
  box: { shape: { type: "box", width: 40, height: 30, offset: [0, 0] }, timing: slow },
  thrust: { shape: { type: "thrust", length: 90, width: 20 }, timing: slow },
  shot: { shape: { type: "projectile", projectile: { speed: 600, lifetime: 0.3, size: 4 } }, timing: { windup: 0.05, active: 0.1, recovery: 0.1 } },
} as const;
type ShapeName = keyof typeof SHAPES;
/** Off-axis aims (room degrees, y down) and where the player stands for each (feet): open air along the aim. */
const ANGLES = { 30: [600, 544], 150: [392, 544], [-120]: [800, FLOOR] } as Record<number, [number, number]>;

/** The core model's attack frame of the first hit on a still target (null: never), for a wielder at `centre` facing `facing`. */
function predicted(a: AttackInput, aim: XY, centre: XY, facing: number, body: { width: number; height: number }, target: HitBox): number | null {
  const parsed = WeaponAttack.parse(attack(a));
  const f = attackFrames(parsed);
  if (parsed.shape.type === "projectile") {
    const p = parsed.shape.projectile;
    let best: number | null = null;
    for (const h of fanHeadings(p, aim)) {
      const k = projectilePath(p, h).findIndex((q) => circleHitsBox({ x: centre.x + q.x * facing, y: centre.y + q.y }, p.size, target));
      if (k >= 0 && (best === null || f.windup + 1 + k < best)) best = f.windup + 1 + k;
    }
    return best;
  }
  for (let i = 0; i < f.active; i++) {
    if (hitPolygons(parsed.shape, aim, body, i, f.active).some((poly) => polygonHitsBox(toWorld(poly, centre, facing), target))) return f.windup + i;
  }
  return null;
}

const boxAt = (c: XY, size: { width: number; height: number }): HitBox => [c.x - size.width / 2, c.y - size.height / 2, c.x + size.width / 2, c.y + size.height / 2];

/** How far along the aim (from the player's centre) a dummy's centre can be and still be hit, by the model. */
function modelReach(name: ShapeName, deg: number): number {
  const [x, y] = ANGLES[deg]!;
  const centre = { x, y: y - PLAYER.height / 2 };
  const turned = wielderAim(aimAt(deg), 1);
  const dir = aimAt(deg);
  let far = 0;
  for (let d = 0; d < 400; d += 0.5) {
    if (predicted(SHAPES[name], turned.aim, centre, turned.facing, PLAYER, boxAt({ x: centre.x + dir.x * d, y: centre.y + dir.y * d }, DUMMY)) !== null) far = d;
  }
  return far;
}

/** A weapon with a forward and an up attack of the same shape (so every bucket but down has one). */
const twoWay = (name: ShapeName) => weapon("w", [{ id: "a", name: "A", ...SHAPES[name] }, { id: "u", name: "U", trigger: { aim: "up" }, ...SHAPES[name] }]);

const offAxis: Record<string, Scenario> = {};
const placed: Record<string, number> = {};
for (const name of Object.keys(SHAPES) as ShapeName[]) {
  for (const deg of Object.keys(ANGLES).map(Number)) {
    const [x, y] = ANGLES[deg]!;
    const reach = modelReach(name, deg);
    const dir = aimAt(deg);
    for (const [side, d] of [["in", Math.floor(reach) - 3], ["out", Math.ceil(reach) + 3]] as const) {
      const centre = { x: x + dir.x * d, y: y - PLAYER.height / 2 + dir.y * d };
      const key = `${name}_${deg}_${side}`;
      placed[key] = d;
      offAxis[key] = run(armed(arena([flyer("dummy", [Math.round(centre.x), Math.round(centre.y + DUMMY.height / 2)])], [x, y]), [twoWay(name)], "w"), 70, [press("MouseLeft", PRESS)], [{ from: 0, angle: deg }]);
    }
  }
}

// --- picking, facing, mouse buttons, the aim keys ----------------------------------------------

const picker = weapon("w", [
  { id: "a", name: "Forward", shape: { type: "arc", radius: 60 }, timing: slow },
  { id: "u", name: "Up", trigger: { aim: "up" }, shape: { type: "arc", radius: 60 }, timing: slow },
  { id: "d", name: "Down", trigger: { aim: "down" }, shape: { type: "arc", radius: 60 }, timing: slow },
]);
const open = (main: string | null, weapons: object[] = [picker], opts: Parameters<typeof armed>[3] = {}) => armed(arena([], [800, FLOOR]), weapons, main, opts);
const picking = {
  ground_up: run(open("w"), 40, [press("MouseLeft", PRESS)], [{ from: 0, angle: -100 }]),
  ground_forward: run(open("w"), 40, [press("MouseLeft", PRESS)], [{ from: 0, angle: -40 }]),
  ground_down: run(open("w"), 40, [press("MouseLeft", PRESS)], [{ from: 0, angle: 100 }]),
  air_down: run(open("w"), 40, [press("jump", 1, 30), press("MouseLeft", 10)], [{ from: 0, angle: 100 }]),
};

const turns = {
  // Standing facing right, the cursor behind: the attack faces left, then back.
  behind: run(open("w"), 60, [press("MouseLeft", PRESS)], [{ from: 0, angle: 180 }]),
  // Running right with the cursor behind: strikes behind while still moving right.
  retreat: run(open("w"), 60, [press("move_right", 0, 50), press("MouseLeft", PRESS)], [{ from: 0, angle: 180 }]),
  // The aim keys win over the mouse while held: up, no turn.
  keyUp: run(open("w"), 40, [press("aim_up", 0, 30), press("attack", PRESS)], [{ from: 0, angle: 180 }]),
  // controls.aim "keys": the cursor is ignored (a click still attacks: it is a key).
  keysMode: run(open("w", [picker], { aim: "keys" }), 40, [press("MouseLeft", PRESS)], [{ from: 0, angle: 180 }]),
  // Right click is alt attack's.
  altClick: run(open(null, [picker, weapon("bow", [{ id: "loose", name: "Loose", shape: { type: "arc", radius: 50 }, timing: slow }])], { more: [{ id: "alt", label: "Alt", action: "alt_attack", start: "bow" }] }), 40, [press("MouseRight", PRESS)], [{ from: 0, angle: -20 }]),
};

/** The built-in attack (no weapon in the attack slot): the cursor picks up / side / down; a side swing turns toward it. */
const builtIn = {
  left: run(armed(arena([flyer("dummy", [750, FLOOR])], [800, FLOOR]), [], null), 40, [press("MouseLeft", PRESS)], [{ from: 0, angle: 170 }]),
  up: run(armed(arena([], [800, FLOOR]), [], null), 40, [press("MouseLeft", PRESS)], [{ from: 0, angle: -110 }]),
  groundDown: run(armed(arena([], [800, FLOOR]), [], null), 40, [press("MouseLeft", PRESS)], [{ from: 0, angle: 95 }]),
  airDown: run(armed(arena([], [800, FLOOR]), [], null), 40, [press("jump", 1, 30), press("MouseLeft", 12)], [{ from: 0, angle: 95 }]),
};

/** A pogo aimed with the mouse: in the air over an enemy, the cursor below (the down bucket). */
const pogo = run(
  armed(arena([{ id: "dummy", at: [300, FLOOR], stats: { contactDamage: 1, knockback: 300, health: 9 }, initial: "idle", states: { idle: rest } }], [300, 400]), [weapon("w", [{ trigger: { aim: "down" }, movement: { pogo: true }, shape: { type: "thrust", length: 70, width: 30 } }])], "w"),
  60,
  [press("MouseLeft", 22)],
  [{ from: 0, angle: 80 }],
);

// --- aiming with the keys plays as before ------------------------------------------------------

const sword = weapon("w", [
  { id: "a", name: "A", shape: { type: "arc", radius: 70 }, combo: { next: "b" }, movement: { lunge: 200, recoil: 100 } },
  { id: "b", name: "B", shape: { type: "thrust", length: 80 } },
  { id: "up", name: "Up", trigger: { aim: "up" }, shape: { type: "box", width: 40, height: 30 } },
  { id: "down", name: "Down", trigger: { aim: "down" }, movement: { pogo: true }, shape: { type: "arc", radius: 60, from: -45, to: 45 } },
]);
const knight: EnemySetup = {
  id: "knight",
  at: [420, FLOOR],
  stats: { health: 5 },
  initial: "attack",
  states: { attack: { action: { type: "useWeapon", weapon: "w", aim: "player" }, go: [[{ type: "actionDone" }, "rest"]] }, rest: { action: { type: "wait" }, go: [[{ type: "after", seconds: 0.5 }, "attack"]] } },
};
const keysInput = [press("attack", 10), press("attack", 32), press("aim_up", 60, 70), press("attack", 62), press("move_left", 75, 100), press("attack", 90), press("jump", 110, 125), press("aim_down", 115, 140), press("attack", 120), press("attack", 150), press("attack", 165)];
/** The cursor wandering all round the player the whole time. */
const wander = range(0, 180, 6).map((f, i) => ({ from: f, to: f + 6, angle: (i * 47) % 360 }));
const same = (aim: "mouse" | "keys", cursor: boolean, main: string | null) =>
  run(armed(arena([knight, flyer("bat", [160, FLOOR - 140])], [160, FLOOR]), [sword], main, { aim }), 180, keysInput, cursor ? wander : []);
const sameScenarios = {
  keysWeapon: same("keys", false, "w"),
  keysWeaponCursor: same("keys", true, "w"),
  mouseWeaponNoCursor: same("mouse", false, "w"),
  keysBuiltIn: same("keys", false, null),
  keysBuiltInCursor: same("keys", true, null),
  mouseBuiltInNoCursor: same("mouse", false, null),
  // The cursor moving while the player only moves: the knight fights exactly as without it.
  mouseCursorNoAttacks: run(armed(arena([knight], [160, FLOOR]), [sword], "w"), 180, [press("move_right", 20, 60)], wander),
  mouseNoCursorNoAttacks: run(armed(arena([knight], [160, FLOOR]), [sword], "w"), 180, [press("move_right", 20, 60)]),
};

let r: Record<string, Sample[]>;
beforeAll(() => {
  const all = { ...offAxis, ...picking, ...turns, ...builtIn, pogo, ...sameScenarios } as Record<string, Scenario>;
  const results = simulate(Object.values(all));
  r = Object.fromEntries(Object.keys(all).map((k, i) => [k, results[i]!]));
}, 180_000);

const hitFrame = (samples: Sample[], id: string, from = 99) => track(samples, id).findIndex((e) => e.health < from);
const centreOf = (e: EntityState, h: number): XY => ({ x: e.x, y: e.y - h / 2 });
const boxOf = (e: EntityState, size: { width: number; height: number }): HitBox => [e.x - size.width / 2, e.y - size.height, e.x + size.width / 2, e.y];
const attacks = (samples: Sample[]) => [...new Set(track(samples, "player").map((e) => e.behaviorState).filter((s) => s?.startsWith("attack:") || s?.startsWith("slash_")))];

describe("mouse aiming: every shape off the axes (mirrored by the core model)", () => {
  for (const name of Object.keys(SHAPES) as ShapeName[]) {
    for (const deg of Object.keys(ANGLES).map(Number)) {
      it(`${name} at ${deg}°: picked by its bucket, turned toward the aim, hits on the frame the model says, and reaches as far`, () => {
        const samples = r[`${name}_${deg}_in`]!;
        const player = track(samples, "player");
        const start = player.findIndex((e) => e.behaviorState?.startsWith("attack:"));
        expect(start).toBe(PRESS + LAG);
        const bucket = pickAttack(Weapon.parse(twoWay(name)), aimAt(deg), false, null)!.id;
        expect(player[start]!.behaviorState).toBe(`attack:${bucket}`);
        // The aim it was made with, as the runtime reports it, toward the cursor.
        const aim = samples[start - 1]!.aim!;
        expect(aim.mouse).toBe(true);
        expect(Math.atan2(aim.y, aim.x)).toBeCloseTo((deg * Math.PI) / 180, 2);
        const turned = wielderAim(aim, 1);
        expect(samples[start]!.facing).toBe(turned.facing);
        const hit = hitFrame(samples, "dummy_1");
        expect(hit, `dummy ${placed[`${name}_${deg}_in`]} px along the aim`).toBeGreaterThan(0);
        const before = samples[hit - 1]!;
        expect(hit - PRESS - LAG).toBe(predicted(SHAPES[name], turned.aim, centreOf(entity(before, "player"), PLAYER.height), turned.facing, PLAYER, boxOf(entity(before, "dummy_1"), DUMMY)));
        // A few px past the reach along the aim: never hit (the model agrees).
        const out = r[`${name}_${deg}_out`]!;
        expect(hitFrame(out, "dummy_1")).toBe(-1);
        expect(predicted(SHAPES[name], turned.aim, centreOf(entity(out[PRESS]!, "player"), PLAYER.height), turned.facing, PLAYER, boxOf(entity(out[PRESS]!, "dummy_1"), DUMMY))).toBeNull();
      });
    }
  }
});

describe("mouse aiming: picking, turning, buttons, the aim keys", () => {
  it("picks by the cursor's bucket: within 45° of up is up; down only in the air (on the ground it's forward)", () => {
    expect(attacks(r.ground_up!)).toEqual(["attack:u"]);
    expect(attacks(r.ground_forward!)).toEqual(["attack:a"]);
    expect(attacks(r.ground_down!)).toEqual(["attack:a"]);
    expect(attacks(r.air_down!)).toEqual(["attack:d"]);
  });

  it("an attack turns the player toward the aim for its duration, then movement decides again", () => {
    const behind = r.behind!;
    const states = track(behind, "player").map((e) => e.behaviorState);
    const start = states.findIndex((s) => s === "attack:a");
    const end = states.findIndex((s, i) => i > start && s === null);
    expect(behind.slice(0, start).every((s) => s.facing === 1)).toBe(true);
    expect(behind.slice(start, end).every((s) => s.facing === -1)).toBe(true);
    expect(behind.slice(end).every((s) => s.facing === 1)).toBe(true);
    // Retreating: strikes behind while still running the other way.
    const retreat = r.retreat!;
    const during = track(retreat, "player").map((e, i) => ({ e, s: retreat[i]! })).filter(({ e }) => e.behaviorState === "attack:a");
    expect(during.length).toBeGreaterThan(10);
    expect(during.every(({ e, s }) => s.facing === -1 && e.velocityX > 0)).toBe(true);
    expect(retreat.at(-1)!.facing).toBe(1);
  });

  it("left click attacks and right click alt-attacks (mouse buttons are keys in the bindings)", () => {
    expect(attacks(r.behind!)).toEqual(["attack:a"]);
    expect(attacks(r.altClick!)).toEqual(["attack:loose"]);
  });

  it("the aim keys win over the mouse while held; controls.aim keys ignores the cursor", () => {
    expect(attacks(r.keyUp!)).toEqual(["attack:u"]);
    expect(new Set(r.keyUp!.map((s) => s.facing))).toEqual(new Set([1]));
    expect(r.keyUp![10]!.aim).toEqual({ x: 0, y: -1, mouse: false });
    expect(r.keyUp!.at(-1)!.aim).toMatchObject({ mouse: true });
    expect(attacks(r.keysMode!)).toEqual(["attack:a"]);
    expect(new Set(r.keysMode!.map((s) => s.facing))).toEqual(new Set([1]));
    expect(r.keysMode![10]!.aim).toEqual({ x: 1, y: 0, mouse: false });
  });

  it("the built-in attack: the cursor picks up, side (turning toward it) or down (in the air only)", () => {
    expect(attacks(r.left!)).toEqual(["slash_forward"]);
    const swing = r.left!.filter((s) => entity(s, "player").behaviorState === "slash_forward");
    expect(swing.every((s) => s.facing === -1)).toBe(true);
    expect(hitFrame(r.left!, "dummy_1")).toBeGreaterThan(0);
    expect(r.left!.at(-1)!.facing).toBe(1);
    expect(attacks(r.up!)).toEqual(["slash_up"]);
    expect(attacks(r.groundDown!)).toEqual(["slash_forward"]);
    expect(attacks(r.airDown!)).toEqual(["slash_down"]);
  });

  it("a pogo aimed down with the mouse bounces off an enemy, unhurt", () => {
    const player = track(r.pogo!, "player");
    const hit = hitFrame(r.pogo!, "dummy_1", 9);
    expect(hit).toBeGreaterThan(22);
    expect(player[hit]!.velocityY).toBeLessThan(-500);
    expect(new Set(player.map((e) => e.health))).toEqual(new Set([5]));
  });
});

describe("aiming with the keys plays as before", () => {
  const strip = (samples: Sample[]) => samples.map((s) => s.entities);
  it("controls.aim keys: the cursor moving all round changes nothing, frame for frame (weapons and the built-in attack, an enemy's useWeapon)", () => {
    expect(strip(r.keysWeaponCursor!)).toEqual(strip(r.keysWeapon!));
    expect(strip(r.keysBuiltInCursor!)).toEqual(strip(r.keysBuiltIn!));
    expect(track(r.keysWeapon!, "player").some((e) => e.behaviorState === "attack:up")).toBe(true);
    expect(track(r.keysBuiltIn!, "player").some((e) => e.behaviorState === "slash_up")).toBe(true);
  });

  it("controls.aim mouse with the mouse never used plays exactly as aiming with the keys", () => {
    expect(strip(r.mouseWeaponNoCursor!)).toEqual(strip(r.keysWeapon!));
    expect(strip(r.mouseBuiltInNoCursor!)).toEqual(strip(r.keysBuiltIn!));
  });

  it("enemies fight the same with the cursor moving", () => {
    expect(track(r.mouseCursorNoAttacks!, "knight_1")).toEqual(track(r.mouseNoCursorNoAttacks!, "knight_1"));
    expect(track(r.mouseCursorNoAttacks!, "player")).toEqual(track(r.mouseNoCursorNoAttacks!, "player"));
    expect(track(r.mouseCursorNoAttacks!, "knight_1").some((e) => e.behaviorState === "attack")).toBe(true);
  });
});

// --- the drawn weapon follows the aim ------------------------------------------------------------

const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));

/** A player rig with a two-bone arm held out forward (shoulder at (0, -32), hand at (20, -32)); `grip` on the forearm, or on the body (no arm to turn). */
function armRig(grip: "arm" | "body"): Rig {
  return Rig.parse({
    bones: [
      { id: "root", parent: null, pivot: [0, 0] },
      { id: "body", parent: "root", pivot: [0, -22] },
      { id: "arm_upper", parent: "body", pivot: [0, -32] },
      { id: "arm_lower", parent: "arm_upper", pivot: [10, -32] },
    ],
    parts: [
      { id: "torso", bone: "body", z: 0, shape: { type: "ellipse", center: [0, -22], rx: 12, ry: 20 }, fill: "#5577aa" },
      { id: "upper", bone: "arm_upper", z: 1, shape: { type: "stroke", points: [[0, -32], [10, -32]], width: 5 }, fill: "#aa7755" },
      { id: "lower", bone: "arm_lower", z: 2, shape: { type: "stroke", points: [[10, -32], [20, -32]], width: 4 }, fill: "#aa7755" },
    ],
    grips: [grip === "arm" ? { id: "hand", bone: "arm_lower", at: [20, -32], angle: 0 } : { id: "hand", bone: "body", at: [12, -26], angle: 0 }],
  });
}

const launcher = weapon("gun", [{ id: "fire", name: "Fire", trigger: { aim: "any" }, shape: { type: "projectile", projectile: { speed: 300, lifetime: 1, size: 4 } }, timing: { windup: 0.15, active: 0.1, recovery: 0.2 } }]);

function drawn(rig: Rig | null): ProjectSpec {
  const base = armed(arena([], [800, FLOOR]), [launcher], "gun");
  if (!rig) return base;
  const asset = { id: "look", name: "Look", kind: "character", brief: "", concepts: [], chosen: null, rig, preview: null, clips: {}, clipPreviews: {}, stateClips: {} };
  return ProjectSpec.parse({ ...base, characters: base.characters.map((c) => (c.kind === "player" ? { ...c, appearance: "look" } : c)), art: { ...base.art, assets: [asset] } });
}

type ProbeFrame = { state: string | null; facing: number; centre: [number, number]; hand: [number, number]; pointing: [number, number]; tip: [number, number]; shots: { x: number; y: number; vx: number; vy: number }[] };

function probe(project: ProjectSpec, angle: number): ProbeFrame[] {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-aim-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ project: toRuntimeProject(project), angle, press: 5, frames: 45 }));
    execFileSync(process.env.GODOT ?? "godot", ["--headless", "--fixed-fps", String(FPS), "--path", GAME_DIR, "--script", "res://tests/aim_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")], {
      stdio: "pipe",
      timeout: 60_000,
    });
    const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { error: string; frames: ProbeFrame[] };
    if (out.error) throw new Error(out.error);
    return out.frames;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const degOf = (v: [number, number]) => Math.atan2(v[1], v[0]) * (180 / Math.PI);
const gap = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

describe("the drawn weapon follows a mouse aim (headless runtime)", () => {
  for (const [label, rig] of [
    ["a rig turning its arm", armRig("arm")],
    ["a rig without an arm (the weapon turns)", armRig("body")],
    ["no rig (a box)", null],
  ] as const) {
    it(`${label}: an off-axis shot leaves the way the weapon points, near its tip's direction; the turn blends in and back out`, () => {
      for (const angle of [-30, 150, -120]) {
        const frames = probe(drawn(rig), angle);
        const fired = frames.findIndex((f) => f.shots.length > 0);
        expect(fired, `${angle}°: a shot`).toBeGreaterThan(0);
        const f = frames[fired]!;
        const shot = f.shots[0]!;
        // The projectile flies toward the cursor, the way the held weapon points.
        expect(gap(degOf([shot.vx, shot.vy]), angle), `${angle}°: shot heading`).toBeLessThan(1);
        expect(gap(degOf(f.pointing), angle), `${angle}°: weapon direction`).toBeLessThan(3);
        // Seen from the body, the weapon's tip is out along the aim too.
        expect(gap(degOf([f.tip[0] - f.centre[0], f.tip[1] - f.centre[1]]), angle), `${angle}°: tip from the centre`).toBeLessThan(25);
        expect(f.facing).toBe(Math.cos((angle * Math.PI) / 180) > 0 ? 1 : -1);
        // Blended: the first windup frame still points (nearly) the way the clip is drawn; after the attack, forward again.
        const start = frames.findIndex((x) => x.state?.startsWith("attack:"));
        const forward = f.facing === 1 ? 0 : 180;
        expect(gap(degOf(frames[start]!.pointing), forward), `${angle}°: windup start`).toBeLessThan(gap(angle, forward) * 0.25);
        const after = frames.findLastIndex((x) => x.state?.startsWith("attack:")) + 1;
        expect(gap(degOf(frames[after]!.pointing), frames[after]!.facing === 1 ? 0 : 180), `${angle}°: after`).toBeLessThan(1);
      }
    }, 120_000);
  }
});
