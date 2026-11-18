import { beforeAll, describe, expect, it } from "vitest";
import {
  AIM_VECTORS,
  ARENA_FLOOR,
  attackFrames,
  circleHitsBox,
  createDefaultProject,
  fanHeadings,
  hitPolygons,
  polygonHitsBox,
  projectilePath,
  ProjectSpec,
  toWorld,
  WeaponAttack,
  type HitBox,
  type EntityState,
  type XY,
} from "@anomaly/core";
import { arena, entity, playtestRoom, range, simulate, type EnemySetup, type Input, type Sample, type Scenario } from "./simulate.ts";

// Weapons in the real runtime (headless, 60 fps), mirrored against the core weapon model
// (packages/core/src/combat/weaponModel.ts): when each hit shape hits, how far it reaches, how
// far projectiles fly, pogo bounces, combos, holds, ammo, enemies wielding weapons, and that a
// project without weapons plays exactly as before.

const FLOOR = ARENA_FLOOR;
const PLAYER = { width: 28, height: 44 };
const DUMMY = { width: 32, height: 32 };
const press = (action: Input, from: number, to = from + 2) => ({ action, from, to });
const track = (samples: Sample[], id: string) => samples.map((x) => entity(x, id));
const rest = { action: { type: "wait" } };
const dummy = (x: number, extra: Partial<EnemySetup> = {}): EnemySetup => ({ id: "dummy", at: [x, FLOOR], stats: { health: 99 }, initial: "idle", states: { idle: rest }, ...extra });

type AttackInput = Record<string, unknown>;
const attack = (a: AttackInput) => ({ id: "a", name: "A", hitStop: 0, ...a });
const weapon = (id: string, attacks: AttackInput[], extra: object = {}) => ({ id, name: id, attacks: attacks.map(attack), ...extra });

/** `project` with these weapons, the attack slot starting with `main` (null = the built-in attack), and more slots. */
function armed(project: ProjectSpec, weapons: object[], main: string | null, more: object[] = [], cycle = false, world: object = {}): ProjectSpec {
  return ProjectSpec.parse({
    ...project,
    weapons: { list: weapons, loadout: { slots: [{ id: "main", label: "Main", action: "attack", start: main }, ...more], cycle } },
    world: { ...project.world, ...world },
  });
}

const run = (project: ProjectSpec, frames: number, input: Scenario["input"] = []): Scenario => ({ project, frames, samples: range(0, frames), input });

/** The press is sent before sample PRESS; attack frame k shows in sample PRESS + LAG + k (a sample is taken as a physics frame begins). */
const PRESS = 5;
const LAG = 2;
const slow = { windup: 0.2, active: 0.2, recovery: 0.2 };
const SHAPES = {
  arc: { shape: { type: "arc", radius: 80, from: -90, to: 90 }, timing: slow },
  box: { shape: { type: "box", width: 40, height: 30, offset: [0, 0] }, timing: slow },
  thrust: { shape: { type: "thrust", length: 90, width: 20 }, timing: slow },
} as const;
/** Reach from the player's centre, as the settings say. */
const REACH = { arc: 80, box: PLAYER.width / 2 + 40 / 2, thrust: 90 };
/** A dummy whose near edge is `edge` px ahead of the player's centre (player at x 160). */
const ahead = (edge: number) => 160 + edge + DUMMY.width / 2;

const shot = { shape: { type: "projectile", projectile: { speed: 600, lifetime: 1.005, size: 2 } }, timing: { windup: 0.05, active: 0.1, recovery: 0.1 } };
const TRAVEL = 600 * 1.005;

