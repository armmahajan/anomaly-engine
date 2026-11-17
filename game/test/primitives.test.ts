import { beforeAll, describe, expect, it } from "vitest";
import { ARENA_FLOOR, createDefaultProject, type ProjectSpec } from "@anomaly/core";
import { arena, at, entity, FPS, range, simulate, type Sample, type Scenario } from "./simulate.ts";

const FLOOR = ARENA_FLOOR;
/** The starter arena's ledge. */
const PLATFORM = { left: 384, right: 608, top: 544 };
const wait = { type: "wait" };
const s = (seconds: number) => Math.round(seconds * FPS);
const statesOf = (samples: Sample[], spawnId: string) => samples.map((x) => entity(x, spawnId).behaviorState);

/** The starter project with only the player and its Charger. */
function starterCharger(player: [number, number]): ProjectSpec {
  const base = createDefaultProject();
  const spawns = base.sandbox.spawns
    .filter((sp) => sp.characterId !== "crawler")
    .map((sp) => (sp.characterId === "player" ? { ...sp, x: player[0], y: player[1] } : sp));
  return { ...base, sandbox: { ...base.sandbox, spawns } };
}

const scenarios = {
  ledgeAware: {
    project: arena([
      { id: "careful", at: [490, PLATFORM.top], initial: "walk", states: { walk: { action: { type: "patrol", speed: 150, distance: 1000, turnAtLedge: true } } } },
    ]),
    frames: s(4),
    samples: [s(4)],
  },
  ledgeBlind: {
    project: arena([
      { id: "careless", at: [490, PLATFORM.top], initial: "walk", states: { walk: { action: { type: "patrol", speed: 150, distance: 1000 } } } },
    ]),
    frames: s(4),
    samples: [s(4)],
  },
  pauseAtEnds: {
    project: arena([
      {
        id: "pacer",
        at: [1000, FLOOR],
        initial: "walk",
        states: {
          walk: { action: { type: "patrol", speed: 200, distance: 200 }, go: [[{ type: "actionDone" }, "rest"]] },
          rest: { action: wait, go: [[{ type: "after", seconds: 0.5 }, "walk"]] },
        },
      },
    ]),
    frames: s(6),
    samples: range(0, s(6), 3),
  },
  chaseRetreatHome: {
    project: arena(
      [
        { id: "chaser", at: [1000, FLOOR], initial: "go", states: { go: { action: { type: "chase", speed: 300, stopDistance: 150 } } } },
        { id: "coward", at: [600, FLOOR], initial: "go", states: { go: { action: { type: "retreat", speed: 200 } } } },
        {
          id: "homebody",
          at: [1200, FLOOR],
          initial: "out",
          states: {
            out: { action: { type: "chase", speed: 300 }, go: [[{ type: "after", seconds: 1 }, "back"]] },
            back: { action: { type: "returnHome", speed: 300 }, go: [[{ type: "actionDone" }, "home"]] },
            home: { action: wait },
          },
        },
      ],
      [400, FLOOR],
    ),
    frames: s(4),
    samples: [s(1), s(4)],
  },
  jump: {
    project: arena([
      {
        id: "hopper",
        at: [1000, FLOOR],
        initial: "leap",
        states: {
          leap: { action: { type: "jump", height: 120, distance: 200, toward: "facing" }, go: [[{ type: "actionDone" }, "landed"]] },
          landed: { action: wait },
        },
      },
    ]),
    frames: s(2),
    samples: range(0, s(2)),
  },
  flyers: {
    project: arena(
      [
        { id: "bat", at: [800, 300], movement: "flying", initial: "bob", states: { bob: { action: { type: "hover", amplitude: 20, period: 1 } } } },
        {
          id: "diver",
          at: [1200, 300],
          movement: "flying",
          initial: "dive",
          states: {
            dive: { action: { type: "charge", speed: 600, direction: "towardPlayer" }, go: [[{ type: "actionDone" }, "hit"]] },
            hit: { action: wait },
          },
        },
      ],
      [400, FLOOR],
    ),
    frames: s(3),
    samples: range(0, s(3), 2),
  },
  senses: {
    project: arena(
      [
        { id: "high", at: [830, 416], initial: "idle", states: { idle: { action: wait, go: [[{ type: "playerBelow" }, "yes"]] }, yes: { action: wait } } },
        { id: "level", at: [1100, FLOOR], initial: "idle", states: { idle: { action: wait, go: [[{ type: "playerAbove" }, "yes"]] }, yes: { action: wait } } },
        { id: "facer", at: [600, FLOOR], initial: "idle", states: { idle: { action: wait, go: [[{ type: "playerBehind" }, "yes"]] }, yes: { action: wait } } },
        { id: "front", at: [600, FLOOR], initial: "idle", states: { idle: { action: wait, go: [[{ type: "playerInFront" }, "yes"]] }, yes: { action: wait } } },
        { id: "even", at: [1100, FLOOR], initial: "idle", states: { idle: { action: wait, go: [[{ type: "playerLevel" }, "yes"]] }, yes: { action: wait } } },
        { id: "uneven", at: [830, 416], initial: "idle", states: { idle: { action: wait, go: [[{ type: "playerLevel" }, "yes"]] }, yes: { action: wait } } },
        { id: "seer", at: [1100, FLOOR], initial: "idle", states: { idle: { action: wait, go: [[{ type: "canSeePlayer" }, "yes"]] }, yes: { action: wait } } },
        { id: "blind", at: [830, 416], initial: "idle", states: { idle: { action: wait, go: [[{ type: "canSeePlayer" }, "yes"]] }, yes: { action: wait } } },
        {
          id: "edge",
          at: [490, PLATFORM.top],
          initial: "walk",
          states: { walk: { action: { type: "patrol", speed: 100, distance: 1000 }, go: [[{ type: "atLedge" }, "stop"]] }, stop: { action: wait } },
        },
        {
          id: "dropper",
          at: [1300, 300],
          initial: "fall",
          states: { fall: { action: wait, go: [[{ type: "onGround" }, "down"]] }, down: { action: wait, go: [[{ type: "airborne" }, "fall"]] } },
        },
      ],
      [300, FLOOR],
    ),
    frames: s(2),
    samples: [s(2)],
  },
  chargerLedge: { project: starterCharger([490, PLATFORM.top]), frames: s(3), samples: range(0, s(3), 5) },
  chargerFloor: { project: starterCharger([420, FLOOR]), frames: s(1), samples: range(0, s(1), 5) },
  interrupts: {
    project: arena([
      {
        id: "guard",
        at: [1000, 300],
        initial: "fall",
        interrupts: [[{ type: "onGround" }, "landed"]],
        states: { fall: { action: wait }, landed: { action: wait, go: [[{ type: "after", seconds: 0.3 }, "rest"]] }, rest: { action: wait } },
      },
    ]),
    frames: s(2),
    samples: range(0, s(2)),
  },
} satisfies Record<string, Scenario>;

