import { ARENA_FLOOR, createDefaultProject, ProjectSpec } from "@anomaly/core";

/**
 * Three heavy enemies built from data only: the combat primitives composed
 * into strong fights (game/test/combat_primitives.test.ts plays them).
 * Nothing in the runtime knows these are special.
 */

type Enemy = Record<string, unknown> & { id: string };
const go = (to: string, when: object, ...and: object[]) => ({ when, ...(and.length ? { and } : {}), to });
const after = (seconds: number) => ({ type: "after", seconds });
const done = { type: "actionDone" };
const level = { type: "playerLevel", margin: 60 };

/** Heavy melee: cleaves at close range; below half health it roars, then lunges and sends quakes along the floor. */
export const warden: Enemy = {
  id: "iron_warden",
  kind: "enemy",
  name: "Iron Warden",
  color: "#7d8a99",
  size: { width: 48, height: 64 },
  stats: { knockback: 420, health: 10, contactDamage: 1, armor: 0.8 },
  behavior: {
    initial: "stalk",
    states: {
      stalk: {
        action: { type: "chase", speed: 110, stopDistance: 70 },
        transitions: [go("roar", { type: "healthBelow", fraction: 0.5 }), go("cleave", { type: "playerWithin", distance: 100 }, level)],
      },
      cleave: {
        action: { type: "strike", windup: 0.55, active: 0.2, recovery: 0.9, width: 80, height: 56, offsetX: 52, color: "#ffb347" },
        transitions: [go("stalk", done)],
      },
      roar: { action: { type: "telegraph", color: "#ff5a3d", shake: true }, transitions: [go("quake", after(0.8))] },
      quake: {
        action: { type: "slam", windup: 0.45, height: 0, waveSpeed: 480, waveReach: 700, waveHeight: 30, color: "#ff5a3d" },
        transitions: [go("rest", done)],
      },
      rest: { action: { type: "wait" }, transitions: [go("lunge", after(0.6), { type: "playerWithin", distance: 110 }, level), go("rush", after(0.6))] },
      rush: {
        action: { type: "chase", speed: 180, stopDistance: 80 },
        transitions: [go("lunge", { type: "playerWithin", distance: 110 }, level), go("quake", after(1.5))],
      },
      lunge: {
        action: { type: "strike", windup: 0.4, active: 0.25, recovery: 0.8, width: 80, height: 56, offsetX: 52, lunge: 100, color: "#ff5a3d" },
        transitions: [go("quake", done)],
      },
    },
    interrupts: [],
  },
};

/** Ranged flyer: fans of aimed shots from above, then blinks behind the player and hangs there, open to the sword. */
export const wisp: Enemy = {
  id: "hex_wisp",
  kind: "enemy",
  name: "Hex Wisp",
  color: "#9b6cd6",
  movement: "flying",
  size: { width: 36, height: 36 },
  stats: { knockback: 300, health: 5, contactDamage: 1 },
  behavior: {
    initial: "drift",
    states: {
      drift: { action: { type: "hover", amplitude: 10, period: 1.6 }, transitions: [go("volley", after(0.6))] },
      volley: {
        action: { type: "shoot", windup: 0.6, count: 3, spread: 24, speed: 380, aim: "player", lifetime: 3, color: "#d68cff" },
        transitions: [go("blink", done)],
      },
      blink: { action: { type: "teleport", to: "behindPlayer", range: 90, windup: 0.6, color: "#d68cff" }, transitions: [go("exposed", done)] },
      exposed: { action: { type: "hover", amplitude: 4, period: 1 }, transitions: [go("home", after(1.4))] },
      home: { action: { type: "teleport", to: "home", range: 0, windup: 0.5, color: "#d68cff" }, transitions: [go("drift", done)] },
    },
    interrupts: [],
  },
};

/** Leaping slammer: calls mites, leaps at the player and slams, sending shockwaves both ways. */
export const toad: Enemy = {
  id: "quake_toad",
  kind: "enemy",
  name: "Quake Toad",
  color: "#6b8e4e",
  size: { width: 56, height: 44 },
  stats: { knockback: 380, health: 6, contactDamage: 1, armor: 0.5 },
  behavior: {
    initial: "watch",
    states: {
      watch: { action: { type: "wait" }, transitions: [go("call", after(0.5))] },
      call: { action: { type: "summon", character: "mite", count: 2, max: 2, windup: 0.6, color: "#c6e07a" }, transitions: [go("hop", done)] },
      hop: { action: { type: "leap", windup: 0.4, height: 170, maxDistance: 260, color: "#c6e07a" }, transitions: [go("stomp", done)] },
      stomp: {
        action: { type: "slam", windup: 0.4, height: 90, waveSpeed: 460, waveReach: 520, waveHeight: 28, color: "#c6e07a" },
        transitions: [go("rest", done)],
      },
      rest: { action: { type: "wait" }, transitions: [go("call", after(2), { type: "chance", p: 0.35 }), go("hop", after(2))] },
    },
    interrupts: [],
  },
};

/** The toad's summons. */
export const mite: Enemy = {
  id: "mite",
  kind: "enemy",
  name: "Mite",
  color: "#b9c46a",
  size: { width: 20, height: 16 },
  stats: { knockback: 260, health: 1, contactDamage: 1 },
  behavior: { initial: "crawl", states: { crawl: { action: { type: "chase", speed: 50 }, transitions: [] } }, interrupts: [] },
};

/** The starter arena (floor top y=672, walls at x 32 and 1568) with `enemies` spawned and the player at `player`. */
export function showcaseArena(enemies: { character: Enemy; at: [number, number]; healthBar?: string }[], extra: Enemy[] = [], player: [number, number] = [160, ARENA_FLOOR]): ProjectSpec {
  const base = createDefaultProject();
  const room = base.world.rooms[0]!;
  const spawns = enemies.map((e, i) => ({ id: `${e.character.id}_${i + 1}`, characterId: e.character.id, x: e.at[0], y: e.at[1], healthBar: e.healthBar ? { title: e.healthBar } : null }));
  return ProjectSpec.parse({
    ...base,
    characters: [base.characters[0], ...enemies.map((e) => e.character), ...extra],
    world: { ...base.world, rooms: [{ ...room, spawns }], playtest: { room: room.id, x: player[0], y: player[1], abilities: [] } },
  });
}
