import { toFrames, JUMP_CUT, MOVEMENT_FPS, POUND_RECOVERY_FRAMES, WALL_COYOTE_FRAMES, type MovementAbility, type MovementParams } from "./params.ts";

/**
 * Frame-by-frame player movement, a port of the movement half of
 * game/scripts/player.gd (no combat). Same order of operations, same
 * frame counters, axis-aligned boxes against solid rectangles.
 */

export interface Solid {
  x: number;
  y: number;
  width: number;
  height: number;
  /** oneway: only stops you falling onto its top; breakable: a ground pound smashes it (with its group). Default solid. */
  kind?: "solid" | "ledge" | "oneway" | "hazard" | "breakable";
  /** Breakable solids that smash together. */
  group?: number;
}

/** One physics frame of input: what is held, and what changed this frame. */
export interface FrameInput {
  left?: boolean;
  right?: boolean;
  down?: boolean;
  jump?: boolean;
  jumpPressed?: boolean;
  jumpReleased?: boolean;
  dashPressed?: boolean;
}

export interface MoveState {
  /** Feet (bottom-centre), y down. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  onFloor: boolean;
  onWall: boolean;
  /** +1: the wall is to the left (its face points right); -1: to the right. */
  wallNormal: number;
  coyote: number;
  buffer: number;
  airJumps: number;
  airDashes: number;
  dashFrames: number;
  dashDir: number;
  dashCooldown: number;
  kickFrames: number;
  kickDir: number;
  wallFrames: number;
  pounding: boolean;
  poundRecover: number;
  /** The solid under the feet after the last move. */
  floor: Solid | null;
}

export function initialState(x: number, y: number): MoveState {
  return {
    x, y, vx: 0, vy: 0, facing: 1, onFloor: false, onWall: false, wallNormal: 0,
    coyote: 0, buffer: 0, airJumps: 0, airDashes: 0, dashFrames: 0, dashDir: 1, dashCooldown: 0,
    kickFrames: 0, kickDir: 0, wallFrames: 0, pounding: false, poundRecover: 0, floor: null,
  };
}

const DT = 1 / MOVEMENT_FPS;

/** Derived per-frame constants (the runtime computes the same in setup()). */
export function deriveMovement(p: MovementParams, abilities: readonly MovementAbility[]) {
  const has = new Set(abilities);
  const dashFrames = Math.max(1, toFrames(p.tuning.dash.duration));
  return {
    has,
    coyoteFrames: toFrames(p.coyoteTime),
    bufferFrames: toFrames(p.jumpBuffer),
    dashFrames,
    dashSpeed: p.tuning.dash.distance / (dashFrames * DT),
    dashCooldownFrames: Math.max(dashFrames, toFrames(p.tuning.dash.cooldown)),
    kickFrames: toFrames(p.tuning.wallJump.kickTime),
    airJumps: has.has("double_jump") ? p.tuning.doubleJump.jumps : 0,
  };
}

export type Derived = ReturnType<typeof deriveMovement>;

/**
 * Advance one physics frame. Mirrors player.gd `_physics_process` (movement
 * part). A ground pound landing on a breakable solid removes it, and every
 * breakable solid of its group, from `world`.
 */
export function stepMovement(s: MoveState, input: FrameInput, p: MovementParams, d: Derived, world: Solid[]): MoveState {
  const n = { ...s };
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  n.buffer = Math.max(0, n.buffer - 1);
  n.dashCooldown = Math.max(0, n.dashCooldown - 1);
  n.kickFrames = Math.max(0, n.kickFrames - 1);
  n.wallFrames = Math.max(0, n.wallFrames - 1);
  n.poundRecover = Math.max(0, n.poundRecover - 1);
  if (n.onFloor) {
    n.coyote = d.coyoteFrames;
    n.airJumps = d.airJumps;
    n.airDashes = 1;
  } else {
    n.coyote = Math.max(0, n.coyote - 1);
  }

  if (n.dashFrames > 0) {
    n.vx = n.dashDir * d.dashSpeed;
    n.vy = 0;
    n.dashFrames -= 1;
  } else if (n.pounding) {
    n.vx = 0;
    n.vy = p.tuning.groundPound.speed;
  } else {
    if (!n.onFloor) n.vy = Math.min(n.vy + p.gravity * DT, p.maxFallSpeed);
    if (n.poundRecover > 0) n.vx = 0;
    else if (n.kickFrames > 0) n.vx = n.kickDir * p.tuning.wallJump.kickSpeed;
    else {
      n.vx = dir * p.runSpeed;
      if (dir !== 0) n.facing = dir;
    }

    if (input.jumpPressed) n.buffer = d.bufferFrames;
    if (n.buffer > 0) {
      if (n.onFloor || n.coyote > 0) {
        n.vy = -p.jumpVelocity;
        n.buffer = 0;
        n.coyote = 0;
      } else if (d.has.has("wall_jump") && n.wallFrames > 0) {
        n.vy = -p.tuning.wallJump.velocity;
        n.kickFrames = d.kickFrames;
        n.kickDir = n.wallNormal;
        n.vx = n.kickDir * p.tuning.wallJump.kickSpeed;
        n.facing = n.kickDir;
        n.buffer = 0;
        n.wallFrames = 0;
        n.airJumps = d.airJumps;
        n.airDashes = 1;
      } else if (input.jumpPressed && d.has.has("ground_pound") && input.down) {
        n.pounding = true;
        n.vx = 0;
        n.vy = p.tuning.groundPound.speed;
        n.buffer = 0;
      } else if (input.jumpPressed && n.airJumps > 0) {
        n.vy = -p.tuning.doubleJump.velocity;
        n.airJumps -= 1;
        n.buffer = 0;
      }
    }
    if (input.jumpReleased && n.vy < 0) n.vy *= JUMP_CUT;
    if (d.has.has("glide") && input.jump && !n.pounding && n.vy > p.tuning.glide.fallSpeed) n.vy = p.tuning.glide.fallSpeed;
    if (d.has.has("wall_jump") && !n.onFloor && n.onWall && dir === -n.wallNormal && n.vy > p.tuning.wallJump.slideSpeed) {
      n.vy = p.tuning.wallJump.slideSpeed;
    }
    if (d.has.has("dash") && input.dashPressed && n.dashCooldown === 0 && (n.onFloor || n.airDashes > 0) && !n.pounding) {
      n.dashDir = dir !== 0 ? dir : n.facing;
      n.facing = n.dashDir;
      n.dashFrames = d.dashFrames - 1;
      n.vx = n.dashDir * d.dashSpeed;
      n.vy = 0;
      n.dashCooldown = d.dashCooldownFrames;
      n.kickFrames = 0;
      if (!n.onFloor) n.airDashes -= 1;
    }
  }

  move(n, p, world);

  if (n.onFloor && n.pounding) {
    if (n.floor?.kind === "breakable") {
      const smashed = n.floor;
      for (let i = world.length - 1; i >= 0; i--) {
        const s = world[i]!;
        if (s === smashed || (smashed.group !== undefined && s.kind === "breakable" && s.group === smashed.group)) world.splice(i, 1);
      }
      n.floor = null;
    } else {
      n.pounding = false;
      n.poundRecover = POUND_RECOVERY_FRAMES;
    }
  }
  if (!n.onFloor && n.onWall && d.has.has("wall_jump") && dir === -n.wallNormal) {
    n.wallFrames = WALL_COYOTE_FRAMES;
    n.airJumps = d.airJumps;
    n.airDashes = 1;
  }
  return n;
}