const scenarios = {
  ...Object.fromEntries(
    Object.entries(SHAPES).flatMap(([name, a]) => [
      [`${name}_in`, run(armed(arena([dummy(ahead(REACH[name as keyof typeof REACH] - 1))]), [weapon("w", [a])], "w"), 60, [press("attack", PRESS)])],
      [`${name}_out`, run(armed(arena([dummy(ahead(REACH[name as keyof typeof REACH] + 1))]), [weapon("w", [a])], "w"), 60, [press("attack", PRESS)])],
    ]),
  ),
  shot_in: run(armed(arena([dummy(ahead(TRAVEL * 0.98))]), [weapon("w", [shot])], "w"), 90, [press("attack", PRESS)]),
  shot_out: run(armed(arena([dummy(ahead(TRAVEL * 1.02 + 2))]), [weapon("w", [shot])], "w"), 90, [press("attack", PRESS)]),
  combo: run(
    armed(arena([dummy(200)]), [weapon("w", [{ id: "a", name: "A", combo: { next: "b", window: 0.3 }, shape: { type: "arc", radius: 60 }, timing: { windup: 0.05, active: 0.1, recovery: 0.1 } }, { id: "b", name: "B", shape: { type: "arc", radius: 60 } }])], "w"),
    120,
    [press("attack", 5), press("attack", 15), press("attack", 60)],
  ),
  ammo: run(
    armed(arena([dummy(400)]), [weapon("w", [{ ...shot, cooldown: 0, ammo: { item: "bolt", per: 1 } }])], "w", [], false, {
      items: [{ id: "bolt", name: "Bolt" }],
      handlers: [{ on: { type: "gameStarted" }, do: [{ type: "giveItem", item: "bolt", count: 2 }] }],
    }),
    110,
    [press("attack", 5), press("attack", 40), press("attack", 75)],
  ),
  holdLong: run(armed(arena([dummy(200)]), [weapon("w", [{ id: "tap", name: "Tap", shape: { type: "arc", radius: 60 } }, { id: "charged", name: "Charged", trigger: { hold: 0.5 }, shape: { type: "arc", radius: 60 } }])], "w"), 90, [press("attack", 5, 45)]),
  holdShort: run(armed(arena([dummy(200)]), [weapon("w", [{ id: "tap", name: "Tap", shape: { type: "arc", radius: 60 } }, { id: "charged", name: "Charged", trigger: { hold: 0.5 }, shape: { type: "arc", radius: 60 } }])], "w"), 90, [press("attack", 5, 15)]),
  selfFan: run(armed(arena([]), [weapon("w", [{ shape: { type: "projectile", projectile: { count: 8, spread: 180, speed: 300, lifetime: 0.6 } }, cooldown: 0 }])], "w"), 60, [press("attack", 5), press("attack", 30)]),
  cycle: run(
    armed(arena([]), [weapon("one", [{ shape: { type: "arc", radius: 60 } }]), weapon("two", [{ shape: { type: "arc", radius: 60 } }])], "one", [], true, {
      handlers: [{ on: { type: "gameStarted" }, do: [{ type: "giveWeapon", weapon: "two" }] }],
    }),
    30,
    [press("weapon_cycle", 10)],
  ),
};

/** The player in the air over a dummy, swinging down (combat.test.ts pogo, with weapons). */
const POGO = {
  arc: { trigger: { aim: "down" }, movement: { pogo: true }, shape: { type: "arc", radius: 60, from: -45, to: 45 } },
  box: { trigger: { aim: "down" }, movement: { pogo: true }, shape: { type: "box", width: 40, height: 40 } },
  thrust: { trigger: { aim: "down" }, movement: { pogo: true }, shape: { type: "thrust", length: 70, width: 30 } },
} as const;
const pogoArena = (a: AttackInput) =>
  armed(arena([{ id: "dummy", at: [300, FLOOR], stats: { contactDamage: 1, knockback: 300, health: 9 }, initial: "idle", states: { idle: rest } }], [300, 400]), [weapon("w", [a])], "w");
const pogoScenarios = Object.fromEntries(Object.entries(POGO).map(([k, a]) => [k, run(pogoArena(a), 60, [press("aim_down", 0, 40), press("attack", 22)])]));

