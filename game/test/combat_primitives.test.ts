import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ACTION_TYPES, applyOperation, ARENA_FLOOR, fixtureProject, MIN_WARNING, primitiveParams, ProjectSpec, toRuntimeProject } from "@anomaly/core";
import { arena, entity, FPS, range, simulate, type EnemySetup, type Input, type Sample, type Scenario } from "./simulate.ts";
import { mite, showcaseArena, toad, warden, wisp } from "./fixtures/combatShowcase.ts";

// The enemy combat primitives in the real runtime (headless, 60 fps), then
// three heavy enemies built from them (fixtures/combatShowcase.ts).

const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));
const FLOOR = ARENA_FLOOR;
const s = (seconds: number) => Math.round(seconds * FPS);
const press = (action: Input, from: number, to = from + 2) => ({ action, from, to });
const track = (samples: Sample[], id: string) => samples.map((x) => entity(x, id));
const hp = (samples: Sample[]) => track(samples, "player").map((e) => e.health);
/** First frame the player has lost health (-1: never). */
const hurtAt = (samples: Sample[]) => hp(samples).findIndex((h) => h < 5);
const firstIn = (samples: Sample[], id: string, state: string) => track(samples, id).findIndex((e) => e.behaviorState === state);
const rest = { action: { type: "wait" } };
const toRest: [Record<string, unknown>, string][] = [[{ type: "actionDone" }, "rest"]];
const one = (id: string, at: [number, number], action: Record<string, unknown>, extra: Partial<EnemySetup> = {}): EnemySetup => ({
  id,
  at,
  stats: { knockback: 300, contactDamage: 1 },
  initial: "attack",
  states: { attack: { action, go: toRest }, rest },
  ...extra,
});
const withStats = (project: ProjectSpec, id: string, stats: Record<string, number>) =>
  ProjectSpec.parse({ ...project, characters: project.characters.map((c) => (c.id === id && c.kind === "enemy" ? { ...c, stats: { ...c.stats, ...stats } } : c)) });
const withSpawnHandlers = (project: ProjectSpec, spawnId: string, handlers: object[]) =>
  ProjectSpec.parse({
    ...project,
    world: { ...project.world, rooms: project.world.rooms.map((r) => ({ ...r, spawns: r.spawns.map((sp) => (sp.id === spawnId ? { ...sp, handlers } : sp)) })) },
  });
const run = (project: ProjectSpec, seconds: number, input: Scenario["input"] = []): Scenario => ({ project, frames: s(seconds), samples: range(0, s(seconds)), input });

const STRIKE = { type: "strike", windup: 0.4, active: 0.2, recovery: 0.5, width: 64, height: 48, offsetX: 40 };
const strikeArena = arena([one("brute", [230, FLOOR], STRIKE)]);
const shootArena = arena([one("gun", [600, FLOOR], { type: "shoot", windup: 0.3, speed: 400 })]);
/** The gun under the ledge (x 384-608, top y 544) and the player standing on it, right above. */
const shootBlocked = arena([one("gun", [496, FLOOR], { type: "shoot", windup: 0.3, speed: 400 })], [496, 544]);
const leapArena = arena([one("hopper", [1000, FLOOR], { type: "leap", windup: 0.4, height: 140, maxDistance: 400 })], [1300, FLOOR]);
const leapShort = arena([one("hopper", [1000, FLOOR], { type: "leap", windup: 0.4, height: 140, maxDistance: 200 })], [1500, FLOOR]);
const slamArena = arena([one("pounder", [600, FLOOR], { type: "slam", windup: 0.4, height: 0, waveSpeed: 480, waveReach: 500, waveHeight: 28 })]);
const slamShort = arena([one("pounder", [600, FLOOR], { type: "slam", windup: 0.4, height: 60, waveSpeed: 480, waveReach: 200, waveHeight: 28 })]);
const summonArena = ProjectSpec.parse({
  ...arena(
    [
      {
        id: "caller",
        at: [300, FLOOR],
        stats: { knockback: 300, contactDamage: 0 },
        initial: "call",
        states: { call: { action: { type: "summon", character: "mite", count: 2, max: 3, windup: 0.3 }, go: [[{ type: "actionDone" }, "pause"]] }, pause: { action: { type: "wait" }, go: [[{ type: "after", seconds: 0.5 }, "call"]] } },
      },
      { id: "mite", at: [0, 0], count: 0, stats: { health: 1, knockback: 0, contactDamage: 0 }, initial: "idle", states: { idle: rest } },
    ],
    [200, FLOOR],
  ),
});
const summonWorld = (p: ProjectSpec) => ProjectSpec.parse({ ...p, world: { ...p.world, handlers: [{ on: { type: "enemyKilled", character: "mite" }, do: [{ type: "setFlag", flag: "mite_down" }] }] } });
const teleportArena = (to: string, range: number) => arena([one("blinker", [230, FLOOR], { type: "teleport", to, range, windup: 0.5 }, { stats: { knockback: 300, contactDamage: 1, health: 3 } })]);

