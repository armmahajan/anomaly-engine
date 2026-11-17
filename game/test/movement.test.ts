import { beforeAll, describe, expect, it } from "vitest";
import {
  createDefaultProject,
  launchStart,
  LEDGE,
  movementModel,
  movementParams,
  ProjectSpec,
  simulateMovement,
  strategyInputs,
  WALL,
  wallClimbRun,
  type FrameInput,
  type GridSolid,
  type MovementAbility,
  type PlayerCharacter,
  type Solid,
} from "@anomaly/core";
import { entity, range, simulate, type Input, type Sample, type Scenario } from "./simulate.ts";

// The movement model (packages/core/src/movement) is a port of player.gd's
// movement. These tests run the same inputs through both and compare every
// frame, then check the model's reach predictions in the real runtime.

const base = createDefaultProject();
const player = base.characters[0] as PlayerCharacter;
const params = movementParams(player, base.sandbox.gravity);
const hw = params.width / 2;

type Span = { action: Input; from: number; to: number };

/** What player.gd sees in the headless harness: input given at frame k acts on the next physics step. */
function framesFromSpans(spans: Span[], length: number): FrameInput[] {
  const held = (action: Input, f: number) => f >= 0 && spans.some((s) => s.action === action && f >= s.from && f < s.to);
  return range(0, length - 1).map((k) => ({
    left: held("move_left", k - 1),
    right: held("move_right", k - 1),
    down: held("aim_down", k - 1),
    jump: held("jump", k - 1),
    jumpPressed: held("jump", k - 1) && !held("jump", k - 2),
    jumpReleased: !held("jump", k - 1) && held("jump", k - 2),
    dashPressed: held("dash", k - 1) && !held("dash", k - 2),
  }));
}

/** Harness spans for a model timeline (each input given one frame ahead). */
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

/** A big empty arena with the player at `start` (collision comes from the scenario's own solids). */
function arenaOf(start: { x: number; y: number }, abilities: MovementAbility[], offset: { x: number; y: number }): ProjectSpec {
  return ProjectSpec.parse({
    ...base,
    characters: [player],
    sandbox: {
      ...base.sandbox,
      grid: { rows: Array.from({ length: 282 }, () => ".".repeat(313)) },
      spawns: [{ id: "player_1", characterId: "player", x: start.x + offset.x, y: start.y + offset.y }],
      playerAbilities: abilities,
    },
  });
}

/** The scenario's solids, shifted into the arena. */
const shifted = (solids: readonly Solid[], offset: { x: number; y: number }): GridSolid[] =>
  solids.map((r) => ({ kind: "solid", ...r, x: r.x + offset.x, y: r.y + offset.y }));

interface Run {
  solids: readonly Solid[];
  start: { x: number; y: number };
  abilities: MovementAbility[];
  spans: Span[];
  frames: number;
  offset?: { x: number; y: number };
}

const OFFSET = { x: 4100, y: 400 };
const scenario = (run: Run): Scenario => ({
  project: arenaOf(run.start, run.abilities, run.offset ?? OFFSET),
  solids: shifted(run.solids, run.offset ?? OFFSET),
  frames: run.frames,
  samples: range(0, run.frames),
  input: run.spans,
});
/** The model's run, frame-aligned with the harness (whose first physics step after play is skipped). */
const model = (run: Run) => {
  const states = simulateMovement(params, run.abilities, run.solids, run.start, framesFromSpans(run.spans, run.frames).slice(1));
  return [states[0]!, ...states];
};
const span = (action: Input, from: number, to: number): Span => ({ action, from, to });
const far = { x: -2000, y: 0 };

