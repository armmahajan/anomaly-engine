import { MOVEMENT_ABILITIES, type MovementAbility, type MovementParams } from "./params.ts";
import { deriveMovement, initialState, stepMovement, type FrameInput, type MoveState, type Solid } from "./simulate.ts";

/**
 * What the player can reach with a set of abilities, found by simulating
 * jump/double-jump/dash/glide timings off a ledge (./simulate.ts is the
 * runtime's own physics). Used to check that levels can be traversed and
 * that ability gates really need their ability.
 *
 * Gap = horizontal distance between the edge you leave and the edge you
 * land past; dy = how far below the takeoff surface the landing surface is
 * (negative = above). Ground dashes, pogo bounces and other tricks are not
 * counted, so the model errs on the side of "can't reach".
 */

export interface Strategy {
  /** Frames after reaching the ledge before jumping (0: jump at the edge; >0: run off, jump in coyote time). */
  jumpDelay: number;
  /** Frames after the jump at which each mid-air jump is pressed. */
  airJumps: number[];
  /** Frames after the jump at which to dash, or null. */
  dash: number | null;
}

export interface MovementModel {
  abilities: MovementAbility[];
  /** Highest the feet get above the takeoff surface, px. */
  maxHeight: number;
  /** Widest crossable gap for a landing dy px lower (negative: higher); -Infinity if unreachable. */
  maxGap(dy: number): number;
  canCross(gap: number, dy: number): boolean;
  /** The timing that achieves maxGap(dy), for replaying (tests, route bot). */
  strategy(dy: number): Strategy | null;
  /** Can climb a single wall by repeated wall jumps. */
  climbsWalls: boolean;
  /** Height gained per wall jump when climbing, px (0 without wall jump). */
  wallJumpGain: number;
  breaksFloors: boolean;
  dashDistance: number;
}

const DY_MIN = -800;
const DY_MAX = 1200;
const DY_STEP = 4;
const SAMPLES = (DY_MAX - DY_MIN) / DY_STEP + 1;
/** Ledge for launches: a floor to the left of x = 0, top at y = 0. */
export const LEDGE: readonly Solid[] = [{ x: -4000, y: 0, width: 4000, height: 100 }];

/** The inputs for a strategy launched off LEDGE (frame 0 lets the player settle on the floor). */
export function strategyInputs(s: Strategy, length: number): FrameInput[] {
  const jumpAt = 1 + s.jumpDelay;
  const releases = new Set(s.airJumps.map((k) => jumpAt + k - 1));
  const presses = new Set([jumpAt, ...s.airJumps.map((k) => jumpAt + k)]);
  const out: FrameInput[] = [];
  for (let f = 0; f < length; f++) {
    const jump = f >= jumpAt && !releases.has(f);
    const wasJump = f - 1 >= jumpAt && !releases.has(f - 1);
    out.push({
      right: f >= 1,
      jump,
      jumpPressed: presses.has(f),
      jumpReleased: !jump && wasJump,
      dashPressed: s.dash !== null && f === jumpAt + s.dash,
    });
  }
  return out;
}

/** Start position for launches: standing at the very edge of LEDGE. */
export const launchStart = (p: MovementParams) => ({ x: p.width / 2 - 0.5, y: 0 });

function* strategies(p: MovementParams, has: Set<MovementAbility>, coyoteFrames: number): Generator<Strategy> {
  const airJumpOptions: number[][] = [[]];
  if (has.has("double_jump")) {
    for (let k = 4; k <= 60; k += 3) airJumpOptions.push(Array.from({ length: p.tuning.doubleJump.jumps }, (_, i) => k * (i + 1)));
  }
  const dashOptions: (number | null)[] = [null];
  if (has.has("dash")) for (let u = 0; u <= 72; u += 3) dashOptions.push(u);
  for (let jumpDelay = 0; jumpDelay <= coyoteFrames; jumpDelay++) {
    for (const airJumps of airJumpOptions) for (const dash of dashOptions) yield { jumpDelay, airJumps, dash };
  }
}

const cache = new Map<string, MovementModel>();