/** The player swings at a dummy standing in reach; armor resists the push. */
const armorArena = (armor: number) => withStats(arena([{ id: "dummy", at: [220, FLOOR], stats: { knockback: 0, contactDamage: 0 }, initial: "idle", states: { idle: rest } }]), "dummy", { armor });

const barArena = showcaseArena([
  { character: { ...mite, id: "first", stats: { health: 1, knockback: 0, contactDamage: 0 } }, at: [220, FLOOR], healthBar: "First" },
  { character: { ...mite, id: "plain", stats: { health: 1, knockback: 0, contactDamage: 0 } }, at: [900, FLOOR] },
  { character: { ...mite, id: "second", stats: { health: 1, knockback: 0, contactDamage: 0 } }, at: [1200, FLOOR], healthBar: "Second" },
]);
const barWorld = (() => {
  let p = fixtureProject();
  for (const [op, input] of [
    ["addRoomSpawn", { roomId: "entrance", characterId: "crawler", x: 300, y: 384, spawnId: "guard" }],
    ["setSpawnHealthBar", { roomId: "entrance", spawnId: "guard", healthBar: { title: "Guard" } }],
  ] as const) {
    const result = applyOperation(p, op, input);
    if (!result.ok) throw new Error(result.error.message);
    p = result.project;
  }
  return p;
})();

/** A walker crossing the room at a steady 120 px/s shows how fast the world runs. */
const WALKER: EnemySetup = { id: "walker", at: [700, FLOOR], stats: { knockback: 0, contactDamage: 0 }, initial: "go", states: { go: { action: { type: "patrol", speed: 120, distance: 1200 } } } };
const fxArena = (effects: object[]) =>
  withSpawnHandlers(
    arena([{ id: "target", at: [220, FLOOR], stats: { health: 1, knockback: 0, contactDamage: 0 }, initial: "idle", states: { idle: rest } }, WALKER]),
    "target_1",
    [{ on: { type: "enemyKilled" }, do: [...effects, { type: "setFlag", flag: "felled" }] }],
  );

const scenarios = {
  strike: run(strikeArena, 1.5),
  shoot: run(shootArena, 2),
  shootBlocked: run(shootBlocked, 2),
  leap: run(leapArena, 2),
  leapAway: run(leapArena, 2, [press("move_left", 30, 60)]),
  leapShort: run(leapShort, 2),
  slam: run(slamArena, 2),
  slamShort: run(slamShort, 2),
  summon: run(summonWorld(summonArena), 4, [press("attack", 30)]),
  teleport: run(teleportArena("behindPlayer", 100), 1.5, [press("attack", 10)]),
  teleportHome: run(teleportArena("home", 0), 1),
  teleportRandom: run(teleportArena("random", 200), 1),
  armor0: run(armorArena(0), 0.5, [press("attack", 5)]),
  armor1: run(armorArena(1), 0.5, [press("attack", 5)]),
  bars: run(barArena, 1, [press("attack", 20)]),
  barsRoom: { project: barWorld, world: { room: "entrance", x: 900, y: 384, abilities: [] }, frames: 40, samples: range(0, 40), input: [press("move_right", 1, 40)] },
  hitStop: run(fxArena([{ type: "hitStop", frames: 30 }]), 1.5, [press("attack", 10)]),
  slowMotion: run(fxArena([{ type: "slowMotion", scale: 0.5, seconds: 1 }]), 2, [press("attack", 10)]),
  noEffect: run(fxArena([]), 2, [press("attack", 10)]),
} satisfies Record<string, Scenario>;