const parity: Record<string, Run> = {
  "run, full jump, short hop": { solids: LEDGE, start: far, abilities: [], spans: [span("move_right", 0, 40), span("jump", 10, 50), span("jump", 80, 84)], frames: 140 },
  "coyote jump off a ledge": { solids: LEDGE, start: { x: -100, y: 0 }, abilities: [], spans: [span("move_right", 0, 60), span("jump", 24, 60)], frames: 120 },
  "buffered jump on landing": { solids: LEDGE, start: far, abilities: [], spans: [span("jump", 2, 40), span("jump", 50, 56)], frames: 120 },
  "double jump": {
    solids: LEDGE,
    start: far,
    abilities: ["double_jump"],
    spans: [span("move_right", 0, 90), span("jump", 1, 30), span("jump", 32, 60), span("jump", 62, 70)],
    frames: 130,
  },
  "ground dash, air dash, no second air dash": {
    solids: LEDGE,
    start: far,
    abilities: ["dash"],
    spans: [span("move_right", 0, 100), span("dash", 5, 6), span("jump", 30, 60), span("dash", 40, 41), span("dash", 69, 70)],
    frames: 120,
  },
  "glide off a ledge": { solids: LEDGE, start: { x: -30, y: 0 }, abilities: ["glide"], spans: [span("move_right", 0, 150), span("jump", 3, 150)], frames: 150 },
  "wall slide": {
    solids: WALL,
    start: { x: -hw - 1, y: 0 },
    abilities: ["wall_jump"],
    spans: [span("move_right", 0, 120), span("jump", 2, 40)],
    frames: 120,
    offset: { x: 1100, y: 5200 },
  },
  "wall climb": {
    solids: WALL,
    start: { x: -hw - 1, y: 0 },
    abilities: ["wall_jump"],
    spans: spansFromFrames(wallClimbRun(params, ["wall_jump"]).inputs),
    frames: 240,
    offset: { x: 1100, y: 5200 },
  },
  "ground pound": {
    solids: LEDGE,
    start: far,
    abilities: ["ground_pound", "double_jump"],
    spans: [span("jump", 2, 20), span("aim_down", 15, 40), span("jump", 22, 24), span("move_right", 30, 60)],
    frames: 70,
  },
  "fall at max speed": { solids: LEDGE, start: { x: 10, y: 0 }, abilities: [], spans: [span("move_right", 0, 3)], frames: 90 },
  "one-way platform: up through it, land on top, walk off": {
    solids: [...LEDGE, { x: -300, y: -120, width: 200, height: 20, kind: "oneway" }],
    start: { x: -200, y: 0 },
    abilities: [],
    spans: [span("jump", 2, 40), span("move_right", 60, 90)],
    frames: 130,
  },
  "ground pound smashes a whole breakable area": {
    solids: [
      { x: -500, y: 300, width: 1000, height: 40 },
      { x: -100, y: 0, width: 200, height: 32, kind: "breakable", group: 1 },
      { x: -100, y: 32, width: 200, height: 32, kind: "breakable", group: 1 },
    ],
    start: { x: 0, y: 0 },
    abilities: ["ground_pound"],
    spans: [span("jump", 2, 10), span("aim_down", 5, 30), span("jump", 12, 14)],
    frames: 80,
  },
  "ground pound through a breakable platform": {
    solids: [
      { x: -500, y: 300, width: 1000, height: 40 },
      { x: -100, y: 0, width: 200, height: 20, kind: "breakable", group: 1 },
    ],
    start: { x: 0, y: 0 },
    abilities: ["ground_pound"],
    spans: [span("jump", 2, 10), span("aim_down", 5, 30), span("jump", 12, 14)],
    frames: 80,
  },
};

/** Launch the model's best strategy over a gap to a landing `dy` lower. */
function launch(abilities: MovementAbility[], dy: number, gap: number): Run {
  const strategy = movementModel(params, abilities).strategy(dy)!;
  return {
    solids: [...LEDGE, { x: gap, y: dy, width: 800, height: 50 }],
    start: launchStart(params),
    abilities,
    spans: spansFromFrames(strategyInputs(strategy, 360)),
    frames: 360,
  };
}