const chancer = (seed: number): Scenario => ({
  project: arena([
    {
      id: "coin",
      at: [1000, FLOOR],
      count: 12,
      initial: "flip",
      states: { flip: { action: wait, go: [[{ type: "chance", p: 0.5 }, "heads"], [{ type: "after", seconds: 0 }, "tails"]] }, heads: { action: wait }, tails: { action: wait } },
    },
  ]),
  seed,
  frames: 5,
  samples: [5],
});

type Results = Record<keyof typeof scenarios | "seedA" | "seedA2" | "seedB", Sample[]>;
let r: Results;

beforeAll(() => {
  const named = { ...scenarios, seedA: chancer(1), seedA2: chancer(1), seedB: chancer(2) };
  const results = simulate(Object.values(named));
  r = Object.fromEntries(Object.keys(named).map((k, i) => [k, results[i]!])) as Results;
}, 60_000);

describe("movement actions", () => {
  it("patrol turns at ledges only when asked", () => {
    expect(entity(r.ledgeAware[0], "careful_1").y).toBeCloseTo(PLATFORM.top, 0);
    expect(entity(r.ledgeBlind[0], "careless_1").y).toBeCloseTo(FLOOR, 0);
  });

  it("patrol signals actionDone at each end, so pauses happen exactly at the route's ends", () => {
    const rests = r.pauseAtEnds.map((x) => entity(x, "pacer_1")).filter((e) => e.behaviorState === "rest");
    expect(rests.length).toBeGreaterThan(20);
    for (const e of rests) expect(Math.min(Math.abs(e.x - 900), Math.abs(e.x - 1100))).toBeLessThan(8);
    expect(rests.some((e) => e.x < 1000) && rests.some((e) => e.x > 1000)).toBe(true);
  });

  it("chase stops at stopDistance, retreat moves away, returnHome arrives and signals done", () => {
    const end = at(r.chaseRetreatHome, s(4));
    expect(Math.abs(entity(end, "chaser_1").x - 400 - 150)).toBeLessThan(6);
    expect(entity(at(r.chaseRetreatHome, s(1)), "coward_1").x).toBeGreaterThan(780);
    expect(entity(end, "homebody_1")).toMatchObject({ behaviorState: "home" });
    expect(Math.abs(entity(end, "homebody_1").x - 1200)).toBeLessThanOrEqual(4);
  });

  it("jump leaps to the requested height and distance, then signals done on landing", () => {
    const hopper = r.jump.map((x) => entity(x, "hopper_1"));
    expect(Math.min(...hopper.map((e) => e.y))).toBeCloseTo(FLOOR - 120, -1);
    const landed = hopper.find((e) => e.behaviorState === "landed")!;
    expect(landed.x).toBeCloseTo(1200, -1);
    expect(landed.y).toBeCloseTo(FLOOR, 0);
  });

  it("flyers hover in place and dive at the player in 2D", () => {
    const bat = r.flyers.map((x) => entity(x, "bat_1"));
    expect(Math.min(...bat.map((e) => e.y))).toBeCloseTo(300 - 20, -1);
    expect(Math.max(...bat.map((e) => e.y))).toBeCloseTo(300 + 20, -1);
    expect(new Set(bat.map((e) => Math.round(e.x)))).toEqual(new Set([800]));

    const diver = r.flyers.map((x) => entity(x, "diver_1"));
    expect(diver[10]!.x).toBeLessThan(1150);
    expect(diver[10]!.y).toBeGreaterThan(320);
    expect(diver.at(-1)!.behaviorState).toBe("hit");
  });
});