/** Falling onto spikes (or a breakable floor), striking down first. */
const floorRoom = (tile: string) => {
  const rows = [...Array(14).fill(".".repeat(20)), `######${tile.repeat(8)}######`, "#".repeat(20)];
  return armed(playtestRoom(createDefaultProject(), { rows }, { x: 320, y: 256 }), [weapon("w", [POGO.thrust])], "w");
};
const floorScenarios = { spikes: run(floorRoom("^"), 60, [press("aim_down", 0, 40), press("attack", 20)]), breakable: run(floorRoom("%"), 60, [press("aim_down", 0, 40), press("attack", 20)]) };

/** Enemies wielding weapons: a swing in reach (the player stands still), and a shot aimed at the player. */
const KNIGHT_ATTACK = { shape: { type: "arc", radius: 70, from: -60, to: 60 }, timing: { windup: 0.3, active: 0.15, recovery: 0.3 }, damage: 1, knockback: 300 };
const knight = (x: number, w: string, aim = "facing"): EnemySetup => ({
  id: "knight",
  at: [x, FLOOR],
  stats: { health: 5 },
  initial: "attack",
  states: { attack: { action: { type: "useWeapon", weapon: w, aim }, go: [[{ type: "actionDone" }, "rest"]] }, rest },
});
const enemyScenarios = {
  swing: run(armed(arena([knight(230, "sword")]), [weapon("sword", [KNIGHT_ATTACK])], null), 60),
  shoot: run(armed(arena([knight(600, "gun", "player")]), [weapon("gun", [{ shape: { type: "projectile", projectile: { speed: 500, lifetime: 2, size: 8 } }, timing: { windup: 0.3, active: 0.1, recovery: 0.3 } }])], null), 90),
};

/** Today's built-in attack, and the same with weapons in the project but none in the attack slot. */
const plain = arena([dummy(260, { stats: { health: 3 } })]);
const plainInput = [press("attack", 10), press("aim_up", 30, 40), press("attack", 32), press("attack", 60), press("jump", 70, 80), press("aim_down", 75, 100), press("attack", 85)];
const sameScenarios = {
  plain: run(plain, 120, plainInput),
  withWeapons: run(armed(plain, [weapon("w", [{ shape: { type: "arc", radius: 200 } }])], null, [{ id: "alt", label: "Alt", action: "alt_attack", start: "w" }]), 120, plainInput),
};

let r: Record<string, Sample[]>;
beforeAll(() => {
  const all = { ...scenarios, ...pogoScenarios, ...floorScenarios, ...enemyScenarios, ...sameScenarios } as Record<string, Scenario>;
  const results = simulate(Object.values(all));
  r = Object.fromEntries(Object.keys(all).map((k, i) => [k, results[i]!]));
}, 120_000);

const hitFrame = (samples: Sample[], id: string, from = 99) => track(samples, id).findIndex((e) => e.health < from);
const centreOf = (e: EntityState, h: number): XY => ({ x: e.x, y: e.y - h / 2 });
const boxOf = (e: EntityState, size: { width: number; height: number }): HitBox => [e.x - size.width / 2, e.y - size.height, e.x + size.width / 2, e.y];

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