const EPS = 1e-9;

/** Move by velocity * dt, sliding along solids. Sets floor/wall contact. player.gd `_move` is the same code. */
function move(n: MoveState, p: MovementParams, world: readonly Solid[]) {
  const wasOnFloor = n.onFloor;
  const hw = p.width / 2;
  n.onFloor = false;
  n.onWall = false;
  n.floor = null;
  let rx = n.vx * DT;
  let ry = n.vy * DT;
  for (let iteration = 0; iteration < 4 && (rx !== 0 || ry !== 0); iteration++) {
    const left = n.x - hw;
    const right = n.x + hw;
    const top = n.y - p.height;
    const bottom = n.y;
    let best = { t: Infinity, axis: "" as "x" | "y" | "", solid: null as Solid | null };
    for (const r of world) {
      // One-way platforms only catch you falling onto them from above.
      if (r.kind === "oneway" && !(ry > 0 && bottom <= r.y + EPS)) continue;
      const span = (lo: number, hi: number, motion: number, rLo: number, rHi: number): [number, number] | null => {
        if (motion > 0) return [(rLo - hi) / motion, (rHi - lo) / motion];
        if (motion < 0) return [(rHi - lo) / motion, (rLo - hi) / motion];
        return hi > rLo + EPS && lo < rHi - EPS ? [-Infinity, Infinity] : null;
      };
      const sx = span(left, right, rx, r.x, r.x + r.width);
      const sy = span(top, bottom, ry, r.y, r.y + r.height);
      if (!sx || !sy) continue;
      const entry = Math.max(sx[0], sy[0]);
      const exit = Math.min(sx[1], sy[1]);
      if (entry > exit - EPS || entry < -EPS || entry > 1) continue;
      if (sx[0] < -EPS && sy[0] < -EPS) continue;
      const axis = sx[0] > sy[0] ? "x" : "y";
      if (r.kind === "oneway" && axis === "x") continue;
      if (entry < best.t) best = { t: entry, axis, solid: r };
    }
    if (best.axis === "") {
      n.x += rx;
      n.y += ry;
      break;
    }
    const t = Math.max(0, best.t);
    n.x += rx * t;
    n.y += ry * t;
    if (best.axis === "x") {
      n.onWall = true;
      n.wallNormal = rx > 0 ? -1 : 1;
      n.vx = 0;
      rx = 0;
      ry *= 1 - t;
    } else {
      if (ry > 0) {
        n.onFloor = true;
        n.floor = best.solid;
      }
      n.vy = 0;
      ry = 0;
      rx *= 1 - t;
    }
  }
  // Floor snap: stay grounded while walking along a floor.
  if (!n.onFloor && wasOnFloor && n.vy >= 0) {
    for (const r of world) {
      if (r.y >= n.y - EPS && r.y <= n.y + 1 && n.x + hw > r.x + EPS && n.x - hw < r.x + r.width - EPS) {
        n.y = r.y;
        n.onFloor = true;
        n.floor = r;
        break;
      }
    }
  }
}

/** Run a whole input timeline; returns the state after every frame (index 0 = start). */
export function simulateMovement(
  p: MovementParams,
  abilities: readonly MovementAbility[],
  world: readonly Solid[],
  start: { x: number; y: number; facing?: number },
  inputs: readonly FrameInput[],
): MoveState[] {
  const d = deriveMovement(p, abilities);
  const solids = [...world];
  let s = { ...initialState(start.x, start.y), facing: start.facing ?? 1 };
  const states = [s];
  for (const input of inputs) {
    s = stepMovement(s, input, p, d, solids);
    states.push(s);
  }
  return states;
}
