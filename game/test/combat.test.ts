import { beforeAll, describe, expect, it } from "vitest";
import { arena, entity, FPS, range, simulate, type Input, type Sample, type Scenario } from "./simulate.ts";
import { ARENA_FLOOR } from "@anomaly/core";

const FLOOR = ARENA_FLOOR;
const s = (seconds: number) => Math.round(seconds * FPS);
const press = (action: Input, from: number, to = from + 2) => ({ action, from, to });
const track = (samples: Sample[], spawnId: string) => samples.map((x) => entity(x, spawnId));

const closeIn = { type: "chase", speed: 150, stopDistance: 40 };

function withPlayerHealth(scenario: Scenario, health: number): Scenario {
  const [player, ...rest] = scenario.project.characters;
  if (player?.kind !== "player") throw new Error("player first");
  return { ...scenario, project: { ...scenario.project, characters: [{ ...player, stats: { ...player.stats, health } }, ...rest] } };
}

const scenarios = {
  forward: {
    project: arena([{ id: "dummy", at: [260, FLOOR], stats: { health: 2 }, initial: "go", states: { go: { action: closeIn } } }]),
    frames: s(2),
    samples: range(0, s(2)),
    input: [press("attack", 40), press("attack", 48), press("attack", 80)],
  },
  up: {
    project: arena([{ id: "bat", at: [160, 600], movement: "flying", initial: "idle", states: { idle: { action: { type: "wait" } } } }]),
    frames: s(1),
    samples: range(0, s(1)),
    input: [press("aim_up", 0, 30), press("attack", 5)],
  },
  pogo: {
    project: arena(
      [{ id: "dummy", at: [300, FLOOR], stats: { contactDamage: 1, knockback: 300 }, initial: "idle", states: { idle: { action: { type: "wait" } } } }],
      [300, 400],
    ),
    frames: s(1),
    samples: range(0, s(1)),
    input: [press("aim_down", 0, 40), press("attack", 22)],
  },
  death: withPlayerHealth(
    {
      project: arena([{ id: "spiker", at: [500, FLOOR], stats: { contactDamage: 1, knockback: 300 }, initial: "go", states: { go: { action: { type: "chase", speed: 250 } } } }]),
      frames: s(5),
      samples: range(0, s(5), 2),
    },
    2,
  ),
  reactions: {
    project: arena([
      {
        id: "brute",
        at: [260, FLOOR],
        stats: { health: 4 },
        initial: "idle",
        states: {
          idle: { action: closeIn, go: [[{ type: "healthBelow", fraction: 0.5 }, "enraged"], [{ type: "wasHit" }, "flinch"]] },
          flinch: { action: { type: "wait" }, go: [[{ type: "after", seconds: 0.2 }, "idle"]] },
          enraged: { action: { type: "wait" } },
        },
      },
    ]),
    frames: s(2.5),
    samples: range(0, s(2.5)),
    input: [press("attack", 40), press("attack", 80), press("attack", 120)],
  },
} satisfies Record<string, Scenario>;

let r: Record<keyof typeof scenarios, Sample[]>;

beforeAll(() => {
  const results = simulate(Object.values(scenarios));
  r = Object.fromEntries(Object.keys(scenarios).map((k, i) => [k, results[i]!])) as typeof r;
}, 60_000);

describe("player sword", () => {
  it("a forward swing damages, knocks back and kills; the cooldown swallows a too-early press", () => {
    const dummy = track(r.forward, "dummy_1");
    const player = track(r.forward, "player");
    const hit = dummy.findIndex((e) => e.health === 1);
    expect(hit).toBeGreaterThan(40);
    expect(dummy[hit + 15]!.health).toBe(1);
    expect(dummy.at(-1)!.health).toBe(0);
    expect(player.some((e) => e.behaviorState === "slash_forward")).toBe(true);

    expect(dummy[hit + 1]!.x).toBe(dummy[hit + 2]!.x);
    expect(dummy[hit + 6]!.x).toBeGreaterThan(dummy[hit]!.x + 10);
    expect(player[hit + 6]!.x).toBeLessThan(player[hit]!.x - 5);
  });

  it("an up swing hits enemies overhead", () => {
    const bat = track(r.up, "bat_1");
    expect(bat.at(-1)!.health).toBe(2);
    expect(Math.min(...bat.map((e) => e.y))).toBeLessThan(590);
    expect(track(r.up, "player").some((e) => e.behaviorState === "slash_up")).toBe(true);
  });

  it("a downward strike in the air bounces the player off the enemy (pogo) without taking damage", () => {
    const player = track(r.pogo, "player");
    const dummy = track(r.pogo, "dummy_1");
    const hit = dummy.findIndex((e) => e.health === 2);
    expect(hit).toBeGreaterThan(0);
    expect(player[hit + 1]!.velocityY).toBeLessThan(-500);
    expect(Math.min(...player.slice(hit).map((e) => e.y))).toBeLessThan(player[hit]!.y - 60);
    expect(new Set(player.map((e) => e.health))).toEqual(new Set([5]));
  });
});

describe("player health", () => {
  it("contact damage costs health once per invulnerability window; at 0 the run restarts", () => {
    const deathAt = r.death.findIndex((x) => x.deaths === 1);
    expect(deathAt).toBeGreaterThan(0);
    const before = r.death.slice(0, deathAt).map((x) => entity(x, "player").health);
    expect(before).toContain(1);
    expect(before.slice(0, 20)).toEqual(Array(20).fill(2));
    const after = entity(r.death[deathAt], "player");
    expect(after).toMatchObject({ health: 2, x: 160, y: FLOOR });
    expect(entity(r.death[deathAt], "spiker_1").x).toBeCloseTo(500, -1);
  });
});

describe("enemy reactions", () => {
  it("wasHit and healthBelow drive flinches and a second phase", () => {
    const brute = track(r.reactions, "brute_1");
    const states = brute.map((e) => e.behaviorState);
    expect(states.filter((x, i) => x === "flinch" && states[i - 1] !== "flinch")).toHaveLength(2);
    expect(states.at(-1)).toBe("enraged");
    expect(brute.at(-1)!.health).toBe(1);
  });
});