// Showcases: standing still, then the fight.
const wardenArena = showcaseArena([{ character: warden, at: [420, FLOOR], healthBar: "Iron Warden" }], [], [120, FLOOR]);
const wispArena = showcaseArena([{ character: wisp, at: [700, 480], healthBar: "Hex Wisp" }], [], [1000, FLOOR]);
const toadArena = showcaseArena([{ character: toad, at: [1400, FLOOR], healthBar: "Quake Toad" }], [mite], [1000, FLOOR]);

let r: Record<keyof typeof scenarios, Sample[]>;
let still: { warden: Sample[]; wisp: Sample[]; toad: Sample[] };
let dodged: { strike: Sample[]; slam: Sample[]; warden: Sample[]; wisp: Sample[]; toad: Sample[] };
let dodges: { strike: number; slam: number; warden: number; wisp: number; toad: number };
let fights: { warden: Sample[]; wisp: Sample[]; toad: Sample[] };

/** Frame of a sample where `id` has been in `state` for `t` frames, from `from` on. */
const enteredAt = (samples: Sample[], id: string, state: string, from = 0) => {
  const states = track(samples, id).map((e) => e.behaviorState);
  return states.findIndex((x, i) => i >= from && x === state && states[i - 1] !== state);
};

beforeAll(() => {
  const names = Object.keys(scenarios) as (keyof typeof scenarios)[];
  const showcase = [run(wardenArena, 4), run(wispArena, 4), run(toadArena, 5)];
  const results = simulate([...Object.values(scenarios), ...showcase]);
  r = Object.fromEntries(names.map((k, i) => [k, results[i]!])) as typeof r;
  const [w, x, t] = results.slice(names.length);
  still = { warden: w!, wisp: x!, toad: t! };

  // Dodges, timed from what the standing player saw: each starts after the warning began.
  dodges = {
    strike: hurtAt(r.strike) - 6,
    slam: hurtAt(r.slam) - 8,
    warden: hurtAt(still.warden) - 8,
    wisp: enteredAt(still.wisp, "hex_wisp_1", "volley") + s(0.6),
    toad: hurtAt(still.toad) - 8,
  };
  const away = (from: number): Scenario["input"] => [{ action: "move_right", from, to: from + 25 }]; // away from the wisp (x 700)
  const [ds, dsl, dw, dx, dt] = simulate([
    run(strikeArena, 1.5, [press("jump", dodges.strike, dodges.strike + 14)]),
    run(slamArena, 2, [press("jump", dodges.slam, dodges.slam + 14)]),
    run(wardenArena, 4, [press("jump", dodges.warden, dodges.warden + 14)]),
    run(wispArena, 4, away(dodges.wisp)),
    run(toadArena, 5, [press("jump", dodges.toad, dodges.toad + 14)]),
  ]);
  dodged = { strike: ds!, slam: dsl!, warden: dw!, wisp: dx!, toad: dt! };
  const [fw, fx, ft] = simulate([run(wardenArena, 40, FIGHTS.warden), run(wispArena, 40, FIGHTS.wisp), run(toadArena, 45, FIGHTS.toad)]);
  fights = { warden: fw!, wisp: fx!, toad: ft! };
}, 240_000);