const predictions: [MovementAbility[], number][] = [
  [[], 0],
  [[], 120],
  [["double_jump"], -200],
  [["double_jump"], 0],
  [["dash"], 0],
  [["glide"], 250],
  [["dash", "double_jump", "glide"], 0],
  [["dash", "double_jump", "glide"], -150],
];
const launches = predictions.flatMap(([abilities, dy]) => {
  const gap = movementModel(params, abilities).maxGap(dy);
  return [launch(abilities, dy, gap - 6), launch(abilities, dy, gap + 12)];
});

const parityRuns = Object.values(parity);
let samples: Sample[][];

beforeAll(() => {
  samples = simulate([...parityRuns.map(scenario), ...launches.map(scenario)]);
}, 120_000);

const godot = (s: Sample, run: Run) => {
  const e = entity(s, "player_1");
  const o = run.offset ?? OFFSET;
  return { x: e.x - o.x, y: e.y - o.y, state: e.behaviorState };
};

describe("player.gd and the movement model", () => {
  it.each(Object.keys(parity))("move identically: %s", (name) => {
    const run = parity[name]!;
    const ours = model(run);
    const theirs = samples[parityRuns.indexOf(run)]!;
    for (const s of theirs) {
      const g = godot(s, run);
      const m = ours[s.frame]!;
      const off = Math.max(Math.abs(g.x - m.x), Math.abs(g.y - m.y));
      if (off > 0.001) throw new Error(`frame ${s.frame}: runtime (${g.x.toFixed(2)}, ${g.y.toFixed(2)}) vs model (${m.x.toFixed(2)}, ${m.y.toFixed(2)})`);
    }
  });

  it("each ability does what it says", () => {
    const at = (name: string, frame: number) => model(parity[name]!)[frame]!;
    const states = (name: string) => samples[parityRuns.indexOf(parity[name]!)]!.map((s) => godot(s, parity[name]!).state);
    expect(-Math.min(...model(parity["run, full jump, short hop"]!).map((s) => s.y))).toBeCloseTo(movementModel(params, []).maxHeight, 1);
    expect(at("ground dash, air dash, no second air dash", 18).x - at("ground dash, air dash, no second air dash", 6).x).toBeCloseTo(220, 0);
    expect(states("ground dash, air dash, no second air dash").filter((s) => s === "dash")).toHaveLength(24);
    expect(states("glide off a ledge")).toContain("glide");
    expect(states("wall slide")).toContain("wall_slide");
    expect(states("ground pound")).toContain("ground_pound");
    expect(at("fall at max speed", 90).vy).toBe(params.maxFallSpeed);
    const climb = model(parity["wall climb"]!);
    expect(-climb.at(-1)!.y).toBeGreaterThan(500);
    expect(at("ground pound through a breakable platform", 80)).toMatchObject({ y: 300, onFloor: true, pounding: false });
    expect(at("ground pound smashes a whole breakable area", 80)).toMatchObject({ y: 300, onFloor: true });
    const oneWay = model(parity["one-way platform: up through it, land on top, walk off"]!);
    expect(oneWay[58]).toMatchObject({ y: -120, onFloor: true });
    expect(oneWay.at(-1)).toMatchObject({ y: 0, onFloor: true });
  });

  it.each(predictions.map(([a, dy], i) => [a.join("+") || "no abilities", dy, i] as const))(
    "predicts the widest gap (%s, landing %ipx lower)",
    (_name, dy, i) => {
      const [short, long] = [launches[2 * i]!, launches[2 * i + 1]!];
      const onLanding = (run: Run, p: { x: number; y: number }) => Math.abs(p.y - dy) < 0.5 && p.x + hw > run.solids[1]!.x;
      const runtimeLands = (run: Run) => samples[parityRuns.length + launches.indexOf(run)]!.some((s) => onLanding(run, godot(s, run)));
      const modelLands = (run: Run) => model(run).some((s) => s.onFloor && onLanding(run, s));
      expect([runtimeLands(short), modelLands(short)]).toEqual([true, true]);
      expect([runtimeLands(long), modelLands(long)]).toEqual([false, false]);
    },
  );
});
