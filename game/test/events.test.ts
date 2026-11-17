import { beforeAll, describe, expect, it } from "vitest";
import { ARENA_FLOOR, ProjectSpec } from "@anomaly/core";
import { arena, at, entity, FPS, range, simulate, type Input, type Sample, type Scenario } from "./simulate.ts";

// The game-logic engine (game/scripts/events.gd) in the real runtime: events
// fired by the run, conditions over its flags and items, the run's own
// effects, and the game rules running as preset handlers.

const s = (seconds: number) => Math.round(seconds * FPS);
const press = (action: Input, from: number, to = from + 2) => ({ action, from, to });
const idle = { initial: "idle", states: { idle: { action: { type: "wait" } } } };

/** `project` with world fields (handlers, items, rules, ...) and arena-room fields merged in. */
function logic(project: ProjectSpec, world: Record<string, unknown>, room: Record<string, unknown> = {}, spawnHandlers: Record<string, unknown[]> = {}): ProjectSpec {
  const [arenaRoom] = project.world.rooms;
  return ProjectSpec.parse({
    ...project,
    id: "events_test",
    world: {
      ...project.world,
      items: [{ id: "key", name: "Key" }, { id: "coin", name: "Coin" }],
      ...world,
      rooms: [
        {
          ...arenaRoom,
          ...room,
          spawns: arenaRoom!.spawns.map((sp) => ({ ...sp, handlers: spawnHandlers[sp.id] ?? [], when: sp.id === "dummy_1" ? { type: "flag", flag: "dummy_beaten", is: false } : null })),
        },
      ],
    },
  });
}

const scenarios = {
  // Events from the run; conditions read flags, items and visited rooms.
  basics: {
    project: logic(arena([]), {
      handlers: [
        { on: { type: "gameStarted" }, do: [{ type: "giveItem", item: "coin", count: 3 }] },
        { on: { type: "roomEntered", room: "arena" }, when: [{ type: "item", item: "coin", atLeast: 3 }], do: [{ type: "setFlag", flag: "rich" }] },
        { on: { type: "roomEntered" }, when: [{ type: "item", item: "key" }], do: [{ type: "setFlag", flag: "never" }] },
        { on: { type: "roomSettled" }, when: [{ type: "all", of: [{ type: "flag", flag: "rich" }, { type: "visited", room: "arena" }] }], do: [{ type: "takeItem", item: "coin" }, { type: "setFlag", flag: "rich", value: false }, { type: "setFlag", flag: "settled" }] },
        // Effects other systems own still run in order with the rest (stubs today).
        { on: { type: "roomSettled" }, do: [{ type: "shake" }, { type: "setFlag", flag: "after_shake" }] },
      ],
    }),
    frames: s(1),
    samples: [0, s(1)],
  },
  // A spawn's handler hears its own death; the room's hears it cleared.
  kills: {
    project: logic(
      arena([{ id: "dummy", at: [230, ARENA_FLOOR], stats: { health: 1 }, ...idle }]),
      {},
      { handlers: [{ on: { type: "roomCleared" }, do: [{ type: "setFlag", flag: "cleared" }] }] },
      { dummy_1: [{ on: { type: "enemyKilled" }, do: [{ type: "giveItem", item: "key" }] }] },
    ),
    frames: s(1.5),
    samples: [s(0.5), s(1.5)],
    input: [press("attack", s(0.6))],
  },
  // Timers fire after their time; a checkpoint is where checkpoint respawns go.
  checkpoint: {
    project: logic(arena([]), {
      rules: { onDeath: "checkpoint", save: "never", hazardDamage: 1 },
      handlers: [
        { on: { type: "gameStarted" }, do: [{ type: "setCheckpoint", room: "arena", x: 700, y: ARENA_FLOOR }, { type: "startTimer", timer: "doom", seconds: 1 }] },
        { on: { type: "timer", timer: "doom" }, do: [{ type: "damage", amount: 99 }] },
      ],
    }),
    frames: s(2),
    samples: [s(0.9), s(2)],
  },
  // A spawn with a condition stays gone once it fails (a beaten enemy, after respawning the room).
  staysBeaten: {
    project: logic(
      arena([{ id: "dummy", at: [230, ARENA_FLOOR], stats: { health: 1 }, ...idle }]),
      { handlers: [{ on: { type: "timer", timer: "again" }, do: [{ type: "respawn", at: "entry" }] }] },
      {},
      { dummy_1: [{ on: { type: "enemyKilled" }, do: [{ type: "setFlag", flag: "dummy_beaten" }, { type: "startTimer", timer: "again", seconds: 0.2 }] }] },
    ),
    frames: s(1.5),
    samples: [s(0.5), s(1.5)],
    input: [press("attack", s(0.6))],
  },
  // Abilities granted mid-run work at once.
  grant: {
    project: logic(arena([]), { handlers: [{ on: { type: "roomSettled" }, do: [{ type: "grantAbility", ability: "double_jump" }] }] }),
    frames: s(1.5),
    samples: range(0, s(1.5)),
    input: [press("jump", s(0.3), s(0.5)), press("jump", s(0.6), s(0.8))],
  },
  // A saved run brings back flags, items and the checkpoint (headless saves live in memory).
  save: {
    project: logic(arena([]), {
      handlers: [{ on: { type: "gameStarted" }, when: [{ type: "flag", flag: "loaded", is: false }], do: [{ type: "setFlag", flag: "loaded" }, { type: "giveItem", item: "key", count: 2 }, { type: "setCheckpoint" }] }],
    }),
    frames: s(0.5),
    samples: [s(0.5)],
  },
} satisfies Record<string, Scenario>;