describe("contract", () => {
  it("the runtime implements exactly the core actions, with the same params; it loads every new one", () => {
    const registry = readFileSync(join(GAME_DIR, "primitives/registry.gd"), "utf8");
    const actions = registry.slice(registry.indexOf("ACTIONS"), registry.indexOf("CONDITIONS"));
    const files = Object.fromEntries([...actions.matchAll(/"(\w+)": preload\("res:\/\/primitives\/actions\/(\w+)\.gd"\)/g)].map((m) => [m[1]!, m[2]!]));
    // PENDING (weapons target, W1): the runtime's useWeapon action. W1 adds it to the registry and deletes this filter.
    const PENDING = ["useWeapon"];
    expect(Object.keys(files)).toEqual(ACTION_TYPES.filter((t) => !PENDING.includes(t)));
    for (const [type, file] of Object.entries(files)) {
      const source = readFileSync(join(GAME_DIR, `primitives/actions/${file}.gd`), "utf8");
      const params = source.slice(source.indexOf("const PARAMS"), source.indexOf("}", source.indexOf("const PARAMS")));
      expect([...params.matchAll(/"(\w+)":/g)].map((m) => m[1]).sort(), type).toEqual(primitiveParams("action", type).map((p) => p.name).sort());
    }
    expect(readdirSync(join(GAME_DIR, "primitives/actions")).filter((f) => f.endsWith(".gd"))).toHaveLength(ACTION_TYPES.length - PENDING.length);
    // Every scenario above (all six attacks, armor, summons) loaded: simulate throws on a runtime error.
    expect(r.summon.length).toBeGreaterThan(0);
  });
});

describe("attacks warn first", () => {
  it("every attack's windup is at least MIN_WARNING and nothing hurts before it ends", () => {
    expect(MIN_WARNING).toBe(0.25);
    for (const [samples, windup] of [[r.strike, 0.4], [r.shoot, 0.3], [r.slam, 0.4], [r.leap, 0.4]] as const) {
      expect(hurtAt(samples)).toBeGreaterThanOrEqual(s(windup));
    }
  });
});

describe("strike", () => {
  it("hurts a player standing in its hitbox once the windup ends, and a jump after the warning clears it", () => {
    expect(hurtAt(r.strike)).toBeGreaterThanOrEqual(s(0.4));
    expect(hurtAt(r.strike)).toBeLessThanOrEqual(s(0.4) + 4);
    expect(entity(r.strike.at(-1), "brute_1").behaviorState).toBe("rest"); // done after the recovery
    expect(dodges.strike).toBeGreaterThan(0);
    expect(hp(dodged.strike)).toEqual(hp(dodged.strike).map(() => 5));
  });
});

describe("shoot", () => {
  it("a shot aimed at the player hits them; a solid in the way breaks it", () => {
    const hit = hurtAt(r.shoot);
    // 0.3 s windup, then ~420 px at 400 px/s.
    expect(hit).toBeGreaterThan(s(0.3) + s(0.9));
    expect(hit).toBeLessThan(s(0.3) + s(1.3));
    expect(hurtAt(r.shootBlocked)).toBe(-1);
  });
});

describe("leap", () => {
  it("lands where the player stood (within maxDistance); moving away after take-off dodges it", () => {
    const hopper = track(r.leap, "hopper_1");
    expect(hopper.at(-1)!.behaviorState).toBe("rest");
    expect(Math.abs(hopper.at(-1)!.x - 1300)).toBeLessThan(30);
    expect(hurtAt(r.leap)).toBeGreaterThan(s(0.4));
    expect(hurtAt(r.leapAway)).toBe(-1);
    expect(track(r.leapShort, "hopper_1").at(-1)!.x).toBeCloseTo(1200, -1);
  });
});

describe("slam", () => {
  it("sends a shockwave along the floor that hurts a player standing in its reach; a jump clears it; it stops at its reach", () => {
    expect(hurtAt(r.slam)).toBeGreaterThan(s(0.4));
    expect(dodges.slam).toBeGreaterThan(s(0.4));
    expect(hp(dodged.slam)).toEqual(hp(dodged.slam).map(() => 5));
    expect(hurtAt(r.slamShort)).toBe(-1);
    const pounder = track(r.slamShort, "pounder_1");
    expect(Math.min(...pounder.map((e) => e.y))).toBeLessThan(FLOOR - 50); // hopped first
  });
});

