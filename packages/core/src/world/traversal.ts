import { MOVEMENT_FPS, toFrames, type MovementAbility, type MovementParams } from "../movement/params.ts";
import { deriveMovement, initialState, stepMovement, type Derived, type FrameInput, type MoveState, type Solid } from "../movement/simulate.ts";
import { movementModel, type MovementModel } from "../movement/model.ts";
import { DEFAULT_LEDGE_THICKNESS, gridSize, gridToSolids, TILE, type TileGrid } from "./tiles.ts";
import { DOOR_UP_CARRY, type DoorSide, type World } from "./world.ts";

/**
 * Traversal checking: which surfaces and doors of a room the player can reach
 * with a set of abilities, and which rooms of a world.
 *
 * Nodes are standing surfaces (maximal runs the player can stand and walk
 * on), door entries (`in:<door>`) and door exits (`out:<door>`). Every move
 * between them is found by running a closed-loop input plan through the
 * movement simulator (the runtime's own physics) on the room's real
 * collision, from both ends of a one-step takeoff window (where walking can
 * stop you), so a move the checker reports can be replayed in the runtime
 * (routeInputs). Plans that are not tried are simply missing moves: the
 * checker errs on the side of "unreachable". The movement model's envelope
 * only decides which pairs are worth simulating.
 *
 * Hazards are never touched (a 1 px margin around them counts as touching).
 * Leaving the room anywhere but through a door fails a move. A ground pound
 * that smashes breakables moves to the same room with those groups gone
 * (node keys carry the smashed groups: `s3@1,2`); rooms start intact on every
 * entry.
 *
 * Door semantics (what the world runtime must match): entering through a
 * left/right door puts the feet 1 px inside the room at the opening's bottom;
 * a top door, centred in the opening just below the top edge, falling; a
 * bottom door, centred just above the bottom edge with `entryLift` px/s
 * upward speed (default 0). You leave through a door when your centre
 * crosses the room's edge with your whole box inside the opening.
 */

export interface TraversalOpening {
  id: string;
  side: DoorSide;
  /** Tiles from the top (left/right) or the left (top/bottom). */
  offset: number;
  size: number;
}

export interface TraversalOptions {
  ledgeThickness?: number;
  /** Upward speed when entering through a bottom door, px/s (default: what the runtime gives, enough to rise DOOR_UP_CARRY). */
  entryLift?: number;
  /** Longest single move, frames. */
  maxFrames?: number;
  /** More collision on top of the grid's (e.g. props that are solid in this game state). */
  extraSolids?: readonly Solid[];
}

/** Where the player can stand: feet at y, feet x anywhere in [x0, x1]. */
export interface StandingSurface {
  y: number;
  x0: number;
  x1: number;
  /** Feet x ranges with the whole box over one breakable area (where a ground pound smashes it). */
  pound: { x0: number; x1: number }[];
  /** Ends you can walk off (false: a wall, a hazard or the room's edge). */
  open: [left: boolean, right: boolean];
}

/** Feet x range to steer into at feet height y (a surface, or the far side of a door). */
export interface MoveTarget {
  y: number;
  x0: number;
  x1: number;
}

/**
 * A closed-loop input plan; frame 0 is the first frame of the move (for a
 * standing start, an idle frame that settles you on the floor). Replayable:
 * the same plan from the same state gives the same inputs.
 */
export interface MovePlan {
  /** Heading: held while climbing, or when there is no target. */
  dir: 1 | -1;
  /** Steer toward this; once over it, stop steering and drop onto it. */
  target?: MoveTarget;
  /** While below the target's top, don't steer past this feet x (rise beside it, not into its underside or face). */
  standoff?: number;
  /** No horizontal input at all. */
  still?: boolean;
  /** Frame the jump is pressed. */
  jump?: number;
  /** Frames the jump is held (default: until each jump's apex). */
  hold?: number;
  /** Keep the jump held while falling (glides, with glide). */
  glide?: boolean;
  /** Frames mid-air jumps are pressed, or "apex" (as soon as you stop rising). */
  airJumps?: (number | "apex")[];
  dash?: number;
  /** Frame of a ground pound (down + jump). */
  pound?: number;
  /** Climb walls: hold `dir` and wall-jump each time you touch the wall, until above the target. */
  climb?: boolean;
}

export type TraversalMoveKind = "enter" | "walk" | "drop" | "jump" | "climb" | "pound";

export interface TraversalMove {
  from: string;
  to: string;
  kind: TraversalMoveKind;
  /** Feet x range on the `from` surface to start from, standing still (both ends verified); null: from the entry state. */
  window: [number, number] | null;
  plan: MovePlan;
}

export interface RoomGraph {
  width: number;
  height: number;
  params: MovementParams;
  abilities: MovementAbility[];
  doors: TraversalOpening[];
  /** Surfaces of the intact room (keys s0, s1, ...). */
  surfaces: StandingSurface[];
  /** Moves out of a node, found on first use and cached. */
  moves(node: string): TraversalMove[];
  /** The surface a key names (any smash state). */
  surface(node: string): StandingSurface | undefined;
  /** The starting state of an entry node (`in:<door>`, or one added with addStart). */
  entry(node: string): MoveState | undefined;
  /** Add an entry node at a point (feet), e.g. the world start. */
  addStart(node: string, x: number, y: number, vy?: number): string;
  /** The collision for a smash state ("" = intact). */
  solids(mask?: string): Solid[];
}

const EPS = 1e-6;
const HAZARD_MARGIN = 1;

type Held = { left: boolean; right: boolean; down: boolean; jump: boolean; dash: boolean };
const IDLE: Held = { left: false, right: false, down: false, jump: false, dash: false };