describe("player weapons: hit shapes (mirrored by the core model)", () => {
  for (const name of Object.keys(SHAPES) as (keyof typeof SHAPES)[]) {
    it(`${name}: hits only while active, on the frame the model says, and reaches within 2 px of its setting`, () => {
      const samples = r[`${name}_in`]!;
      const hit = hitFrame(samples, "dummy_1");
      const player = track(samples, "player");
      const frames = attackFrames(WeaponAttack.parse(attack(SHAPES[name])));
      expect(hit).toBeGreaterThan(0);
      const k = hit - PRESS - LAG;
      expect(k).toBeGreaterThanOrEqual(frames.windup - 1);
      expect(k).toBeLessThanOrEqual(frames.windup + frames.active);
      expect(player[hit]!.phase).toBe("active");
      expect(player[hit]!.behaviorState).toBe("attack:a");
      const before = samples[hit - 1]!;
      expect(k).toBe(predicted(SHAPES[name], AIM_VECTORS.forward, centreOf(entity(before, "player"), PLAYER.height), 1, PLAYER, boxOf(entity(before, "dummy_1"), DUMMY)));
      // One step past the reach: never hit (the model agrees).
      expect(hitFrame(r[`${name}_out`]!, "dummy_1")).toBe(-1);
      const out = r[`${name}_out`]![PRESS]!;
      expect(predicted(SHAPES[name], AIM_VECTORS.forward, centreOf(entity(out, "player"), PLAYER.height), 1, PLAYER, boxOf(entity(out, "dummy_1"), DUMMY))).toBeNull();
      // The attack is over after its recovery.
      expect(player[PRESS + LAG + frames.total]!.behaviorState).toBeNull();
    });
  }

  it("projectile: flies speed x lifetime (within 2%), hitting on the frame the model says", () => {
    const hit = hitFrame(r.shot_in!, "dummy_1");
    expect(hit).toBeGreaterThan(0);
    const before = r.shot_in![hit - 1]!;
    expect(hit - PRESS - LAG).toBe(predicted(shot, AIM_VECTORS.forward, centreOf(entity(r.shot_in![PRESS]!, "player"), PLAYER.height), 1, PLAYER, boxOf(entity(before, "dummy_1"), DUMMY)));
    expect(hitFrame(r.shot_out!, "dummy_1")).toBe(-1);
    const path = projectilePath(WeaponAttack.parse(attack(shot)).shape.type === "projectile" ? { speed: 600, gravity: 0, lifetime: 1.005 } : { speed: 0, gravity: 0, lifetime: 0 }, 0);
    expect(Math.abs(path.at(-1)!.x - TRAVEL) / TRAVEL).toBeLessThan(0.02);
  });
});

describe("player weapons: pogo", () => {
  for (const name of Object.keys(POGO) as (keyof typeof POGO)[]) {
    it(`${name}: a downward hit on an enemy bounces the player up, unhurt, on the frame the model says`, () => {
      const samples = r[name]!;
      const hit = hitFrame(samples, "dummy_1", 9);
      expect(hit).toBeGreaterThan(22);
      const player = track(samples, "player");
      expect(player[hit]!.velocityY).toBeLessThan(-500);
      expect(new Set(player.map((e) => e.health))).toEqual(new Set([5]));
      // The model: the shape of that active frame, at the player's position then, overlaps the dummy; a frame earlier it didn't.
      const parsed = WeaponAttack.parse(attack(POGO[name]));
      const f = attackFrames(parsed);
      const start = player.findIndex((e) => e.behaviorState === "attack:a");
      const at = (s: number) => hitPolygons(parsed.shape, AIM_VECTORS.down, PLAYER, s - start - f.windup, f.active).some((poly) => polygonHitsBox(toWorld(poly, centreOf(player[s]!, PLAYER.height), 1), boxOf(entity(samples[s - 1], "dummy_1"), DUMMY)));
      expect(at(hit)).toBe(true);
      if (hit - 1 - start >= f.windup) expect(at(hit - 1)).toBe(false);
    });
  }

  it("bounces off spikes and breakable floors without touching or breaking them", () => {
    for (const name of ["spikes", "breakable"]) {
      const player = track(r[name]!, "player");
      const bounce = player.findIndex((e, i) => i > 0 && e.velocityY < -500);
      expect(bounce, name).toBeGreaterThan(20);
      expect(new Set(player.map((e) => e.health)), name).toEqual(new Set([5]));
      expect(r[name]!.at(-1)!.deaths, name).toBe(0);
      expect(Math.max(...player.map((e) => e.y)), name).toBeLessThan(14 * 32);
    }
  });
});