describe("summon", () => {
  it("calls enemies beside itself, never more than max alive; they can be struck and their deaths are events", () => {
    const summoned = (x: Sample) => x.entities.filter((e) => e.spawnId.startsWith("caller_1/") && e.health > 0);
    const alive = r.summon.map((x) => summoned(x).length);
    expect(Math.max(...alive)).toBe(3);
    expect(alive[s(0.3) - 1]).toBe(0);
    expect(alive[s(0.3) + 2]).toBe(2);
    expect(entity(r.summon.at(-1), "caller_1/0").health).toBe(0); // struck at frame 30
    expect(r.summon.at(-1)!.flags).toEqual(["mite_down"]);
    expect(summoned(r.summon.at(-1)!).every((e) => e.y === FLOOR)).toBe(true);
  });
});

describe("teleport", () => {
  it("vanishes (untouchable) and reappears past the player, at home, or near home", () => {
    const blinker = track(r.teleport, "blinker_1");
    expect(blinker.every((e) => e.health === 3)).toBe(true); // the swing at frame 10 met nothing
    expect(blinker[s(0.5) - 2]!.x).toBe(230);
    expect(blinker.at(-1)!.x).toBe(60); // 100 px past the player (x 160), on the far side
    expect(track(r.teleportHome, "blinker_1").at(-1)!.x).toBe(230);
    const random = track(r.teleportRandom, "blinker_1").at(-1)!.x;
    expect(Math.abs(random - 230)).toBeLessThanOrEqual(200);
    expect(random).not.toBe(230);
  });
});

describe("armor", () => {
  it("resists the push of a sword hit (1 = never budges), not the damage", () => {
    const pushed = (samples: Sample[]) => track(samples, "dummy_1").at(-1)!.x - 220;
    expect(pushed(r.armor0)).toBeGreaterThan(15);
    expect(pushed(r.armor1)).toBe(0);
    expect(track(r.armor1, "dummy_1").at(-1)!.health).toBe(2);
  });
});

describe("health bars", () => {
  it("show for each living spawn with one in the current room, top first; gone on death and on leaving the room", () => {
    expect(r.bars[5]!.healthBars).toEqual(["first_1", "second_3"]);
    expect(r.bars.at(-1)!.healthBars).toEqual(["second_3"]);
    expect(r.barsRoom[2]!.healthBars).toEqual(["guard"]);
    const left = r.barsRoom.findIndex((x) => x.room === "hall");
    expect(left).toBeGreaterThan(0);
    expect(r.barsRoom[left]!.healthBars).toEqual([]);
    expect(still.warden[0]!.healthBars).toEqual(["iron_warden_1"]);
  });
});

