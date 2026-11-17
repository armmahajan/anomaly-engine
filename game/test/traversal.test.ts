import { beforeAll, describe, expect, it } from "vitest";
import {
  chainChunks,
  chunkDoors,
  chunkLibrary,
  createDefaultProject,
  findRoute,
  gridToSolids,
  movementParams,
  MOVEMENT_ABILITIES,
  ProjectSpec,
  roomGraph,
  routeInputs,
  stampChunk,
  TILE,
  wallJumpShaft,
  type ChunkOpening,
  type FrameInput,
  type MovementAbility,
  type PlayerCharacter,
  type TileGrid,
} from "@anomaly/core";
import { entity, range, simulate, type Input, type Sample, type Scenario } from "./simulate.ts";

// The traversal checker finds a route through each chunk with its required
// abilities; routeInputs turns it into frame inputs. Here the real runtime
// plays those inputs and must get the player out through the exit; with the
// gate's ability taken away, the same inputs must not.

const base = createDefaultProject();
const player = base.characters[0] as PlayerCharacter;
const params = movementParams(player, base.sandbox.gravity);
const ALL = Object.keys(MOVEMENT_ABILITIES) as MovementAbility[];
const PAD = 6;

type Span = { action: Input; from: number; to: number };

/** Harness spans for an input timeline (the harness applies input given at frame k on the next physics step). */
function spansFromFrames(inputs: FrameInput[]): Span[] {
  const spans: Span[] = [];
  const add = (action: Input, on: (input: FrameInput) => boolean) => {
    for (let f = 0; f < inputs.length; f++) {
      if (!inputs[f + 1] || !on(inputs[f + 1]!)) continue;
      const from = f;
      while (inputs[f + 1] && on(inputs[f + 1]!)) f++;
      spans.push({ action, from, to: f });
    }
  };
  add("move_right", (i) => !!i.right);
  add("move_left", (i) => !!i.left);
  add("aim_down", (i) => !!i.down);
  add("jump", (i) => !!i.jump);
  add("dash", (i) => !!i.dashPressed);
  return spans;
}

interface Case {
  name: string;
  grid: TileGrid;
  openings: ChunkOpening[];
  requires: MovementAbility[];
  gate?: MovementAbility;
}

const lib = chunkLibrary(params);
const byKind = Object.fromEntries(lib.map((c) => [c.gate?.ability ?? c.kind, c]));
const chained = chainChunks([byKind.corridor!, byKind.dash!, byKind.stairs!, byKind.double_jump!, wallJumpShaft(params, { exitSide: "right" }), byKind.glide!, byKind.ground_pound!, byKind.hall!]);
const cases: Case[] = [
  ...lib.map((c) => ({ name: c.id, grid: c.grid, openings: c.openings, requires: c.requires, gate: c.gate?.ability })),
  { name: "eight chunks chained", grid: chained.grid, openings: chained.openings, requires: ALL },
];

/** The checker's route for a case, as inputs from its entry. */
function plan(c: Case) {
  const graph = roomGraph(c.grid, chunkDoors(c), params, c.requires);
  const route = findRoute(graph, "in:entry", "out:exit");
  if (!route) throw new Error(`${c.name}: the checker finds no route`);
  const replay = routeInputs(graph, route);
  if (!replay.ok) throw new Error(`${c.name}: the route does not replay in the simulator (stuck at ${replay.at})`);
  return { ...replay, kinds: route.map((m) => m.kind) };
}

/** The case's grid padded into an empty arena, the player at the route's start. */
function scenario(c: Case, abilities: MovementAbility[], replay: ReturnType<typeof plan>): Scenario {
  const cols = c.grid.rows[0]!.length + 2 * PAD;
  const rows = c.grid.rows.length + 2 * PAD;
  const grid = stampChunk({ rows: Array.from({ length: rows }, () => ".".repeat(cols)) }, c, PAD, PAD);
  const frames = replay.inputs.length + 10;
  return {
    project: ProjectSpec.parse({
      ...base,
      characters: [player],
      sandbox: {
        ...base.sandbox,
        grid,
        playerAbilities: abilities,
        spawns: [{ id: "player_1", characterId: "player", x: replay.start.x + PAD * TILE, y: replay.start.y + PAD * TILE }],
      },
    }),
    frames,
    samples: range(0, frames),
    input: spansFromFrames(replay.inputs),
  };
}

/**
 * Did the player leave the case's grid through its exit opening, without
 * touching a hazard first? (The runtime doesn't hurt on hazards yet, so a
 * touch is checked here, with the checker's 1 px margin.)
 */
function exits(c: Case, samples: Sample[]): boolean {
  const exit = c.openings[1]!;
  const [w, h] = [c.grid.rows[0]!.length * TILE, c.grid.rows.length * TILE];
  const [a, b] = [exit.offset * TILE, (exit.offset + exit.size) * TILE];
  const hazards = gridToSolids(c.grid).filter((s) => s.kind === "hazard");
  const hw = params.width / 2;
  for (const s of samples) {
    const e = entity(s, "player_1");
    const x = e.x - PAD * TILE;
    const y = e.y - PAD * TILE;
    if (hazards.some((z) => x - hw - 1 < z.x + z.width && x + hw + 1 > z.x && y - params.height - 1 < z.y + z.height && y + 1 > z.y)) return false;
    const cy = y - params.height / 2;
    const out =
      exit.side === "right" ? x > w && y - params.height >= a - 0.01 && y <= b + 0.01
      : exit.side === "left" ? x < 0 && y - params.height >= a - 0.01 && y <= b + 0.01
      : exit.side === "top" ? cy < 0 && x - hw >= a && x + hw <= b
      : cy > h && x - hw >= a && x + hw <= b;
    if (out) return true;
  }
  return false;
}

const replays = cases.map(plan);
const runs: { c: Case; i: number; without?: MovementAbility }[] = cases.flatMap((c, i) => [{ c, i }, ...(c.gate ? [{ c, i, without: c.gate }] : [])]);
let results: Sample[][];

beforeAll(() => {
  results = simulate(runs.map((r) => scenario(r.c, r.without ? r.c.requires.filter((a) => a !== r.without) : r.c.requires, replays[r.i]!)));
}, 240_000);

describe("checker routes in the runtime", () => {
  it.each(cases.map((c, i) => [c.name, replays[i]!.kinds.join(" > "), i] as const))("%s (%s) gets out through the exit", (_name, _kinds, i) => {
    expect(exits(cases[i]!, results[runs.findIndex((r) => r.i === i && !r.without)]!)).toBe(true);
  });

  it.each(runs.filter((r) => r.without).map((r) => [r.c.name, r.without!, runs.indexOf(r)] as const))("%s: the same inputs fail without %s", (_name, _ability, k) => {
    expect(exits(runs[k]!.c, results[k]!)).toBe(false);
  });

  it("the runtime moves exactly as the simulator did", () => {
    // The harness skips the first physics step after play (the route starts with idle frames), so runtime frame k is simulator state k - 1.
    for (const [k, r] of runs.entries()) {
      if (r.without) continue;
      const states = replays[r.i]!.states;
      for (const s of results[k]!) {
        const m = states[s.frame - 1];
        if (!m) continue;
        const e = entity(s, "player_1");
        const off = Math.max(Math.abs(e.x - PAD * TILE - m.x), Math.abs(e.y - PAD * TILE - m.y));
        if (off > 0.001) throw new Error(`${r.c.name} frame ${s.frame}: runtime (${e.x - PAD * TILE}, ${e.y - PAD * TILE}) vs simulator (${m.x}, ${m.y})`);
      }
    }
  });
});
