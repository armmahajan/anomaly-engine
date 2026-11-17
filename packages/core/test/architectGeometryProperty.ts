import { expect } from "vitest";
import {
  buildRoom,
  composeAttempt,
  createDefaultProject,
  gridCols,
  gridRows,
  movementParams,
  MOVEMENT_ABILITIES,
  OPPOSITE,
  reachableFrom,
  roomGraph,
  unstandableRuns,
  type MovementAbility,
  type PlayerCharacter,
  type RoomRequest,
} from "../src/index.ts";
import { randomRequest, TestRng } from "./architectGeometryPlans.ts";

/**
 * The geometry property test: PLANS random room plans (random sizes, 1-4 links
 * on random sides, random knobs, gated links cycling through every movement
 * mechanic, one-way drops), sharded across test files so they run in parallel.
 *
 * For every plan: the room is built and proven (proveRoom: every door from
 * every other with no abilities, gated doors with exactly their abilities and
 * a way back, drops not climbable, no traps, no unstandable platforms, doors
 * not onto hazards), it has the right size and doors, it rebuilds identically
 * from its seed, and no platform is unstandable. Every SAMPLE-th plan (and
 every room under 1500 tiles; rooms up to 6000 tiles) is also re-checked here with the traversal
 * checker directly, independently of proveRoom.
 */

/** All 500 at merge points (ARCHITECT_PROPERTY_PLANS=500); the first 100 on everyday runs (same plans, same order). */
export const PLANS = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.ARCHITECT_PROPERTY_PLANS ?? 100);
export const SHARDS = 4;
const SAMPLE = 5;
const ALL = Object.keys(MOVEMENT_ABILITIES) as MovementAbility[];

const base = createDefaultProject();
export const params = movementParams(base.characters[0] as PlayerCharacter, base.world.gravity);

export function plans(): RoomRequest[] {
  const rng = new TestRng(20261117);
  return Array.from({ length: PLANS }, (_, i) => randomRequest(rng, params, i));
}

const describeReq = (i: number, r: RoomRequest) =>
  `plan ${i}: ${r.cols}x${r.rows} seed ${r.seed} ${r.doors.map((d) => `${d.side}${d.gate.length ? `[${d.gate.join("+")}]` : ""}${d.flow === "both" ? "" : `(${d.flow})`}`).join(", ")}`;

/** Re-check a room with the traversal checker directly. */
function independentCheck(req: RoomRequest, built: NonNullable<ReturnType<typeof buildRoom>["built"]>): string[] {
  const out: string[] = [];
  const need = (id: string) => req.doors.find((d) => d.id === id)!;
  const g0 = roomGraph(built.grid, built.doors, params, []);
  const plain = built.doors.filter((d) => need(d.id).gate.length === 0);
  const ins = plain.filter((d) => need(d.id).flow !== "out");
  const outs = plain.filter((d) => need(d.id).flow !== "in");
  for (const a of ins) {
    const r = reachableFrom(g0, `in:${a.id}`);
    for (const b of outs) if (b.id !== a.id && !r.has(`out:${b.id}`)) out.push(`${a.id} -> ${b.id} with no abilities`);
    for (const d of built.doors) {
      if (need(d.id).flow === "in" && r.has(`out:${d.id}`)) out.push(`drop ${d.id} climbable from ${a.id}`);
      if (need(d.id).gate.length && r.has(`out:${d.id}`)) out.push(`gate ${d.id} open with no abilities`);
    }
  }
  for (const d of built.doors.filter((d) => need(d.id).gate.length)) {
    const gate = need(d.id).gate;
    if (ins[0] && !reachableFrom(roomGraph(built.grid, built.doors, params, gate), `in:${ins[0].id}`).has(`out:${d.id}`)) out.push(`gate ${d.id} closed with ${gate}`);
    for (const a of gate) {
      const g = roomGraph(built.grid, built.doors, params, ALL.filter((b) => b !== a));
      if (ins.some((s) => reachableFrom(g, `in:${s.id}`).has(`out:${d.id}`))) out.push(`gate ${d.id} open without ${a}`);
    }
  }
  return out;
}

export function runShard(shard: number) {
  const all = plans();
  const t0 = performance.now();
  const failures: string[] = [];
  let checked = 0;
  let slowest = { ms: 0, what: "" };
  for (let i = shard; i < all.length; i += SHARDS) {
    const req = all[i]!;
    const t = performance.now();
    const result = buildRoom(req, params);
    const ms = performance.now() - t;
    if (ms > slowest.ms) slowest = { ms, what: describeReq(i, req) };
    const what = describeReq(i, req);
    if (!result.built || !result.proof?.ok) {
      failures.push(`${what}: ${result.proof?.problems.slice(0, 3).join("; ") ?? result.errors.slice(0, 2).join("; ")}`);
      continue;
    }
    const { grid, doors } = result.built;
    // Size, doors, sides, offsets in range.
    expect([gridCols(grid), gridRows(grid)], what).toEqual([req.cols, req.rows]);
    expect(doors.map((d) => d.id).sort(), what).toEqual(req.doors.map((d) => d.id).sort());
    for (const d of doors) {
      expect(d.side, what).toBe(need(req, d.id).side);
      const length = d.side === "left" || d.side === "right" ? req.rows : req.cols;
      expect(d.offset >= 0 && d.offset + d.size <= length, `${what}: door ${d.id} in range`).toBe(true);
      expect(OPPOSITE[OPPOSITE[d.side]]).toBe(d.side);
    }
    // Deterministic: the same attempt rebuilds the same room.
    const again = composeAttempt(req, params, result.attempt);
    expect("error" in again ? again.error : again.grid, what).toEqual(grid);
    expect(unstandableRuns(grid, params), what).toEqual([]);
    const area = req.cols * req.rows;
    if (area <= 6000 && (((i - shard) / SHARDS) % SAMPLE === 0 || area < 1500)) {
      const problems = independentCheck(req, result.built);
      if (problems.length) failures.push(`${what} (independent check): ${problems.join("; ")}`);
      checked++;
    }
  }
  const ms = Math.round(performance.now() - t0);
  console.log(`shard ${shard}: ${Math.ceil(all.length / SHARDS)} plans in ${ms} ms (${checked} re-checked independently); slowest ${Math.round(slowest.ms)} ms, ${slowest.what}`);
  expect(failures).toEqual([]);
}

const need = (req: RoomRequest, id: string) => req.doors.find((d) => d.id === id)!;