describe("feedback effects from a spawn's enemyKilled handler", () => {
  const walkerX = (samples: Sample[]) => track(samples, "walker_1").map((e) => e.x);
  const killedAt = (samples: Sample[]) => track(samples, "target_1").findIndex((e) => e.health === 0);

  it("hitStop freezes the room for its frames", () => {
    const k = killedAt(r.hitStop);
    expect(r.hitStop.at(-1)!.flags).toEqual(["felled"]);
    const x = walkerX(r.hitStop);
    expect(x[k]).toBe(x[k + 28]); // 30 frames from the kill
    expect(x[k - 2]).not.toBe(x[k]);
    expect(x[k + 40]).not.toBe(x[k + 30]);
  });

  it("slowMotion runs the room at `scale` for `seconds`, one whole fixed step at a time", () => {
    const k = killedAt(r.slowMotion);
    const moved = (samples: Sample[]) => Math.abs(walkerX(samples)[k + 61]! - walkerX(samples)[k + 1]!);
    expect(moved(r.noEffect)).toBeCloseTo(120, -1);
    expect(moved(r.slowMotion)).toBeCloseTo(60, -1);
    expect(r.slowMotion.at(-1)!.flags).toEqual(["felled"]);
  });

  it("shake moves the play camera and flash covers the screen, both fading; stop ends them; pogo shots are sword targets", () => {
    const project = withSpawnHandlers(arena([{ id: "target", at: [600, FLOOR], stats: { health: 1, knockback: 0, contactDamage: 0 }, initial: "idle", states: { idle: rest } }]), "target_1", [
      { on: { type: "enemyKilled" }, do: [{ type: "shake", strength: 10, seconds: 0.5 }, { type: "flash", color: "#ff0000", seconds: 0.4 }, { type: "setFlag", flag: "felled" }] },
    ]);
    const out = probe(project);
    expect(out.error).toBe("");
    const frames = out.frames as { fx: { shake: number; flash: number; flashColor: string }; cameraOffset: number; flashAlpha: number; flags: string[] }[];
    expect(frames[3]!.flags).toEqual(["felled"]);
    expect(frames[3]!.cameraOffset).toBeGreaterThan(0);
    expect(frames[3]!.flashAlpha).toBeGreaterThan(0.7);
    expect(frames[3]!.fx.flashColor).toBe("ff0000");
    expect(frames[15]!.flashAlpha).toBeLessThan(frames[3]!.flashAlpha);
    expect(frames.at(-1)).toMatchObject({ cameraOffset: 0, flashAlpha: 0 });
    expect(out.afterStop).toEqual({ fx: { shake: 0, flash: 0, slowFrames: 0, flashColor: "ff0000" }, flashVisible: false });
    expect(out.flashAboveHud).toBe(true);
    expect(out.targets).toMatchObject({ pogoListed: true, plainListed: false, side: false, plainDown: false, down: true });
    expect(out.targets.count - out.targets.afterFree).toBe(1);
  });
});

/** Run game/test/combat_probe.gd on `project`. */
function probe(project: ProjectSpec): Record<string, any> {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-probe-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ project: toRuntimeProject(project) }));
    execFileSync(process.env.GODOT ?? "godot", ["--headless", "--fixed-fps", String(FPS), "--path", GAME_DIR, "--script", "res://test/combat_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")], {
      stdio: "pipe",
      timeout: 60_000,
    });
    return JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- showcases ---------------------------------------------------------------------------

/**
 * Scripted fights, each found once by playing the enemy's tells (jump its strikes and waves, run from
 * its shots and landings, hit it in its openings). Tokens: j<frame> jump (14 frames), a<frame> attack,
 * r<from>-<to> / l<from>-<to> hold right / left.
 */
const script = (tokens: string): Scenario["input"] =>
  tokens.split(" ").map((t) => {
    const [from, to] = t.slice(1).split("-").map(Number) as [number, number?];
    const action = ({ j: "jump", a: "attack", r: "move_right", l: "move_left" } as const)[t[0] as "j" | "a" | "r" | "l"];
    return { action, from, to: to ?? from + (action === "jump" ? 14 : 2) };
  });
const FIGHTS = {
  warden: script(
    "j137 r182-187 a187 r193-195 r195-199 a209 j242 a287 r295-298 a309 j347 a392 r399-401 r401-403 a414 j452 a497 r504-506 r506-508 a519 j557 a602 r609-611 r611-613 a624 j662 a707 r714-716 r716-718 a729 a751 r759-762 a773 j818 j874 a919 a941 j974 j1031 a1076 a1098 j1131 j1188 a1233",
  ),
  wisp: script(
    "r73-98 l111-112 a112 l120-122 l122-125 a134 l160-165 l165-170 a170 l176-178 l178-183 l183-185 a192 r305-330 l343-344 a344 l352-354 l354-357 a366 a388 l394-396 l396-401 l401-404 a410 a432 r537-562 l575-576 a576",
  ),
  toad: script(
    "l93-118 j222 r267-271 r271-275 r275-279 r279-283 r283-287 r287-291 r291-295 r295-299 r299-303 r303-307 r307-311 l311-319 l324-332 l332-340 l358-366 l372-380 l385-393 l398-406 j461 r506-510 r510-514 r514-518 r518-522 r522-526 r526-530 a530 r544-548 r548-551 a552 l560-568 l568-576 r632-636 r636-640 l637-662 l686-694 j752 r797-801 r801-805 r805-807 a807 r809-813 r813-817 r817-821 r821-825 a829 a851 l852-860 l860-868 l895-920 l948-956 j1011 r1034-1038 r1038-1042 r1042-1046 r1046-1050 a1050 r1056-1059 r1059-1063 a1072 a1094 r1100-1102 r1102-1106 l1110-1118 l1118-1126 l1153-1178 j1256 r1279-1283 r1283-1287 r1287-1291 r1291-1295 a1295 a1317 a1339 l1355-1363 l1363-1371 l1392-1417 l1445-1453 j1508 r1553-1557 r1557-1561 r1561-1565 r1565-1569 a1569 a1591 l1607-1615 l1615-1623 l1644-1669 r1697-1705 l1705-1713 r1713-1721 l1721-1729 r1729-1737 l1737-1745 r1745-1753 l1753-1761 j1759 r1804-1807 a1807 r1813-1816 r1816-1820 a1829 a1851",
  ),
};