const toInput = (h: Held, prev: Held): FrameInput => ({
  left: h.left,
  right: h.right,
  down: h.down,
  jump: h.jump,
  jumpPressed: h.jump && !prev.jump,
  jumpReleased: !h.jump && prev.jump,
  dashPressed: h.dash && !prev.dash,
});

interface Ctx {
  p: MovementParams;
  d: Derived;
  model: MovementModel;
  has: Set<MovementAbility>;
  width: number;
  height: number;
  doors: TraversalOpening[];
  hw: number;
  step: number;
  maxFrames: number;
}

interface Geo {
  mask: string;
  near: Near;
  solids: Solid[];
  hazards: Solid[];
  surfaces: StandingSurface[];
}

// ---------------------------------------------------------------- surfaces

type Span = [number, number];

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s[0] <= last[1] + EPS) last[1] = Math.max(last[1], s[1]);
    else out.push([...s]);
  }
  return out;
}

/** Closed spans minus open spans. */
function subtractSpans(spans: Span[], cuts: Span[]): Span[] {
  let out = spans;
  for (const [a, b] of mergeSpans(cuts)) {
    out = out.flatMap(([x0, x1]): Span[] => {
      if (b <= x0 || a >= x1) return [[x0, x1]];
      const pieces: Span[] = [];
      if (a >= x0) pieces.push([x0, a]);
      if (b <= x1) pieces.push([b, x1]);
      return pieces;
    });
  }
  return out.filter(([a, b]) => b - a >= 0);
}

