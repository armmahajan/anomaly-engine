import { beforeAll, describe, expect, it } from "vitest";
import { applyBatch, ARENA_FLOOR, createDefaultProject, gridToSolids, ProjectSpec, type GridSolid, type OperationCall } from "@anomaly/core";
import { arena, at, entity, FPS, range, simulate, type Input, type Sample, type Scenario } from "./simulate.ts";

// Props and items in the real runtime (game/scripts/props.gd). Everything a
// prop "is" (a pickup, a barrier, a switch, a save spot, a breakable wall)
// is data here: a rectangle, its solid / visible conditions and handlers.

const s = (seconds: number) => Math.round(seconds * FPS);
const hold = (action: Input, from: number, to = from + 2) => ({ action, from, to });
const player = (sample: Sample | undefined) => entity(sample, "player");
const prop = (sample: Sample | undefined, id: string) => {
  const found = sample?.props.find((p) => p.id === id);
  if (!found) throw new Error(`no prop ${id} at frame ${sample?.frame}`);
  return found as Sample["props"][number] & { prompt?: string };
};
const first = (samples: Sample[], test: (s: Sample) => boolean) => samples.find(test);

function build(base: ProjectSpec, calls: OperationCall[]): ProjectSpec {
  const result = applyBatch(base, calls);
  if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues)}`);
  return result.project;
}

/** The arena (no enemies) playtesting from `from`, with these props and world handlers. */
function arenaWith(props: unknown[], handlers: unknown[] = [], from: [number, number] = [160, ARENA_FLOOR], enemies: Parameters<typeof arena>[0] = []): ProjectSpec {
  const base = arena(enemies, from);
  return build(base, [
    { name: "createItem", input: { name: "Coin" } },
    { name: "setHandlers", input: { handlers } },
    ...props.map((p) => ({ name: "addProp", input: { roomId: "arena", ...(p as object) } })),
  ]);
}

// --- 1. solid props collide like tile solids ------------------------------------------------

/** A slab over the start (head bump), a block to walk into and stand on, on the arena floor. */
const SHAPES = [
  { x: 120, y: 560, width: 96, height: 16 },
  { x: 480, y: 608, width: 128, height: 64 },
];
const arenaSolids = gridToSolids(arena([]).world.rooms[0]!.grid, 20);
const asSolids: GridSolid[] = [...arenaSolids, ...SHAPES.map((r) => ({ kind: "solid" as const, ...r }))];
const COURSE: Scenario["input"] = [hold("jump", 5, 30), hold("move_right", 40, 120), hold("jump", 100, 130)];
const geometry = (project: ProjectSpec, solids: GridSolid[]): Scenario => ({ project, solids, frames: 220, samples: range(0, 220), input: COURSE });

const patroller = { id: "walker", at: [800, ARENA_FLOOR] as [number, number], initial: "go", states: { go: { action: { type: "patrol", speed: 200, distance: 2000, turnAtLedge: false, turnAtWall: false } } } };


// --- recipes: two 20x10 rooms, west -> east through doors at rows 6-8 (floor top y 288) -------

const FLOOR = 288;
const flag = (name: string, is = true) => ({ type: "flag", flag: name, is });
const TWO_ROOMS: OperationCall[] = [
  { name: "createItem", input: { name: "Gem" } },
  { name: "createItem", input: { name: "Key" } },
  { name: "createWorldRoom", input: { name: "West", cols: 20, rows: 10 } },
  { name: "createWorldRoom", input: { name: "East", cols: 20, rows: 10 } },
  { name: "setDoor", input: { roomId: "west", door: { id: "out", side: "right", offset: 6, size: 3 } } },
  { name: "setDoor", input: { roomId: "east", door: { id: "in", side: "left", offset: 6, size: 3 } } },
  { name: "connectDoors", input: { from: { roomId: "west", doorId: "out" }, to: { roomId: "east", doorId: "in" } } },
  { name: "setWorldStart", input: { roomId: "west", x: 100, y: FLOOR } },
];
const addProp = (roomId: string, input: object): OperationCall => ({ name: "addProp", input: { roomId, ...input } });

/** (a) A pickup gone for good; a pit that only opens once it is taken (to die on the way back). */
const PICKUP = [
  addProp("west", { id: "gem", x: 300, y: 256, width: 16, height: 32, visible: flag("got_gem", false), handlers: [{ on: { type: "touch" }, do: [{ type: "giveItem", item: "gem" }, { type: "setFlag", flag: "got_gem" }] }] }),
  addProp("west", { id: "pit", x: 200, y: 272, width: 32, height: 16, visible: flag("got_gem"), handlers: [{ on: { type: "touch" }, do: [{ type: "damage", amount: 99 }] }] }),
];
/** (b) A key, and a barrier that opens on interact while you hold it (and takes it). */
const LOCKED = [
  addProp("west", { id: "key", x: 200, y: 256, width: 16, height: 32, visible: flag("got_key", false), handlers: [{ on: { type: "touch" }, do: [{ type: "giveItem", item: "key" }, { type: "setFlag", flag: "got_key" }] }] }),
  addProp("west", {
    id: "barrier",
    x: 400,
    y: 192,
    width: 32,
    height: 96,
    solid: true,
    visible: flag("opened", false),
    prompt: "Unlock",
    handlers: [{ on: { type: "interact" }, when: [{ type: "item", item: "key" }], do: [{ type: "takeItem", item: "key" }, { type: "setFlag", flag: "opened" }] }],
  }),
];
/** (c) Striking a switch in the west room opens a barrier in the east room. */
const SWITCHED = [
  addProp("west", { id: "switch", x: 300, y: 240, width: 16, height: 48, handlers: [{ on: { type: "hit" }, do: [{ type: "setFlag", flag: "gate_open" }] }] }),
  addProp("east", { id: "barrier", x: 200, y: 192, width: 32, height: 96, solid: flag("gate_open", false), visible: flag("gate_open", false) }),
];
/** (d) A save spot: interact to set the checkpoint, heal and save; death comes back there. Hurt at the start, a pit further on. */
const SAVE_SPOT = [
  { name: "setGameRules", input: { onDeath: "checkpoint", save: "never" } },
  { name: "setHandlers", input: { handlers: [{ on: { type: "gameStarted" }, do: [{ type: "damage", amount: 2 }] }] } },
  addProp("east", { id: "shrine", x: 280, y: 224, width: 50, height: 64, prompt: "Rest", handlers: [{ on: { type: "interact" }, do: [{ type: "setCheckpoint" }, { type: "heal", amount: null }, { type: "saveRun" }] }] }),
  addProp("east", { id: "pit", x: 500, y: 272, width: 32, height: 16, handlers: [{ on: { type: "touch" }, do: [{ type: "damage", amount: 99 }] }] }),
];
/** (e) A wall that breaks after three hits and stays broken. */
const BREAKABLE = [
  addProp("west", { id: "wall", x: 300, y: 192, width: 32, height: 96, solid: true, health: 3, visible: flag("wall_broken", false), handlers: [{ on: { type: "destroyed" }, do: [{ type: "setFlag", flag: "wall_broken" }] }] }),
];
/** (f) An orb that grants double jump (and is gone once you have it). */
const POWER = [
  addProp("west", { id: "orb", x: 200, y: 240, width: 16, height: 48, visible: { type: "not", of: { type: "ability", ability: "double_jump" } }, handlers: [{ on: { type: "touch" }, do: [{ type: "grantAbility", ability: "double_jump" }] }] }),
];

function recipe(id: string, calls: OperationCall[], frames: number, input: Scenario["input"] = [], x = 100): Scenario {
  const project = build({ ...createDefaultProject(), id }, [...TWO_ROOMS, ...calls]);
  return { project, world: { room: "west", x, y: FLOOR, abilities: [] }, frames, samples: range(0, frames), input };
}

const scenarios = {
  tiles: geometry(arena([]), asSolids),
  props: geometry(arenaWith(SHAPES.map((r) => ({ ...r, solid: true }))), arenaSolids),
  enemyBlocked: { project: arenaWith([{ x: 1000, y: 560, width: 32, height: 112, solid: true }], [], [160, ARENA_FLOOR], [patroller]), frames: s(1.5), samples: [s(1.5)] },
  enemyFree: { project: arenaWith([{ x: 1000, y: 560, width: 32, height: 112 }], [], [160, ARENA_FLOOR], [patroller]), frames: s(1.5), samples: [s(1.5)] },

  // --- 2. events ---
  touch: {
    project: arenaWith([{ id: "pad", x: 300, y: 632, width: 40, height: 40, handlers: [{ on: { type: "touch" }, do: [{ type: "giveItem", item: "coin" }] }] }]),
    frames: 100,
    samples: range(0, 100),
    input: [hold("move_right", 1, 40), hold("move_left", 50, 80)],
  },
  interact: {
    project: arenaWith([
      { id: "sign", x: 130, y: 620, width: 60, height: 52, prompt: "Read", handlers: [{ on: { type: "interact" }, do: [{ type: "setFlag", flag: "read" }] }] },
      { id: "lamp", x: 130, y: 620, width: 60, height: 52, handlers: [{ on: { type: "interact" }, do: [{ type: "giveItem", item: "coin" }] }] },
      { id: "plain", x: 130, y: 620, width: 60, height: 52 },
      { id: "far", x: 600, y: 620, width: 60, height: 52, handlers: [{ on: { type: "interact" }, do: [{ type: "setFlag", flag: "far" }] }] },
    ]),
    frames: 30,
    samples: [10, 30],
    input: [hold("interact", 20)],
  },
  hit: {
    project: arenaWith([{ id: "target", x: 200, y: 600, width: 32, height: 72, handlers: [{ on: { type: "hit" }, do: [{ type: "giveItem", item: "coin" }] }] }]),
    frames: 30,
    samples: [5, 30],
    input: [hold("attack", 10)],
  },
  bounce: dropOnto(true),
  flat: dropOnto(false),
  health: {
    project: arenaWith([
      {
        id: "crack",
        x: 190,
        y: 560,
        width: 32,
        height: 112,
        solid: true,
        health: 3,
        handlers: [
          { on: { type: "hit" }, do: [{ type: "giveItem", item: "coin" }] },
          { on: { type: "destroyed" }, do: [{ type: "setFlag", flag: "broken" }] },
        ],
      },
    ]),
    frames: 150,
    samples: [60, 100, 150],
    input: [hold("attack", 10), hold("attack", 40), hold("attack", 70), hold("move_right", 110, 150)],
  },

  // --- 3. conditions follow the run ---
  follow: {
    project: arenaWith(
      [
        { id: "barrier", x: 400, y: 560, width: 32, height: 112, solid: { type: "flag", flag: "open", is: false } },
        { id: "sign", x: 500, y: 600, width: 32, height: 32, visible: { type: "flag", flag: "open" } },
        { id: "early", x: 600, y: 600, width: 32, height: 32, visible: { type: "flag", flag: "started" }, solid: true },
      ],
      [
        { on: { type: "gameStarted" }, do: [{ type: "setFlag", flag: "started" }, { type: "startTimer", timer: "t", seconds: 0.5 }] },
        { on: { type: "timer", timer: "t" }, do: [{ type: "setFlag", flag: "open" }] },
      ],
    ),
    frames: 45,
    samples: range(0, 45),
  },
  // A prop turning solid around the player waits until they step out of it.
  closing: {
    project: arenaWith(
      [{ id: "shutter", x: 140, y: 560, width: 40, height: 112, solid: { type: "flag", flag: "shut" } }],
      [{ on: { type: "roomSettled" }, do: [{ type: "setFlag", flag: "shut" }] }],
    ),
    frames: 110,
    samples: range(0, 110),
    input: [hold("move_right", 30, 50), hold("move_left", 70, 100)],
  },

  // --- 4. recipes (data only) ---
  pickup: recipe("pickup", PICKUP, 300, [hold("move_right", 1, 120), hold("move_left", 130, 240)]),
  pickupContinued: { ...recipe("pickup", PICKUP, 5), world: { room: "west", x: 100, y: FLOOR, abilities: [], continue: true } },
  locked: recipe("locked", LOCKED, 150, [hold("move_right", 1, 80), hold("interact", 90), hold("move_right", 100, 130)]),
  switched: recipe("switched", SWITCHED, 150, [hold("attack", 5), hold("move_right", 20, 150)], 260),
  unswitched: recipe("switched", SWITCHED, 150, [hold("move_right", 20, 150)], 260),
  saveSpot: recipe("save_spot", SAVE_SPOT, 260, [hold("move_right", 1, 152), hold("interact", 165), hold("move_right", 175, 215)]),
  saveSpotContinued: { ...recipe("save_spot", SAVE_SPOT, 5), world: { room: "west", x: 100, y: FLOOR, abilities: [], continue: true } },
  breakable: recipe("breakable", BREAKABLE, 290, [hold("attack", 5), hold("attack", 35), hold("attack", 65), hold("move_right", 80, 170), hold("move_left", 175, 270)], 270),
  power: recipe("power", POWER, 120, [hold("move_right", 1, 30), hold("jump", 40, 50), hold("jump", 58, 70)]),
} satisfies Record<string, Scenario>;

/** Falling from (160, 400) onto a solid pad, striking down just before landing. */
function dropOnto(bounce: boolean): Scenario {
  return {
    project: arenaWith([{ id: "pad", x: 120, y: 640, width: 80, height: 32, solid: true, bounce, handlers: [{ on: { type: "hit" }, do: [{ type: "giveItem", item: "coin" }] }] }], [], [160, 400]),
    frames: 70,
    samples: range(0, 70),
    input: [hold("aim_down", 20, 40), hold("attack", 24)],
  };
}

let results: Record<keyof typeof scenarios, Sample[]>;

beforeAll(() => {
  const names = Object.keys(scenarios) as (keyof typeof scenarios)[];
  const runs = simulate(names.map((n) => scenarios[n]));
  results = Object.fromEntries(names.map((n, i) => [n, runs[i]!])) as typeof results;
}, 180_000);

describe("solid props", () => {
  it("block the player exactly like the same rectangles as tile solids", () => {
    const track = (samples: Sample[]) => samples.map((x) => [x.frame, player(x).x, player(x).y]);
    expect(track(results.props)).toEqual(track(results.tiles));
    const ys = results.props.map((x) => player(x).y);
    const xs = results.props.map((x) => player(x).x);
    expect(Math.min(...ys.slice(0, 60))).toBe(576 + 44); // the head stops at the slab's underside
    expect(Math.max(...xs.slice(40, 100))).toBe(480 - 14); // the side of the block stops the run
    expect(ys.at(-1)).toBe(608); // standing on it
    expect(results.props[0]!.props.map((p) => p.solid)).toEqual([true, true]);
  });

  it("block enemies", () => {
    expect(entity(results.enemyBlocked[0], "walker_1").x).toBeLessThanOrEqual(1000 - 16);
    expect(entity(results.enemyFree[0], "walker_1").x).toBeGreaterThan(1040);
  });
});

describe("prop events", () => {
  it("touch fires once each time the player starts overlapping", () => {
    const samples = results.touch;
    const coins = samples.map((x) => x.items.coin ?? 0);
    expect(coins[20]).toBe(0);
    expect(coins[45]).toBe(1); // crossed it once (many frames inside)
    expect(coins.at(-1)).toBe(2); // and back
  });

  it("interact fires on Up while overlapping, with a prompt shown while possible", () => {
    const [before, after] = results.interact;
    expect(prop(before, "sign").prompt).toBe("Read");
    expect(prop(before, "lamp").prompt).toBe("↑");
    expect(prop(before, "plain").prompt).toBeUndefined();
    expect(prop(before, "far").prompt).toBeUndefined();
    expect(before!.flags).toEqual([]);
    expect(after!.flags).toEqual(["read"]);
    expect(after!.items).toEqual({ coin: 1 });
  });

  it("hit fires when the sword strikes it", () => {
    const [before, after] = results.hit;
    expect(before!.items).toEqual({});
    expect(after!.items).toEqual({ coin: 1 });
  });

  it("a downward strike on a bounce prop bounces the player; on another it doesn't", () => {
    const bounced = results.bounce;
    const landed = results.flat;
    expect(bounced.at(-1)!.items).toEqual({ coin: 1 });
    expect(landed.at(-1)!.items).toEqual({ coin: 1 });
    const hitAt = first(bounced, (x) => x.items.coin === 1)!.frame;
    expect(Math.min(...bounced.slice(hitAt).map((x) => player(x).y))).toBeLessThan(560);
    expect(player(landed.at(-1)).y).toBe(640);
    const fall = landed.slice(hitAt).map((x) => player(x).y);
    expect(fall).toEqual([...fall].sort((a, b) => a - b)); // kept falling
  });

  it("a prop with health fires destroyed after that many hits, then is gone for the visit", () => {
    const [two, three, walked] = results.health;
    expect(two!.items).toEqual({ coin: 2 });
    expect(prop(two, "crack")).toMatchObject({ visible: true, solid: true });
    expect(two!.flags).toEqual([]);
    expect(three!.items).toEqual({ coin: 3 });
    expect(three!.flags).toEqual(["broken"]);
    expect(prop(three, "crack")).toMatchObject({ visible: false, solid: false });
    expect(player(walked).x).toBeGreaterThan(300); // walked through where it stood
  });
});

describe("prop conditions", () => {
  it("visibility and solidity follow flags in the frame they change", () => {
    const samples = results.follow;
    for (const x of samples) {
      const open = x.flags.includes("open");
      expect(prop(x, "barrier").solid).toBe(!open);
      expect(prop(x, "sign").visible).toBe(open);
      expect(prop(x, "early")).toMatchObject({ visible: true, solid: true });
    }
    expect(first(samples, (x) => x.flags.includes("open"))).toBeDefined();
  });

  it("a prop turning solid around the player waits until they step out, then blocks", () => {
    const samples = results.closing;
    const shut = first(samples, (x) => x.flags.includes("shut"))!;
    expect(prop(shut, "shutter").solid).toBe(false);
    expect(player(shut).y).toBe(ARENA_FLOOR);
    const out = first(samples, (x) => prop(x, "shutter").solid)!;
    expect(player(out).x - 14).toBeGreaterThanOrEqual(180);
    expect(Math.min(...samples.slice(out.frame).map((x) => player(x).x))).toBe(180 + 14); // blocked on the way back
  });
});

describe("recipes", () => {
  it("(a) a pickup is gone for good: after re-entering the room, dying, and Continue", () => {
    const samples = results.pickup;
    const taken = first(samples, (x) => x.items.gem === 1)!;
    expect(prop(taken, "gem").visible).toBe(false);
    const back = first(samples, (x) => x.room === "west" && x.visited.includes("east"))!;
    expect(prop(back, "gem").visible).toBe(false);
    const died = first(samples, (x) => x.deaths === 1)!;
    expect(died.room).toBe("west");
    expect(prop(samples.at(-1), "gem").visible).toBe(false);
    expect(samples.at(-1)!.items).toEqual({ gem: 1 });
    const [resumed] = results.pickupContinued;
    expect(resumed!.items).toEqual({ gem: 1 });
    expect(prop(resumed, "gem").visible).toBe(false);
  });

  it("(b) an item opens a locked barrier", () => {
    const samples = results.locked;
    expect(at(samples, 85)!.items).toEqual({ key: 1 });
    expect(player(at(samples, 85)).x).toBe(400 - 14);
    expect(prop(at(samples, 85), "barrier")).toMatchObject({ solid: true, prompt: "Unlock" });
    expect(samples.at(-1)!.items).toEqual({});
    expect(prop(samples.at(-1), "barrier")).toMatchObject({ visible: false, solid: false });
    expect(player(samples.at(-1)).x).toBeGreaterThan(450);
  });

  it("(c) a switch in one room opens a barrier in another", () => {
    const open = results.switched.at(-1)!;
    const shut = results.unswitched.at(-1)!;
    expect([open.room, shut.room]).toEqual(["east", "east"]);
    expect(open.flags).toEqual(["gate_open"]);
    expect(prop(open, "barrier").solid).toBe(false);
    expect(player(open).x).toBeGreaterThan(232);
    expect(prop(shut, "barrier").solid).toBe(true);
    expect(player(shut).x).toBe(200 - 14);
  });

  it("(d) a save spot sets the checkpoint, heals and saves; death comes back there", () => {
    const samples = results.saveSpot;
    expect(player(at(samples, 160)).health).toBe(3);
    const rested = at(samples, 170)!;
    expect(player(rested).health).toBe(5);
    expect(rested.checkpoint).toEqual({ room: "east", x: 305, y: FLOOR });
    const died = first(samples, (x) => x.deaths === 1)!;
    expect(died.room).toBe("east");
    expect(player(samples.at(-1))).toMatchObject({ x: 305, y: FLOOR, health: 5 });
    const [resumed] = results.saveSpotContinued;
    expect(resumed!.room).toBe("east");
    expect(resumed!.checkpoint).toEqual(rested.checkpoint);
  });

  it("(e) a wall broken by three hits stays broken", () => {
    const samples = results.breakable;
    expect(prop(at(samples, 60), "wall")).toMatchObject({ visible: true, solid: true });
    expect(prop(at(samples, 90), "wall")).toMatchObject({ visible: false, solid: false });
    const back = first(samples, (x) => x.room === "west" && x.visited.includes("east"))!;
    expect(prop(back, "wall")).toMatchObject({ visible: false, solid: false });
    expect(samples.at(-1)!.room).toBe("west");
    expect(player(samples.at(-1)).x).toBeLessThan(300); // back through where it stood
  });

  it("(f) a pickup grants an ability, which then works", () => {
    const samples = results.power;
    expect(at(samples, 35)!.abilities).toEqual(["double_jump"]);
    expect(prop(at(samples, 35), "orb").visible).toBe(false);
    const ys = samples.map((x) => player(x).y);
    const firstPeak = Math.min(...ys.slice(40, 58));
    const secondPeak = Math.min(...ys.slice(58, 120));
    expect(secondPeak).toBeLessThan(firstPeak - 40);
  });
});
