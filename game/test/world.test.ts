import { beforeAll, describe, expect, it } from "vitest";
import { applyOperation, fixtureProject, FIXTURE_END_ROOM, type ProjectSpec } from "@anomaly/core";
import { at, entity, range, simulate, type Sample, type Scenario } from "./simulate.ts";

// World play in the real runtime, on the fixture world (packages/core/src/world/fixture.ts):
// entrance -> hall -(shaft down)-> cistern -> spikes -(up through the ceiling)-> bridge -> sanctum.

const fixture = fixtureProject();
const player = (s: Sample | undefined) => entity(s, "player");
const withRules = (rules: Record<string, unknown>): ProjectSpec => {
  const result = applyOperation(fixture, "setGameRules", rules);
  if (!result.ok) throw new Error(result.error.message);
  return result.project;
};
const run = (room: string, x: number, y: number, frames: number, input: Scenario["input"] = [], project = fixture): Scenario => ({
  project,
  world: { room, x, y, abilities: [] },
  frames,
  samples: range(0, frames),
  input,
});
const right = (from: number, to: number) => ({ action: "move_right" as const, from, to });
const left = (from: number, to: number) => ({ action: "move_left" as const, from, to });
const jump = (from: number, to: number) => ({ action: "jump" as const, from, to });
/** The first sample in `room`. */
const arrival = (samples: Sample[], room: string) => samples.find((s) => s.room === room);

/** Through the spike pit room: over the pit, onto the ledge and the one-way platform, up through the ceiling (frames from entering at x 20). */
const SPIKES_ROUTE = (t: number) => [jump(t + 50, t + 80), jump(t + 108, t + 138), right(t + 170, t + 208), jump(t + 170, t + 200), jump(t + 216, t + 250)];

let samples: Sample[][];
beforeAll(() => {
  samples = simulate([
    run("entrance", 900, 384, 30, [right(1, 30)]),
    run("hall", 60, 384, 30, [left(1, 30)]),
    run("hall", 1000, 384, 90, [right(1, 20)]),
    run("spikes", 930, 128, 90, [jump(5, 40), right(20, 90)]),
    run("spikes", 20, 384, 100, [right(1, 100)], withRules({ hazardDamage: 2 })),
    run("spikes", 20, 384, 100, [right(1, 100)], withRules({ hazardDamage: 20 })),
    run("spikes", 20, 384, 100, [right(1, 100)], withRules({ hazardDamage: 20, onDeath: "start" })),
    run("entrance", 96, 384, 1000, [right(1, 640), ...SPIKES_ROUTE(505), right(737, 1000)]),
  ]);
}, 120_000);

describe("doors", () => {
  it("walking out a right door enters the next room just inside its left door, at the same height, still running", () => {
    const s = samples[0]!;
    const enter = arrival(s, "hall")!;
    expect(player(at(s, enter.frame - 1))!.x).toBeGreaterThan(960 - 6);
    expect(player(enter)).toMatchObject({ x: 15, y: 384, velocityX: 320 });
    expect(enter.visited).toEqual(["entrance", "hall"]);
  });

  it("walking out a left door enters through the right door of the room before", () => {
    const enter = arrival(samples[1]!, "entrance")!;
    expect(player(enter).x).toBe(960 - 15);
    expect(player(enter).y).toBe(384);
  });

  it("falling through a bottom door keeps falling into the room below, at the matching place along the opening", () => {
    const s = samples[2]!;
    const enter = arrival(s, "cistern")!;
    const before = player(at(s, enter.frame - 1));
    expect(before.y).toBeGreaterThan(448 - 20);
    expect(player(enter).x).toBeCloseTo(4 * 32 + (before.x - 30 * 32), 0);
    expect(player(enter).y).toBeLessThan(80);
    expect(player(enter).velocityY).toBeGreaterThan(0);
    expect(enter.entities.some((e) => e.characterId === "crawler")).toBe(true); // the room's enemies spawn on entry
    expect(player(s.at(-1))).toMatchObject({ y: 544, velocityY: 0 }); // landed on the cistern floor
  });

  it("jumping up through a top door carries the player up into the room above, to land beside the opening", () => {
    const s = samples[3]!;
    const enter = arrival(s, "bridge")!;
    expect(player(enter).x).toBeCloseTo(6 * 32 + (930 - 28 * 32), 0);
    expect(player(enter).y).toBeGreaterThan(330);
    expect(player(enter).velocityY).toBeLessThan(-500);
    const landed = player(s.at(-1));
    expect(landed.y).toBe(320); // the bridge floor
    expect(landed.x).toBeGreaterThan(9 * 32 + 14); // beside the opening (cols 6-8)
    expect(s.at(-1)!.room).toBe("bridge");
    const touchdown = player(s.find((x) => x.room === "bridge" && player(x).y === 320));
    expect(s.at(-1)!.entry).toEqual([touchdown.x, 320]); // the respawn point moved to where they landed
  });
});

describe("rules", () => {
  it("a hazard costs hazardDamage and puts the player back on the last safe ground", () => {
    const s = samples[4]!;
    const hurt = s.findIndex((x) => player(x).health < 5);
    expect(player(s[hurt]).health).toBe(3);
    expect(player(s[hurt])).toMatchObject({ y: 384, velocityY: 0 });
    expect(player(s[hurt]).x).toBeLessThanOrEqual(10 * 32 - 14); // fully on the floor before the pit
    expect(s[hurt]!.room).toBe("spikes");
    expect(s.every((x) => x.deaths === 0 && player(x).y <= 416)).toBe(true);
  });

  it("dying with onDeath room puts the player back where they entered the room, at full health", () => {
    const s = samples[5]!;
    const died = s.findIndex((x) => x.deaths === 1);
    expect(died).toBeGreaterThan(0);
    expect(s[died]!.room).toBe("spikes");
    expect(player(s[died])).toMatchObject({ x: expect.closeTo(20, 0), y: 384, health: 5 });
  });

  it("dying with onDeath start puts the player back at the world's start", () => {
    const s = samples[6]!;
    const died = s.findIndex((x) => x.deaths === 1);
    expect(s[died]!.room).toBe("entrance");
    expect(player(s[died])).toMatchObject({ x: 96, y: 384, health: 5 });
    expect(s[died]!.visited).toEqual(["spikes", "entrance"]);
  });
});

it("rejects a world start in an unknown room, listing the rooms", () => {
  expect(() => simulate([run("attic", 10, 10, 1)])).toThrow(/invalid_world_start: no room 'attic' \(known: entrance, hall/);
});

it("a scripted route crosses the fixture world from the start to the end room", () => {
  const s = samples[7]!;
  const order = s.map((x) => x.room).filter((room, i, all) => room !== all[i - 1]);
  expect(order).toEqual(["entrance", "hall", "cistern", "spikes", "bridge", FIXTURE_END_ROOM]);
  expect(s.at(-1)!.visited).toHaveLength(6);
  expect(s.every((x) => x.deaths === 0 && player(x).health === 5)).toBe(true);
});