export function movementModel(p: MovementParams, abilityList: readonly MovementAbility[]): MovementModel {
  const abilities = (Object.keys(MOVEMENT_ABILITIES) as MovementAbility[]).filter((a) => abilityList.includes(a));
  const key = JSON.stringify([p, abilities]);
  const hit = cache.get(key);
  if (hit) return hit;

  const d = deriveMovement(p, abilities);
  const best = new Array<number>(SAMPLES).fill(-Infinity);
  const bestStrategy = new Array<Strategy | null>(SAMPLES).fill(null);
  let maxHeight = 0;
  const hw = p.width / 2;
  const start = launchStart(p);

  for (const strategy of strategies(p, d.has, d.coyoteFrames)) {
    const inputs = strategyInputs(strategy, 400);
    let s: MoveState = initialState(start.x, start.y);
    const world = [...LEDGE];
    for (const input of inputs) {
      s = stepMovement(s, input, p, d, world);
      if (s.x - hw < 0) continue; // still over the ledge
      if (s.y > DY_MAX) break;
      maxHeight = Math.max(maxHeight, -s.y);
      const index = Math.max(0, Math.ceil((s.y - DY_MIN) / DY_STEP));
      const gap = s.x + hw;
      if (gap > best[index]!) {
        best[index] = gap;
        bestStrategy[index] = strategy;
      }
    }
  }
  // Anything reachable at some height is reachable lower down.
  for (let i = 1; i < SAMPLES; i++) {
    if (best[i - 1]! > best[i]!) {
      best[i] = best[i - 1]!;
      bestStrategy[i] = bestStrategy[i - 1]!;
    }
  }

  const sample = (dy: number) => (dy < DY_MIN ? -1 : Math.min(SAMPLES - 1, Math.floor((dy - DY_MIN) / DY_STEP)));
  const climb = wallClimb(p, abilities);
  const model: MovementModel = {
    abilities,
    maxHeight,
    maxGap: (dy) => (sample(dy) < 0 ? -Infinity : best[sample(dy)]!),
    canCross: (gap, dy) => sample(dy) >= 0 && gap <= best[sample(dy)]!,
    strategy: (dy) => (sample(dy) < 0 ? null : bestStrategy[sample(dy)]!),
    climbsWalls: climb.climbs,
    wallJumpGain: climb.gain,
    breaksFloors: abilities.includes("ground_pound"),
    dashDistance: abilities.includes("dash") ? p.tuning.dash.distance : 0,
  };
  cache.set(key, model);
  return model;
}

/** A wall to the right of x = 0 on a floor; the climber starts against it. */
export const WALL: readonly Solid[] = [
  { x: -1000, y: 0, width: 2000, height: 100 },
  { x: 0, y: -5000, width: 200, height: 5000 },
];

/**
 * Climb WALL: hold toward it, jump, and wall-jump again as soon as you are
 * back on it. Returns the inputs used (for replaying) and the heights of
 * each wall jump.
 */
export function wallClimbRun(p: MovementParams, abilities: readonly MovementAbility[], length = 240) {
  const d = deriveMovement(p, abilities);
  let s = initialState(-p.width / 2 - 1, 0);
  const world = [...WALL];
  const inputs: FrameInput[] = [];
  const jumpHeights: number[] = [];
  let jump = false;
  let heldFor = 0;
  for (let f = 0; f < length; f++) {
    let next: boolean = jump;
    if (f === 2) next = true;
    else if (jump && heldFor >= 4 && !s.onFloor && s.wallFrames > 0) next = false; // release, press next frame
    else if (!jump && f > 2) next = true;
    const input: FrameInput = { right: f >= 1, jump: next, jumpPressed: next && !jump, jumpReleased: !next && jump };
    heldFor = next && jump ? heldFor + 1 : 0;
    jump = next;
    inputs.push(input);
    const before = s;
    s = stepMovement(s, input, p, d, world);
    if (input.jumpPressed && f > 2 && s.kickFrames > 0 && before.kickFrames === 0) jumpHeights.push(-s.y);
  }
  return { inputs, jumpHeights };
}

function wallClimb(p: MovementParams, abilities: readonly MovementAbility[]) {
  if (!abilities.includes("wall_jump")) return { climbs: false, gain: 0 };
  const { jumpHeights } = wallClimbRun(p, abilities);
  if (jumpHeights.length < 3) return { climbs: false, gain: 0 };
  const gains = jumpHeights.slice(1).map((h, i) => h - jumpHeights[i]!);
  const gain = Math.min(...gains);
  return { climbs: gain > 1, gain: gain > 1 ? gain : 0 };
}