describe("player weapons: combos, holds, ammo, cycling, no self-hits", () => {
  it("a press inside the window chains the combo; outside it starts over", () => {
    const states = track(r.combo!, "player").map((e) => e.behaviorState);
    const starts = states.flatMap((s, i) => (s?.startsWith("attack:") && s !== states[i - 1] ? [s] : []));
    expect(starts).toEqual(["attack:a", "attack:b", "attack:a"]);
  });

  it("a release after holding long enough makes the charged attack; a short hold only the tap", () => {
    const seen = (k: string) => new Set(track(r[k]!, "player").map((e) => e.behaviorState).filter((s) => s?.startsWith("attack:")));
    expect(seen("holdLong")).toEqual(new Set(["attack:tap", "attack:charged"]));
    expect(seen("holdShort")).toEqual(new Set(["attack:tap"]));
  });

  it("ammo is spent per use, shown on the HUD, and with none left the attack doesn't start", () => {
    const samples = r.ammo!;
    const bolts = samples.map((s) => s.items.bolt ?? 0);
    expect(bolts[3]).toBe(2);
    expect(bolts.at(-1)).toBe(0);
    expect(samples.map((s) => s.weapons?.hud[0]?.ammo.bolt)).toContain(1);
    const starts = track(samples, "player").filter((e, i, all) => e.behaviorState === "attack:a" && all[i - 1]?.behaviorState !== "attack:a");
    expect(starts).toHaveLength(2);
    expect(99 - entity(samples.at(-1), "dummy_1").health).toBe(2);
  });

  it("the player's own projectiles never hurt the player", () => {
    expect(new Set(track(r.selfFan!, "player").map((e) => e.health))).toEqual(new Set([5]));
  });

  it("giveWeapon carries a weapon; weapon_cycle swaps the main slot to it", () => {
    expect(r.cycle![5]!.weapons).toMatchObject({ owned: ["one", "two"], slots: { main: "one" } });
    expect(r.cycle!.at(-1)!.weapons).toMatchObject({ owned: ["one", "two"], slots: { main: "two" } });
  });
});

describe("enemy weapons (useWeapon)", () => {
  it("an enemy swing hurts the player in its active window, on the frame the model says; done after recovery", () => {
    const samples = r.swing!;
    const hurt = track(samples, "player").findIndex((e) => e.health < 5);
    const knight = track(samples, "knight_1");
    expect(hurt).toBeGreaterThan(0);
    expect(knight[hurt]!.phase).toBe("active");
    // Attack frame 0 is the knight's first physics frame (sample LAG).
    const before = samples[hurt - 1]!;
    expect(hurt - LAG).toBe(predicted(KNIGHT_ATTACK, AIM_VECTORS.forward, centreOf(knight[hurt - 1]!, DUMMY.height), -1, DUMMY, boxOf(entity(before, "player"), PLAYER)));
    const f = attackFrames(WeaponAttack.parse(attack(KNIGHT_ATTACK)));
    expect(knight[f.total + LAG]!.behaviorState).toBe("rest");
    expect(new Set(knight.map((e) => e.health))).toEqual(new Set([5]));
  });

  it("a shot aimed at the player reaches them", () => {
    expect(track(r.shoot!, "player").some((e) => e.health < 5)).toBe(true);
    expect(new Set(track(r.shoot!, "knight_1").map((e) => e.health))).toEqual(new Set([5]));
  });
});

describe("no weapons in the attack slot", () => {
  it("plays exactly as before: the built-in attack, frame for frame", () => {
    const strip = (samples: Sample[]) => samples.map((s) => s.entities);
    expect(strip(r.withWeapons!)).toEqual(strip(r.plain!));
    expect(track(r.plain!, "player").some((e) => e.behaviorState === "slash_up")).toBe(true);
  });
});