describe("showcase: Iron Warden (heavy melee; quakes and lunges below half health)", () => {
  it("its cleave hits a player standing still; a jump after the warning avoids it", () => {
    const h = hurtAt(still.warden);
    const cleave = enteredAt(still.warden, "iron_warden_1", "cleave");
    expect(h - cleave).toBeGreaterThanOrEqual(s(0.55));
    expect(entity(still.warden[h], "iron_warden_1").behaviorState).toBe("cleave");
    expect(dodges.warden).toBeGreaterThan(cleave);
    expect(hp(dodged.warden).slice(0, h + 20)).toEqual(Array(h + 20).fill(5));
  });

  it("a scripted fight kills it within 30 s", () => {
    expect(killTime(fights.warden, "iron_warden_1")).toBeLessThan(30);
  });
});

describe("showcase: Hex Wisp (flyer: volleys of aimed shots, then blinks behind the player)", () => {
  it("its volley hits a player standing still; running aside once it fires avoids it", () => {
    const h = hurtAt(still.wisp);
    expect(h).toBeGreaterThan(dodges.wisp);
    const wisp = entity(still.wisp[h], "hex_wisp_1");
    expect(Math.abs(wisp.x - entity(still.wisp[h], "player").x)).toBeGreaterThan(40); // a shot, not its touch
    expect(hp(dodged.wisp).slice(0, h + 15)).toEqual(Array(h + 15).fill(5));
  });

  it("a scripted fight kills it within 30 s", () => {
    expect(killTime(fights.wisp, "hex_wisp_1")).toBeLessThan(30);
  });
});

describe("showcase: Quake Toad (summons mites, leaps at the player, slams)", () => {
  it("its slam's shockwave hits a player standing still; a jump as it arrives avoids it", () => {
    const h = hurtAt(still.toad);
    const toadAt = entity(still.toad[h], "quake_toad_1");
    expect(Math.abs(toadAt.x - entity(still.toad[h], "player").x)).toBeGreaterThan(80); // the wave, not its touch
    expect(dodges.toad).toBeGreaterThan(enteredAt(still.toad, "quake_toad_1", "stomp") + s(0.4));
    expect(hp(dodged.toad).slice(0, h + 30)).toEqual(Array(h + 30).fill(5));
    expect(Math.max(...still.toad.map((x) => x.entities.filter((e) => e.spawnId.startsWith("quake_toad_1/")).length))).toBe(2);
  });

  it("a scripted fight kills it within 40 s", () => {
    expect(killTime(fights.toad, "quake_toad_1")).toBeLessThan(40);
  });
});

/** Seconds until `id` dies (the player never dying), or Infinity. */
function killTime(samples: Sample[], id: string): number {
  const k = track(samples, id).findIndex((e) => e.health === 0);
  expect(samples.slice(0, k + 1).every((x) => x.deaths === 0)).toBe(true);
  return k < 0 ? Infinity : k / FPS;
}