const resumed: Scenario = { ...scenarios.save, world: { room: "arena", x: 400, y: ARENA_FLOOR, abilities: [], continue: true }, samples: [s(0.5)] };

let results: Record<keyof typeof scenarios | "resumed", Sample[]>;

beforeAll(() => {
  const names = Object.keys(scenarios) as (keyof typeof scenarios)[];
  const runs = simulate([...names.map((n) => scenarios[n]), resumed]);
  results = Object.fromEntries([...names, "resumed"].map((n, i) => [n, runs[i]!])) as typeof results;
}, 120_000);

describe("the game-logic engine", () => {
  it("fires the run's events and checks flags, items and visited rooms", () => {
    const [start, later] = results.basics;
    expect(start!.items).toEqual({ coin: 3 });
    expect(start!.flags).toEqual(["rich"]);
    expect(later!.items).toEqual({ coin: 2 });
    expect(later!.flags.sort()).toEqual(["after_shake", "settled"]);
  });

  it("tells a spawn's handlers about its death and the room's about it being cleared", () => {
    const [before, after] = results.kills;
    expect(before!.flags).toEqual([]);
    expect(entity(after, "dummy_1").health).toBe(0);
    expect(after!.items).toEqual({ key: 1 });
    expect(after!.flags).toEqual(["cleared"]);
  });

  it("leaves out spawns whose condition fails when a room is built", () => {
    const [before, after] = results.staysBeaten;
    expect(before!.entities.map((e) => e.spawnId)).toContain("dummy_1");
    expect(after!.flags).toEqual(["dummy_beaten"]);
    expect(after!.entities.map((e) => e.spawnId)).toEqual(["player"]); // the room was rebuilt without it
  });

  it("runs timers, and the onDeath rule respawns at the checkpoint", () => {
    const [before, after] = results.checkpoint;
    expect(before!.checkpoint).toEqual({ room: "arena", x: 700, y: ARENA_FLOOR });
    expect(before!.deaths).toBe(0);
    expect(after!.deaths).toBe(1);
    expect(entity(after, "player")).toMatchObject({ x: 700, y: ARENA_FLOOR, health: 5 });
  });

  it("grants abilities mid-run", () => {
    const samples = results.grant;
    expect(at(samples, s(0.2))!.abilities).toEqual(["double_jump"]);
    // The second press, in the air, jumps again: the player rises after starting to fall.
    const ys = samples.map((x) => entity(x, "player").y);
    const firstPeak = Math.min(...ys.slice(s(0.3), s(0.6)));
    const secondPeak = Math.min(...ys.slice(s(0.6), s(1.2)));
    expect(secondPeak).toBeLessThan(firstPeak - 40);
  });

  it("saves flags, items and the checkpoint, and a continued run gets them back", () => {
    const [saved] = results.save;
    expect(saved!.items).toEqual({ key: 2 });
    const [back] = results.resumed;
    expect(back!.flags).toEqual(["loaded"]);
    expect(back!.items).toEqual({ key: 2 }); // not given twice: the flag was restored first
    expect(back!.checkpoint).toEqual(saved!.checkpoint);
  });
});