describe("conditions", () => {
  it("sense the player's position, line of sight, ledges and the ground", () => {
    const states = Object.fromEntries(
      ["high", "level", "even", "uneven", "facer", "front", "seer", "blind", "edge", "dropper"].map((id) => [id, entity(r.senses[0], `${id}_1`).behaviorState]),
    );
    expect(states).toEqual({
      high: "yes",
      level: "idle",
      even: "yes",
      uneven: "idle",
      facer: "yes",
      front: "idle",
      seer: "yes",
      blind: "idle",
      edge: "stop",
      dropper: "down",
    });
    expect(entity(r.senses[0], "edge_1").y).toBeCloseTo(PLATFORM.top, 0);
  });

  it("and-conditions: the starter Charger ignores a player on a ledge above but charges one on its level", () => {
    expect(new Set(statesOf(r.chargerLedge, "charger_1"))).toEqual(new Set(["patrol"]));
    expect(statesOf(r.chargerFloor, "charger_1")).toContain("windup");
  });

  it("interrupts fire from any state but never re-enter the current one", () => {
    const states = statesOf(r.interrupts, "guard_1");
    expect(states).toContain("landed");
    expect(states).toContain("rest");
  });

  it("chance is seeded per run: same seed, same choices", () => {
    const flips = (samples: Sample[]) => range(1, 12).map((n) => entity(samples[0], `coin_${n}`).behaviorState);
    expect(flips(r.seedA)).toEqual(flips(r.seedA2));
    expect(flips(r.seedA)).not.toEqual(flips(r.seedB));
    expect(new Set(flips(r.seedA))).toEqual(new Set(["heads", "tails"]));
  });
});