/** Standing surfaces: tops of solids, ledges, one-ways and breakables with room for the player's box and no hazard within the margin. */
export function standingSurfaces(solids: readonly Solid[], params: MovementParams, bounds?: { width: number; height: number }): StandingSurface[] {
  const hw = params.width / 2;
  const h = params.height;
  const standable = solids.filter((s) => s.kind !== "hazard");
  const levels = [...new Set(standable.map((s) => s.y))].sort((a, b) => a - b);
  const out: StandingSurface[] = [];
  for (const y of levels) {
    const tops = standable.filter((s) => s.y === y);
    const support = mergeSpans(tops.map((s) => [s.x - hw + 0.5, s.x + s.width + hw - 0.5]));
    const cuts: Span[] = [];
    for (const s of solids) {
      if (s.kind === "oneway") continue;
      const m = s.kind === "hazard" ? HAZARD_MARGIN : 0;
      if (s.y - m < y - EPS && s.y + s.height + m > y - h + EPS) cuts.push([s.x - hw - m, s.x + s.width + hw + m]);
      else if (m && s.y - m < y && s.y + s.height + m > y - h) cuts.push([s.x - hw - m, s.x + s.width + hw + m]);
    }
    const groups = new Map<number, Span[]>();
    for (const s of tops) if (s.kind === "breakable") groups.set(s.group ?? -1, [...(groups.get(s.group ?? -1) ?? []), [s.x, s.x + s.width]]);
    const poundSpans = [...groups.values()].flatMap((spans) => mergeSpans(spans).map(([a, b]): Span => [a + hw, b - hw])).filter(([a, b]) => b >= a);
    if (bounds && (y - h / 2 < 0 || y - h / 2 > bounds.height)) continue;
    const inside = bounds ? subtractSpans(support, [[-Infinity, 0], [bounds.width, Infinity]]) : support;
    const ends = new Set([...support.flat(), 0, bounds?.width ?? 0]);
    for (const [x0, x1] of subtractSpans(inside, cuts)) {
      const pound = poundSpans.map(([a, b]) => ({ x0: Math.max(a, x0), x1: Math.min(b, x1) })).filter((s) => s.x1 >= s.x0);
      out.push({ y, x0, x1, pound, open: [ends.has(x0), ends.has(x1)] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- running plans

function steer(s: MoveState, plan: MovePlan, ctx: Ctx): number {
  const t = plan.target!;
  const m = Math.min(4, (t.x1 - t.x0) / 2);
  const lo = t.x0 + m;
  const hi = t.x1 - m;
  let aim = s.x < lo ? lo : s.x > hi ? hi : s.x;
  if (plan.standoff !== undefined && s.y > t.y + 0.01) aim = s.x < lo ? Math.min(aim, plan.standoff) : s.x > hi ? Math.max(aim, plan.standoff) : aim;
  const dx = aim - s.x;
  return Math.abs(dx) <= ctx.step / 2 ? 0 : Math.sign(dx);
}

/** The plan as a per-frame controller (stateful: create one per run). */
function controller(plan: MovePlan, ctx: Ctx) {
  const releases = new Set<number>();
  const presses = new Set<number>();
  for (const k of plan.airJumps ?? []) if (typeof k === "number") (releases.add(k - 1), presses.add(k));
  if (plan.pound !== undefined) (releases.add(plan.pound - 1), presses.add(plan.pound));
  let apex: "wait" | "press" | "done" = plan.airJumps?.includes("apex") ? "wait" : "done";
  let prev = IDLE;
  let heldFor = 0;
  return (s: MoveState, f: number): Held => {
    let jump = prev.jump;
    const start = plan.jump;
    if (start === undefined || f < start) jump = false;
    else if (plan.climb) {
      if (f === start) jump = true;
      else if (jump && heldFor >= 4 && !s.onFloor && s.wallFrames > 0) jump = false;
      else if (!jump) jump = true;
    } else {
      if (f === start) jump = true;
      else if (plan.hold !== undefined && f === start + plan.hold) jump = false;
      if (releases.has(f)) jump = false;
      if (presses.has(f)) jump = true;
      if (apex === "press") (jump = true), (apex = "done");
      else if (apex === "wait" && f > start && s.vy >= 0) (jump = false), (apex = "press");
      if (!plan.glide && jump && prev.jump && s.vy >= 0) jump = false;
    }
    heldFor = jump && prev.jump ? heldFor + 1 : 0;
    let dir: number;
    if (plan.still) dir = 0;
    else if (plan.climb && (!plan.target || s.y > plan.target.y - 2)) dir = plan.dir;
    else if (plan.target) dir = steer(s, plan, ctx);
    else dir = plan.dir;
    const dash = plan.dash === f;
    if (dash && dir === 0) dir = plan.dir;
    const held = { left: dir < 0, right: dir > 0, down: plan.pound !== undefined && f >= plan.pound, jump, dash };
    prev = held;
    return held;
  };
}

/** How a run ended; `frames`: the last frame the plan controlled. */
type Ending = ({ kind: "land"; state: MoveState } | { kind: "exit"; door: string; state: MoveState } | { kind: "fail"; why: string; state: MoveState }) & { frames: number };

function touchesHazard(s: MoveState, hazards: readonly Solid[], ctx: Ctx): boolean {
  const l = s.x - ctx.hw - HAZARD_MARGIN;
  const r = s.x + ctx.hw + HAZARD_MARGIN;
  const t = s.y - ctx.p.height - HAZARD_MARGIN;
  const b = s.y + HAZARD_MARGIN;
  return hazards.some((z) => l < z.x + z.width && r > z.x && t < z.y + z.height && b > z.y);
}

/** Outside the room: the door left through, "leak" if not through a door, null if still inside. */
function exited(s: MoveState, ctx: Ctx): string | null {
  const cy = s.y - ctx.p.height / 2;
  const side: DoorSide | null = s.x < 0 ? "left" : s.x > ctx.width ? "right" : cy < 0 ? "top" : cy > ctx.height ? "bottom" : null;
  if (!side) return null;
  const [lo, hi] = side === "left" || side === "right" ? [s.y - ctx.p.height, s.y] : [s.x - ctx.hw, s.x + ctx.hw];
  const door = ctx.doors.find((d) => d.side === side && lo >= d.offset * TILE - 0.01 && hi <= (d.offset + d.size) * TILE + 0.01);
  return door ? door.id : "leak";
}

/**
 * Run a plan from a state until you land (and come to rest), leave through
 * a door, touch a hazard, leak out of the room or run out of time. `world`
 * is mutated by smashes.
 */
function runPlan(ctx: Ctx, world: Solid[], hazards: readonly Solid[], start: MoveState, plan: MovePlan, entering: boolean, record?: { inputs: FrameInput[]; states: MoveState[] }, near?: Near): Ending {
  const ctl = controller(plan, ctx);
  let s = start;
  let prev = IDLE;
  let airborne = entering;
  const box = { x0: s.x, x1: s.x, y0: s.y, y1: s.y };
  let idle = 0;
  for (let f = 0; f < ctx.maxFrames; f++) {
    if (near && f % NEAR_FRAMES === 0) {
      world = near(s.x - NEAR - ctx.hw, s.y - ctx.p.height - NEAR, s.x + NEAR + ctx.hw, s.y + NEAR);
      hazards = world.filter((z) => z.kind === "hazard");
    }
    // Stuck (standing at a wall, bouncing under a ceiling): no new ground covered in 45 frames, not counting falls.
    if (s.x < box.x0 - 0.5 || s.x > box.x1 + 0.5 || s.y < box.y0 - 0.5 || s.y > box.y1 + 0.5) {
      (box.x0 = Math.min(box.x0, s.x)), (box.x1 = Math.max(box.x1, s.x)), (box.y0 = Math.min(box.y0, s.y)), (box.y1 = Math.max(box.y1, s.y));
      idle = 0;
    } else if ((s.onFloor || s.vy <= 0) && ++idle > 45) return { kind: "fail", why: "stuck", state: s, frames: f - 1 };
    // A standing start's frame 0 settles you (as validated); nothing acts yet.
    const held = !entering && f === 0 ? (ctl(s, f), IDLE) : ctl(s, f);
    const input = toInput(held, prev);
    prev = held;
    s = stepMovement(s, input, ctx.p, ctx.d, world);
    if (record) record.inputs.push(input), record.states.push(s);
    if (touchesHazard(s, hazards, ctx)) return { kind: "fail", why: "hazard", state: s, frames: f };
    const out = exited(s, ctx);
    if (out === "leak") return { kind: "fail", why: "leak", state: s, frames: f };
    if (out) return { kind: "exit", door: out, state: s, frames: f };
    // Falling below a target's top with no jumps left: it is missed (whatever this lands on is found directly).
    if (plan.target && !plan.climb && !s.onFloor && s.vy > 0 && s.y > plan.target.y + 1 && s.airJumps === 0) return { kind: "fail", why: "missed", state: s, frames: f };
    if (!s.onFloor) airborne = true;
    else if (airborne && !s.pounding && s.dashFrames === 0 && s.kickFrames === 0) {
      // Come to rest: pound recovery, then a frame with the jump released.
      for (let k = 0; k < 20 && (s.poundRecover > 0 || prev.jump || k === 0); k++) {
        const input = toInput(IDLE, prev);
        prev = IDLE;
        s = stepMovement(s, input, ctx.p, ctx.d, world);
        if (record) record.inputs.push(input), record.states.push(s);
        if (touchesHazard(s, hazards, ctx)) return { kind: "fail", why: "hazard", state: s, frames: f };
      }
      return s.onFloor ? { kind: "land", state: s, frames: f } : { kind: "fail", why: "unsettled", state: s, frames: f };
    }
  }
  return { kind: "fail", why: "timeout", state: s, frames: ctx.maxFrames };
}

/** Solids touching a rectangle (x0, y0, x1, y1). */
type Near = (x0: number, y0: number, x1: number, y1: number) => Solid[];
/** Runs collide only with solids within NEAR px of the box, refreshed every NEAR_FRAMES frames (exact: nothing moves NEAR px that fast). */
const NEAR = 128;
const NEAR_FRAMES = 4;
const CELL = 128;

function spatialIndex(solids: readonly Solid[]): Near {
  const cells = new Map<number, number[]>();
  const key = (cx: number, cy: number) => (cx + 4096) * 8192 + cy + 4096;
  solids.forEach((s, i) => {
    for (let cx = Math.floor(s.x / CELL); cx <= Math.floor((s.x + s.width) / CELL); cx++) {
      for (let cy = Math.floor(s.y / CELL); cy <= Math.floor((s.y + s.height) / CELL); cy++) {
        const k = key(cx, cy);
        const list = cells.get(k);
        if (list) list.push(i);
        else cells.set(k, [i]);
      }
    }
  });
  const seen = new Uint32Array(solids.length);
  let stamp = 0;
  return (x0, y0, x1, y1) => {
    stamp++;
    const out: Solid[] = [];
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        for (const i of cells.get(key(cx, cy)) ?? []) {
          if (seen[i] === stamp) continue;
          seen[i] = stamp;
          out.push(solids[i]!);
        }
      }
    }
    return out;
  };
}

/** Standing still on the floor at x, timers clear: the state a walk-and-wait reaches. */
function standing(ctx: Ctx, world: Solid[], x: number, y: number): MoveState {
  let s = initialState(x, y);
  for (let k = 0; k < 2; k++) s = stepMovement(s, {}, ctx.p, ctx.d, world);
  return s;
}

// ---------------------------------------------------------------- the graph

const surfaceKey = (index: number, mask: string) => (mask ? `s${index}@${mask}` : `s${index}`);
function parseSurfaceKey(node: string): { index: number; mask: string } | null {
  const m = /^s(\d+)(?:@([\d,]+))?$/.exec(node);
  return m ? { index: Number(m[1]), mask: m[2] ?? "" } : null;
}

/** The start state for entering through a door (see the semantics above). */
export function doorEntry(door: TraversalOpening, width: number, height: number, params: MovementParams, entryLift = 0): { x: number; y: number; vy: number } {
  const hw = params.width / 2;
  const a = door.offset * TILE;
  const b = (door.offset + door.size) * TILE;
  switch (door.side) {
    case "left":
      return { x: hw + 1, y: b, vy: 0 };
    case "right":
      return { x: width - hw - 1, y: b, vy: 0 };
    case "top":
      return { x: (a + b) / 2, y: params.height + 1, vy: 0 };
    case "bottom":
      return { x: (a + b) / 2, y: height - 1, vy: -entryLift };
  }
}

/** What to steer into to leave through a door. */
function doorTarget(door: TraversalOpening, ctx: Ctx): MoveTarget {
  const a = door.offset * TILE;
  const b = (door.offset + door.size) * TILE;
  const { hw } = ctx;
  switch (door.side) {
    case "left":
      return { y: b, x0: -1000, x1: -2 };
    case "right":
      return { y: b, x0: ctx.width + 2, x1: ctx.width + 1000 };
    case "top":
      return { y: 0, x0: a + hw + 1, x1: b - hw - 1 };
    case "bottom":
      return { y: ctx.height + ctx.p.height, x0: a + hw + 1, x1: b - hw - 1 };
  }
}

interface Candidate {
  key: string;
  t: MoveTarget;
  /** Can be approached from below (one-way surfaces, top doors). */
  passable: boolean;
}

export function roomGraph(grid: TileGrid, doors: readonly TraversalOpening[], params: MovementParams, abilities: readonly MovementAbility[], options: TraversalOptions = {}): RoomGraph {
  const { width, height } = gridSize(grid);
  const base: Solid[] = [...gridToSolids(grid, options.ledgeThickness ?? DEFAULT_LEDGE_THICKNESS), ...(options.extraSolids ?? [])];
  const ability = [...new Set(abilities)];
  const ctx: Ctx = {
    p: params,
    d: deriveMovement(params, ability),
    model: movementModel(params, ability),
    has: new Set(ability),
    width,
    height,
    doors: [...doors],
    hw: params.width / 2,
    step: params.runSpeed / MOVEMENT_FPS,
    maxFrames: options.maxFrames ?? 1500,
  };

  const geos = new Map<string, Geo>();
  const geo = (mask: string): Geo => {
    let g = geos.get(mask);
    if (!g) {
      const smashed = new Set(mask ? mask.split(",").map(Number) : []);
      const solids = base.filter((s) => !(s.kind === "breakable" && smashed.has(s.group ?? -1)));
      g = { mask, solids, hazards: solids.filter((s) => s.kind === "hazard"), surfaces: standingSurfaces(solids, params, { width, height }), near: spatialIndex(solids) };
      geos.set(mask, g);
    }
    return g;
  };
  const maskOf = (world: Solid[], given: Solid[], before: Geo): string => {
    if (world.length === given.length) return before.mask;
    const smashed = new Set(given.filter((s) => !world.includes(s)).map((s) => s.group));
    const left = new Set(before.solids.filter((s) => s.kind === "breakable" && !smashed.has(s.group)).map((s) => s.group));
    const gone = new Set(base.filter((s) => s.kind === "breakable" && !left.has(s.group)).map((s) => s.group!));
    return [...gone].sort((a, b) => a - b).join(",");
  };
  const surfaceAt = (g: Geo, x: number, y: number) => g.surfaces.findIndex((s) => Math.abs(s.y - y) < 1e-6 && x >= s.x0 - 1e-6 && x <= s.x1 + 1e-6);

  const starts = new Map<string, MoveState>();
  const addStart = (node: string, x: number, y: number, vy = 0) => {
    starts.set(node, { ...initialState(x, y), vy });
    return node;
  };
  for (const door of doors) {
    const e = doorEntry(door, width, height, params, options.entryLift ?? Math.sqrt(2 * params.gravity * DOOR_UP_CARRY));
    addStart(`in:${door.id}`, e.x, e.y, e.vy);
  }

  /** Run a plan; the node it ends at, or null. */
  const attempt = (g: Geo, start: MoveState, plan: MovePlan, entering = false, trace?: number[]): string | null => {
    // Pounds smash solids out of the list they run on: give them a whole copy.
    const pound = plan.pound !== undefined;
    const world = pound ? [...g.solids] : g.solids;
    const record = trace ? { inputs: [], states: [] } : undefined;
    const end = runPlan(ctx, world, g.hazards, start, plan, entering, record, pound ? undefined : g.near);
    if (trace && record) trace.push(start.x, ...record.states.slice(0, end.frames + 1).map((s: MoveState) => s.x));
    if (end.kind === "exit") return `out:${end.door}`;
    if (end.kind !== "land") return null;
    const after = geo(maskOf(world, g.solids, g));
    const i = surfaceAt(after, end.state.x, end.state.y);
    return i < 0 ? null : surfaceKey(i, after.mask);
  };

  const candidateCache = new Map<string, Candidate[]>();
  const candidates = (g: Geo, except: string): Candidate[] => {
    let all = candidateCache.get(g.mask);
    if (!all) {
      const oneWay = (s: StandingSurface) => g.solids.every((r) => r.y !== s.y || r.kind === "oneway" || r.x >= s.x1 + ctx.hw || r.x + r.width <= s.x0 - ctx.hw);
      all = [
        ...g.surfaces.map((s, i) => ({ key: surfaceKey(i, g.mask), t: { y: s.y, x0: s.x0, x1: s.x1 }, passable: oneWay(s) })),
        ...doors.map((d) => ({ key: `out:${d.id}`, t: doorTarget(d, ctx), passable: d.side === "top" || d.side === "bottom" })),
      ];
      candidateCache.set(g.mask, all);
    }
    return all.filter((c) => c.key !== except);
  };

  /** Worth simulating, per the movement model's envelope (generous: walls can refresh dashes and jumps). */
  const inReach = (a: StandingSurface, t: MoveTarget, door: boolean): boolean => {
    const rise = door && t.y === 0 ? a.y - params.height / 2 : a.y - t.y;
    if (rise > ctx.model.maxHeight + 2) return false;
    const gap = t.x0 > a.x1 ? t.x0 - a.x1 : t.x1 < a.x0 ? a.x0 - t.x1 : 0;
    return gap <= 0 || ctx.model.maxGap(Math.min(t.y - a.y, 1200)) + 96 >= gap;
  };

  const surfaceMoves = (index: number, mask: string): TraversalMove[] => {
    const g = geo(mask);
    const a = g.surfaces[index]!;
    const from = surfaceKey(index, mask);
    const found = new Map<string, TraversalMove>();
    const fits = a.x1 - a.x0 >= ctx.step * 1.001;

    /** Try a plan from both ends of a takeoff window; returns where it went. */
    const tryFrom = (x: number, dir: number, plan: MovePlan, kind: TraversalMoveKind): string | null => {
      const w = ctx.step * 1.001;
      let window: [number, number];
      if (!fits) window = [a.x0, a.x1];
      else if (dir > 0) window = x - w < a.x0 ? [a.x0, a.x0 + w] : [x - w, x];
      else window = x + w > a.x1 ? [a.x1 - w, a.x1] : [x, x + w];
      const near = dir > 0 ? window[1] : window[0];
      const first = outcome(near, plan);
      const to = first.to;
      if (!to || to === from || found.has(to)) return to;
      const other = outcome(dir > 0 ? window[0] : window[1], first.plan);
      if (other.to !== to) return null;
      const k: TraversalMoveKind = kind === "drop" && to.startsWith("out:") && !doors.some((d) => `out:${d.id}` === to && (d.side === "top" || d.side === "bottom")) ? "walk" : kind;
      found.set(to, { from, to, kind: k, window, plan: first.plan });
      return to;
    };

    // Steering toward a target is "hold dir" until you get near it, so runs without a
    // standoff share one untargeted run up to there: if that run ends first, so does this one.
    const untargeted = new Map<string, { to: string | null; xs: number[] }>();
    const outcome = (x: number, plan: MovePlan): { to: string | null; plan: MovePlan } => {
      const start = standing(ctx, g.solids, x, a.y);
      const t = plan.target;
      if (!t || plan.climb || plan.still || plan.standoff !== undefined) return { to: attempt(g, start, plan), plan };
      const free: MovePlan = { ...plan };
      delete free.target;
      const key = `${x}|${JSON.stringify(free)}`;
      let ref = untargeted.get(key);
      if (!ref) {
        const xs: number[] = [];
        ref = { to: attempt(g, start, free, false, xs), xs };
        untargeted.set(key, ref);
      }
      const m = Math.min(4, (t.x1 - t.x0) / 2);
      const turns = ref.xs.findIndex((px) => (plan.dir > 0 ? px >= t.x0 + m - ctx.step / 2 : px <= t.x1 - m + ctx.step / 2));
      // xs[f] is x before frame f; the run's last controlled frame is xs.length - 2.
      if (turns < 0 || turns > ref.xs.length - 2) return { to: ref.to, plan: free };
      return { to: attempt(g, start, plan), plan };
    };

    for (const c of candidates(g, from)) {
      if (found.has(c.key) || !inReach(a, c.t, c.key.startsWith("out:"))) continue;
      const dy = c.t.y - a.y;
      // Special timings can't beat the model's open-air envelope (walls aside).
      const gap = c.t.x0 > a.x1 ? c.t.x0 - a.x1 : c.t.x1 < a.x0 ? a.x0 - c.t.x1 : 0;
      const special = gap <= 0 || ctx.model.canCross(gap, Math.min(dy, 1200));
      for (const { x, dir, edge } of takeoffs(a, c, ctx)) {
        if (found.has(c.key)) break;
        // A plain try that lands on something else on the way: the target is behind it (conservative).
        // Any landing at all: special timings are not worth it.
        let landed = false;
        let elsewhere = false;
        for (const [plan, kind, tier] of variants(c, x, dir, dy, edge, a.open[dir > 0 ? 1 : 0] && x === (dir > 0 ? a.x1 : a.x0), ctx)) {
          if ((tier > 0 && elsewhere) || (tier > 1 && (landed || !special))) break;
          const to = tryFrom(x, dir, plan, kind);
          if (to === c.key) break;
          if (to) landed = true;
          if (to && to !== from && tier === 0) elsewhere = true;
        }
      }
    }

    if (ctx.model.climbsWalls) {
      for (const dir of [1, -1] as const) {
        const x = dir > 0 ? a.x1 : a.x0;
        tryFrom(x, dir, { dir, climb: true, jump: 1 }, "climb");
        if (a.open[dir > 0 ? 1 : 0]) continue;
        for (const c of candidates(g, from)) {
          if (found.has(c.key) || c.t.y >= a.y - ctx.model.maxHeight || Math.min(Math.abs(c.t.x0 - x), Math.abs(c.t.x1 - x)) > 600) continue;
          tryFrom(x, dir, { dir, climb: true, jump: 1, target: c.t }, "climb");
        }
      }
    }

    if (ctx.has.has("ground_pound")) {
      for (const span of a.pound) {
        const x = Math.min(span.x1, (span.x0 + span.x1) / 2 + ctx.step / 2);
        if (x - ctx.step * 1.001 < span.x0 - 1e-9) continue;
        tryFrom(x, 1, { dir: 1, still: true, jump: 1, hold: 6, pound: 9 }, "pound");
      }
    }
    return [...found.values()];
  };

  const entryMoves = (node: string): TraversalMove[] => {
    const start = starts.get(node)!;
    const g = geo("");
    const still: MovePlan = { dir: 1, still: true };
    const ending = runPlan(ctx, g.solids, g.hazards, start, still, true);
    if (ending.kind === "land" && Math.abs(ending.state.y - start.y) < 2 && Math.abs(ending.state.x - start.x) < 1e-6) {
      const i = surfaceAt(g, ending.state.x, ending.state.y);
      return i < 0 ? [] : [{ from: node, to: surfaceKey(i, ""), kind: "enter", window: null, plan: still }];
    }
    const found = new Map<string, TraversalMove>();
    const add = (plan: MovePlan, kind: TraversalMoveKind) => {
      const to = attempt(g, start, plan, true);
      if (to && !found.has(to)) found.set(to, { from: node, to, kind, window: null, plan });
      return to;
    };
    add(still, "drop");
    for (const c of candidates(g, "")) {
      if (found.has(c.key)) continue;
      const dir = (c.t.x0 + c.t.x1) / 2 >= start.x ? 1 : -1;
      const plans: MovePlan[] = [{ dir, target: c.t }];
      if (ctx.has.has("glide")) plans.push({ dir, target: c.t, jump: 0, glide: true });
      for (const plan of plans) if (add(plan, "drop") === c.key) break;
    }
    return [...found.values()];
  };

  const cache = new Map<string, TraversalMove[]>();
  return {
    width,
    height,
    params,
    abilities: ability,
    doors: [...doors],
    surfaces: geo("").surfaces,
    moves(node) {
      let moves = cache.get(node);
      if (!moves) {
        const s = parseSurfaceKey(node);
        moves = s ? (geo(s.mask).surfaces[s.index] ? surfaceMoves(s.index, s.mask) : []) : starts.has(node) ? entryMoves(node) : [];
        cache.set(node, moves);
      }
      return moves;
    },
    surface(node) {
      const s = parseSurfaceKey(node);
      return s ? geo(s.mask).surfaces[s.index] : undefined;
    },
    entry: (node) => starts.get(node),
    addStart,
    solids: (mask = "") => geo(mask).solids,
  };
}

/** Where to take off from to reach a candidate (feet x, heading, at an edge?). */
function takeoffs(a: StandingSurface, c: Candidate, ctx: Ctx): { x: number; dir: 1 | -1; edge: boolean }[] {
  const t = c.t;
  if (t.x0 > a.x1) return [{ x: a.x1, dir: 1, edge: true }];
  if (t.x1 < a.x0) return [{ x: a.x0, dir: -1, edge: true }];
  if (t.y > a.y) return [{ x: a.x1, dir: 1, edge: true }, { x: a.x0, dir: -1, edge: true }];
  const out: { x: number; dir: 1 | -1; edge: boolean }[] = [];
  const add = (x: number, dir: 1 | -1) => {
    const at = Math.min(a.x1, Math.max(a.x0, x));
    if (!out.some((o) => o.dir === dir && Math.abs(o.x - at) < ctx.step)) out.push({ x: at, dir, edge: false });
  };
  add(t.x0 - 3, 1);
  add(t.x1 + 3, -1);
  if (c.passable) add((Math.max(a.x0, t.x0) + Math.min(a.x1, t.x1)) / 2, 1);
  return out;
}

/** Plans to try toward a candidate, cheapest and likeliest first. */
function* variants(c: Candidate, x: number, dir: 1 | -1, dy: number, edge: boolean, open: boolean, ctx: Ctx): Generator<[MovePlan, TraversalMoveKind, number]> {
  const t = c.t;
  const standoff = dy < 0 && !c.passable ? x : undefined;
  if (dy >= 0 && edge && open) {
    yield [{ dir, target: t }, "drop", 0];
    // A surface below that reaches past this edge: steer to its part beyond the edge (else you are already "over" it and never walk off).
    const beyond = dir > 0 ? { ...t, x0: Math.max(t.x0, x + 2 * ctx.hw + 2) } : { ...t, x1: Math.min(t.x1, x - 2 * ctx.hw - 2) };
    if (beyond.x1 - beyond.x0 > 8 && (beyond.x0 !== t.x0 || beyond.x1 !== t.x1)) yield [{ dir, target: beyond }, "drop", 0];
  }
  yield [{ dir, target: t, jump: 1, standoff }, "jump", 0];
  if (ctx.has.has("double_jump")) yield [{ dir, target: t, jump: 1, airJumps: ["apex"], standoff }, "jump", 1];
  if (standoff !== undefined) yield [{ dir, target: t, jump: 1 }, "jump", 1];
  if (ctx.has.has("glide")) yield [{ dir, target: t, jump: 1, glide: true, standoff }, "jump", 1];
  if (edge) {
    const s = ctx.model.strategy(Math.min(dy, 1200));
    if (s && (s.airJumps.length || s.dash !== null || s.jumpDelay)) {
      const at = 1 + s.jumpDelay;
      yield [{ dir, target: t, jump: at, glide: true, airJumps: s.airJumps.map((k) => at + k), ...(s.dash !== null && { dash: at + s.dash }) }, "jump", 1];
    }
  }
  if (ctx.has.has("double_jump")) for (let k = 4; k <= 60; k += 3) yield [{ dir, target: t, jump: 1, airJumps: [1 + k], glide: true, standoff }, "jump", 2];
  if (ctx.has.has("dash")) {
    for (const k of [2, 6, 12]) yield [{ dir, target: t, jump: 1, dash: 1 + k, standoff }, "jump", 2];
    if (edge) yield [{ dir, target: t, dash: 1 }, "jump", 2];
  }
  for (const hold of [4, 10]) yield [{ dir, target: t, jump: 1, hold, standoff }, "jump", 2];
}

// ---------------------------------------------------------------- reachability

function search(graph: RoomGraph, from: string, stop?: string): Map<string, TraversalMove | null> {
  const seen = new Map<string, TraversalMove | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const node = queue.shift()!;
    if (node === stop) break;
    for (const move of graph.moves(node)) {
      if (seen.has(move.to)) continue;
      seen.set(move.to, move);
      queue.push(move.to);
    }
  }
  return seen;
}

/** Every node reachable from `from` (including it). */
export function reachableFrom(graph: RoomGraph, from: string): Set<string> {
  return new Set(search(graph, from).keys());
}

/** The moves of a shortest route (fewest moves), or null. */
export function findRoute(graph: RoomGraph, from: string, to: string): TraversalMove[] | null {
  const seen = search(graph, from, to);
  if (!seen.has(to)) return null;
  const route: TraversalMove[] = [];
  for (let m = seen.get(to); m; m = seen.get(m.from)) route.unshift(m);
  return route;
}

export function roomTraversal(room: { grid: TileGrid; doors: readonly TraversalOpening[] }, params: MovementParams, abilities: readonly MovementAbility[], options?: TraversalOptions) {
  const graph = roomGraph(room.grid, room.doors, params, abilities, options);
  const exits = Object.fromEntries(
    room.doors.map((d) => {
      const reached = reachableFrom(graph, `in:${d.id}`);
      return [d.id, room.doors.filter((e) => reached.has(`out:${e.id}`)).map((e) => e.id)];
    }),
  );
  return { graph, exits };
}

/** Can you get from one door of a room (entering through it) out through another? */
export function canTraverse(room: { grid: TileGrid; doors: readonly TraversalOpening[] }, from: string, to: string, params: MovementParams, abilities: readonly MovementAbility[], options?: TraversalOptions): boolean {
  return reachableFrom(roomGraph(room.grid, room.doors, params, abilities, options), `in:${from}`).has(`out:${to}`);
}

/** Rooms and doors reachable across door links, from the world's start (or a room door / point). */
export function worldTraversal(
  world: World,
  params: MovementParams,
  abilities: readonly MovementAbility[],
  start?: { room: string; door: string } | { room: string; x: number; y: number },
  options: TraversalOptions = {},
) {
  const graphs = new Map<string, RoomGraph>();
  const graphOf = (id: string) => {
    let g = graphs.get(id);
    if (!g) {
      const room = world.rooms.find((r) => r.id === id)!;
      g = roomGraph(room.grid, room.doors, params, abilities, { ledgeThickness: world.ledgeThickness, ...options });
      graphs.set(id, g);
    }
    return g;
  };
  const from = start ?? world.start;
  const rooms = new Set<string>();
  const exits = new Set<string>();
  if (!from || !world.rooms.some((r) => r.id === from.room)) return { rooms, exits };
  const first = "door" in from ? `in:${from.door}` : graphOf(from.room).addStart("start", from.x, from.y);
  const queue: [string, string][] = [[from.room, first]];
  const done = new Set<string>();
  while (queue.length) {
    const [roomId, node] = queue.shift()!;
    if (done.has(`${roomId}/${node}`)) continue;
    done.add(`${roomId}/${node}`);
    rooms.add(roomId);
    const room = world.rooms.find((r) => r.id === roomId)!;
    const reached = reachableFrom(graphOf(roomId), node);
    for (const door of room.doors) {
      if (!reached.has(`out:${door.id}`)) continue;
      exits.add(`${roomId}/${door.id}`);
      if (door.to && world.rooms.some((r) => r.id === door.to!.room)) queue.push([door.to.room, `in:${door.to.door}`]);
    }
  }
  return { rooms, exits };
}

/** Does an ability gate hold: reachable with it, not without it? */
export function gateCheck(reaches: (abilities: MovementAbility[]) => boolean, abilities: readonly MovementAbility[], ability: MovementAbility) {
  const withIt = reaches([...new Set([...abilities, ability])]);
  const without = reaches(abilities.filter((a) => a !== ability));
  return { withAbility: withIt, without, holds: withIt && !without };
}

// ---------------------------------------------------------------- replay

/**
 * The frame-by-frame inputs that play a route from its first node: walk into
 * each takeoff window, wait for timers to clear, then run each move's plan.
 * Simulated on the room's collision; `ok` says whether every move ended where
 * the graph says.
 */
export function routeInputs(graph: RoomGraph, route: readonly TraversalMove[]) {
  const p = graph.params;
  const d = deriveMovement(p, graph.abilities);
  const ctx: Ctx = {
    p,
    d,
    model: movementModel(p, graph.abilities),
    has: new Set(graph.abilities),
    width: graph.width,
    height: graph.height,
    doors: graph.doors,
    hw: p.width / 2,
    step: p.runSpeed / MOVEMENT_FPS,
    maxFrames: 1500,
  };
  const world = [...graph.solids("")];
  const hazards = world.filter((s) => s.kind === "hazard");
  const first = route[0] ? graph.entry(route[0].from) : undefined;
  const firstSurface = route[0] ? graph.surface(route[0].from) : undefined;
  let s: MoveState = first ? { ...first } : standing(ctx, world, route[0]?.window?.[0] ?? 0, firstSurface?.y ?? 0);
  const start = { x: s.x, y: s.y, vy: s.vy };
  const record = { inputs: [] as FrameInput[], states: [] as MoveState[] };
  let prev = IDLE;
  const push = (held: Held) => {
    const input = toInput(held, prev);
    prev = held;
    s = stepMovement(s, input, p, d, world);
    record.inputs.push(input);
    record.states.push(s);
  };
  const idle = (n: number) => {
    for (let k = 0; k < n; k++) push(IDLE);
  };
  const wait = Math.max(d.dashCooldownFrames, d.bufferFrames, toFrames(0.2)) + 2;
  let at = route[0]?.from ?? "";
  for (const move of route) {
    if (move.window) {
      if (!first || move !== route[0]) idle(wait);
      const [lo, hi] = move.window;
      for (let k = 0; k < 2000 && (s.x < lo - 1e-9 || s.x > hi + 1e-9); k++) push({ ...IDLE, right: s.x < lo, left: s.x > hi });
      idle(wait);
    }
    const end = runPlan(ctx, world, hazards, s, move.plan, !move.window, record);
    s = end.state;
    prev = IDLE;
    const ok = end.kind === "exit" ? move.to === `out:${end.door}` : end.kind === "land" && landsOn(graph, move.to, s);
    if (!ok) return { start, inputs: record.inputs, states: record.states, ok: false, at };
    at = move.to;
  }
  return { start, inputs: record.inputs, states: record.states, ok: true, at };
}

/**
 * Every state a move passes through, from its takeoff (standing at the near
 * end of its window, as the graph tried it first) or its entry state, to where
 * it ends (for what the player touches or can strike on the way).
 */
export function moveTrace(graph: RoomGraph, move: TraversalMove): MoveState[] {
  const p = graph.params;
  const ctx: Ctx = {
    p,
    d: deriveMovement(p, graph.abilities),
    model: movementModel(p, graph.abilities),
    has: new Set(graph.abilities),
    width: graph.width,
    height: graph.height,
    doors: graph.doors,
    hw: p.width / 2,
    step: p.runSpeed / MOVEMENT_FPS,
    maxFrames: 1500,
  };
  const world = [...graph.solids(parseSurfaceKey(move.from)?.mask ?? "")];
  const start = move.window ? standing(ctx, world, move.plan.dir > 0 ? move.window[1] : move.window[0], graph.surface(move.from)!.y) : graph.entry(move.from)!;
  const record = { inputs: [] as FrameInput[], states: [] as MoveState[] };
  runPlan(ctx, world, world.filter((s) => s.kind === "hazard"), start, move.plan, !move.window, record);
  return [start, ...record.states];
}

function landsOn(graph: RoomGraph, node: string, s: MoveState): boolean {
  const surface = graph.surface(node);
  return !!surface && Math.abs(surface.y - s.y) < 1e-6 && s.x >= surface.x0 - 1e-6 && s.x <= surface.x1 + 1e-6;
}
