import type { MovementAbility, MovementParams } from "../../movement/params.ts";
import { gridCols, gridRows, type TileGrid } from "../../world/tiles.ts";
import type { TraversalOpening } from "../../world/traversal.ts";
import type { DoorSide } from "../../world/world.ts";
import type { RoomTerrain } from "../plan.ts";
import { gateBlock, Paint, rungRows, type Block } from "./blocks.ts";
import { fixUnstandable } from "./lint.ts";
import { mixSeed, Rng } from "./rng.ts";
import { unitsFor, type Units } from "./units.ts";

/**
 * Room composition: a room's tiles and doors from its size, its doors and the
 * plan's terrain knobs, deterministic for a seed.
 *
 * A room is a stack of bands (storeys) across its width. Each band has a floor
 * whose steps are never more than a comfortable jump (`Units.rise`), so every
 * part of a band is walkable both ways; bands are joined by ladders: a hole in
 * the floor above with one-way rungs zig-zagging down to the floor below
 * (climb up through them, drop down beside them). Side doors open onto a
 * band's floor at the wall. A top door has a rung ladder under it; a one-way
 * top door (a drop in) a chute hanging from the ceiling, too deep to jump back
 * up. A bottom door is a hole in the bottom floor (with a one-way half-cover
 * to land on when coming up through it, unless nobody does). A gated door is
 * a block (blocks.ts) flush with its edge: the bands it overlaps stop at it,
 * and its entry opens onto a band's floor. Then spike strips (hazards),
 * floating one-way platforms in tiers (density, verticality) and wide flat
 * floor (open, or a fight that locks the room). The knobs: verticality picks
 * shorter bands, bigger floor steps and more ladders and platform tiers;
 * hazards the spike strips; density the platforms and how often the floor
 * steps; open the widest flat run of floor.
 *
 * Composition can fail (things don't fit); the caller tries other attempts
 * (other sub-seeds, then plainer knobs) and proves each with the checker.
 */

export interface DoorNeed {
  id: string;
  side: DoorSide;
  /** Movement abilities needed to reach this door from the rest of the room (a gated link's `a` end). */
  gate: MovementAbility[];
  /** both: in and out; out: only left through (a one-way link's `a` end); in: only arrived through (its `b` end). */
  flow: "both" | "out" | "in";
  /** Where along its side it would best sit (tiles: a side door's floor row, a top or bottom door's first column). */
  prefer?: number;
}

export interface RoomRequest {
  cols: number;
  rows: number;
  seed: number;
  terrain: RoomTerrain;
  /** Something locks the room for a fight: keep a wide flat floor. */
  fight: boolean;
  doors: DoorNeed[];
}

export interface Composed {
  grid: TileGrid;
  doors: TraversalOpening[];
}

interface Band {
  base: number;
  vary: number;
  slab: number;
  /** Rows the band owns: from just below the previous band's base to its own base. */
  e0: number;
  e1: number;
}

interface Piece {
  band: number;
  c0: number;
  c1: number;
  used: boolean;
  floor: number[];
  anchors: Anchor[];
  zones: [number, number][];
  /** Has a door, a gate's entry, a ladder to a top door, a chute or a hole: must be reachable. */
  needed: boolean;
  arena?: [number, number];
}

interface Anchor {
  c0: number;
  c1: number;
  row: number;
}

interface Placed {
  block: Block;
  x: number;
  y: number;
  door: DoorNeed;
}

class Fail extends Error {}
const fail = (why: string): never => {
  throw new Fail(why);
};

export function composeRoom(req: RoomRequest, p: MovementParams, attempt = 0, plain = false): Composed | { error: string } {
  try {
    return compose(req, p, attempt, plain);
  } catch (e) {
    if (e instanceof Fail) return { error: e.message };
    throw e;
  }
}

function compose(req: RoomRequest, p: MovementParams, attempt: number, plain: boolean): Composed {
  const u = unitsFor(p);
  const C = req.cols;
  const H = req.rows;
  const rng = new Rng(mixSeed(req.seed, attempt, C, H));
  const v = plain ? 0 : req.terrain.verticality;
  const hz = plain ? 0 : req.terrain.hazards;
  const dens = plain ? 0 : req.terrain.density;
  const open = Math.max(req.terrain.open, req.fight ? 0.6 : 0);

  const side = (s: DoorSide) => req.doors.filter((d) => d.side === s);
  const gated = (d: DoorNeed) => d.gate.length > 0;
  const tops = side("top");
  const chute = tops.some((d) => !gated(d) && d.flow === "in");

  // ------------------------------------------------------------ bands
  const vary = plain ? 0 : Math.min(u.rise, Math.round(v * u.rise * (0.5 + rng.next())));
  const slabs: number[] = [];
  const minHeight = (k: number) => (k === 0 ? Math.max(u.air + vary + 1, chute ? u.chute + 3 : 0, tops.length ? u.topRung + 3 + vary : 0) : slabs[k - 1]! + u.air + vary);
  const usable = H - 2;
  let bmax = 0;
  for (let total = 0; ; bmax++) {
    slabs[bmax] = rng.chance(0.35) && H > 30 ? 2 : 1;
    total += minHeight(bmax);
    if (total > usable) break;
  }
  if (bmax < 1) fail(`the room is too short (${H} rows) for a band of floor`);
  const sideNeed = Math.max(side("left").length, side("right").length);
  const tall = u.air * 3;
  const lean = Math.max(0, Math.min(1, v + (rng.next() - 0.5) * 0.3));
  const want = Math.round(usable / (tall + (minHeight(1) - tall) * lean));
  const count = Math.max(1, Math.min(bmax, Math.max(want, sideNeed)));
  const bands: Band[] = [];
  {
    const mins = Array.from({ length: count }, (_, k) => minHeight(k));
    let slack = usable - mins.reduce((a, b) => a + b, 0);
    const weights = mins.map(() => 0.5 + rng.next());
    const total = weights.reduce((a, b) => a + b, 0);
    const extra = weights.map((w) => Math.floor((slack * w) / total));
    slack -= extra.reduce((a, b) => a + b, 0);
    extra[count - 1]! += slack;
    let base = 0;
    for (let k = 0; k < count; k++) {
      base += mins[k]! + extra[k]!;
      bands.push({ base: k === count - 1 ? H - 2 : base, vary, slab: slabs[k]!, e0: k === 0 ? 0 : bands[k - 1]!.base + 1, e1: k === count - 1 ? H - 1 : base });
    }
  }
  const bandAt = (row: number) => bands.findIndex((b) => row >= b.e0 && row <= b.e1);
  const floorRange = (k: number): [number, number] => [bands[k]!.base - bands[k]!.vary, bands[k]!.base];

  // ------------------------------------------------------------ blocks and side doors
  const placed: Placed[] = [];
  const cuts: { band: number; c0: number; c1: number }[] = [];
  const usedSide = new Map<string, Set<number>>([
    ["left", new Set()],
    ["right", new Set()],
  ]);
  const sideDoorBand = new Map<string, number>();
  const cutBands = (r0: number, r1: number) => bands.map((b, k) => (b.e0 < r1 && b.e1 >= r0 ? k : -1)).filter((k) => k >= 0);
  const overlapsBlock = (x: number, y: number, w: number, h: number) => placed.some((b) => x < b.x + gridCols(b.block.grid) + 6 && b.x < x + w + 6 && y < b.y + gridRows(b.block.grid) && b.y < y + h);

  for (const s of ["left", "right"] as const) {
    const needs = rng.shuffle(side(s)).sort((a, b) => Number(gated(b)) - Number(gated(a)));
    for (const d of needs) {
      const used = usedSide.get(s)!;
      if (gated(d)) {
        const block = gateBlock(p, u, d.gate, s, { twoWay: d.flow === "both" });
        const bw = gridCols(block.grid);
        const bh = gridRows(block.grid);
        if (bw + 8 > C) fail(`the ${d.gate.join("+")} gate is ${bw} tiles wide; the room is ${C}`);
        const ef = block.entry.offset + block.entry.size;
        const x = s === "left" ? 0 : C - bw;
        let best: { k: number; f: number; score: number; cut: number[] } | null = null;
        for (let k = 0; k < bands.length; k++) {
          const [lo, hi] = floorRange(k);
          for (let f = lo; f <= hi; f++) {
            const y = f - ef;
            if (y < 0 || y + bh > H) continue;
            const cut = cutBands(y, y + bh);
            if (cut.some((c) => used.has(c))) continue;
            if (overlapsBlock(x, y, bw, bh)) continue;
            const doorRow = y + block.door.offset + block.door.size;
            const score = Math.abs(doorRow - (d.prefer ?? doorRow)) + rng.next() * 3;
            if (!best || score < best.score) best = { k, f, score, cut };
          }
        }
        if (!best) fail(`no room on the ${s} side for the ${d.gate.join("+")} gate (${bw}x${bh})`);
        const y = best!.f - ef;
        placed.push({ block, x, y, door: d });
        for (const k of best!.cut) {
          used.add(k);
          cuts.push({ band: k, c0: x, c1: x + bw - 1 });
        }
      } else {
        const free = bands.map((_, k) => k).filter((k) => !used.has(k) && !placed.some((b) => b.door.side === s && cutBands(b.y, b.y + gridRows(b.block.grid)).includes(k)));
        if (!free.length) fail(`more doors on the ${s} side than the room has bands`);
        const pick = free.sort((a, b) => Math.abs(bands[a]!.base - (d.prefer ?? bands[a]!.base)) - Math.abs(bands[b]!.base - (d.prefer ?? bands[b]!.base)) || rng.next() - 0.5)[0]!;
        used.add(pick);
        sideDoorBand.set(d.id, pick);
      }
    }
  }

  // Top and bottom: columns along the ceiling and the floor.
  const taken: { top: [number, number][]; bottom: [number, number][] } = { top: [], bottom: [] };
  const freeAt = (track: "top" | "bottom", c0: number, c1: number) => c0 >= 1 && c1 <= C - 2 && taken[track].every(([a, b]) => c1 < a - 1 || c0 > b + 1);
  const pickColumn = (track: "top" | "bottom", width: number, prefer: number | undefined, avoid?: (c0: number) => boolean): number | null => {
    const options: number[] = [];
    for (let c = 1; c + width - 1 <= C - 2; c++) if (freeAt(track, c, c + width - 1) && !avoid?.(c)) options.push(c);
    if (!options.length) return null;
    const target = prefer ?? rng.int(1, C - 1 - width);
    return options.sort((a, b) => Math.abs(a - target) - Math.abs(b - target) + (rng.next() - 0.5) * 6)[0]!;
  };

  for (const s of ["top", "bottom"] as const) {
    for (const d of side(s).filter(gated)) {
      // Corner first (it splits no band), the entry facing into the room.
      const options: { x: number; facing: "left" | "right" }[] = [];
      const probe = gateBlock(p, u, d.gate, s, { twoWay: d.flow === "both", facing: "left" });
      const bw = gridCols(probe.grid);
      if (bw + 8 > C) fail(`the ${d.gate.join("+")} gate is ${bw} tiles wide; the room is ${C}`);
      options.push({ x: 0, facing: "right" }, { x: C - bw, facing: "left" });
      const mid = Math.max(1, Math.min(C - bw - 1, (d.prefer ?? Math.floor((C - bw) / 2)) - 1));
      options.push({ x: mid, facing: rng.chance(0.5) ? "left" : "right" });
      let done = false;
      for (const o of rng.chance(0.5) ? options : [options[1]!, options[0]!, options[2]!]) {
        // Size the riser or dropper so the entry lands on some band's floor.
        for (let k = 0; k < bands.length && !done; k++) {
          const [lo, hi] = floorRange(k);
          for (let f = lo; f <= hi && !done; f++) {
            let block = gateBlock(p, u, d.gate, s, { twoWay: d.flow === "both", facing: o.facing });
            const relEntry = (b: Block) => b.entry.offset + b.entry.size;
            const want = s === "top" ? f : f - (H - gridRows(block.grid));
            const grow = s === "top" ? want - relEntry(block) : relEntry(block) - want;
            if (grow < 0) continue;
            if (grow > 0) block = gateBlock(p, u, d.gate, s, { twoWay: d.flow === "both", facing: o.facing, height: block.leg + grow });
            const bh = gridRows(block.grid);
            const y = s === "top" ? 0 : H - bh;
            if (y < 0 || y + relEntry(block) !== f) continue;
            const cut = cutBands(y, y + bh);
            const entrySide = o.facing;
            const blocked = (["left", "right"] as const).some(
              (w) => (w === "left" ? o.x === 0 : o.x + bw === C) && cut.some((c) => usedSide.get(w)!.has(c)),
            );
            if (blocked || overlapsBlock(o.x, y, bw, bh)) continue;
            const edge = entrySide === "left" ? o.x - 1 : o.x + bw;
            if (edge < 1 + 3 || edge > C - 2 - 3) continue;
            if (!freeAt(s, o.x, o.x + bw - 1) && o.x > 0 && o.x + bw < C) continue;
            placed.push({ block, x: o.x, y, door: d });
            taken[s].push([o.x, o.x + bw - 1]);
            for (const c of cut) cuts.push({ band: c, c0: o.x, c1: o.x + bw - 1 });
            for (const w of ["left", "right"] as const) if (w === "left" ? o.x === 0 : o.x + bw === C) for (const c of cut) usedSide.get(w)!.add(c);
            done = true;
          }
        }
        if (done) break;
      }
      if (!done) fail(`no room for the ${s} ${d.gate.join("+")} gate`);
    }
  }

  // ------------------------------------------------------------ pieces
  const pieces: Piece[] = [];
  for (let k = 0; k < bands.length; k++) {
    const blocked = cuts.filter((c) => c.band === k).sort((a, b) => a.c0 - b.c0);
    let c = 1;
    const add = (c0: number, c1: number) => {
      if (c1 - c0 + 1 >= 4) pieces.push({ band: k, c0, c1, used: false, floor: [], anchors: [], zones: [], needed: false });
    };
    for (const b of blocked) {
      add(c, b.c0 - 1);
      c = Math.max(c, b.c1 + 1);
    }
    add(c, C - 2);
  }
  const pieceAt = (k: number, col: number) => pieces.find((q) => q.band === k && q.c0 <= col && q.c1 >= col);
  const zoneFree = (q: Piece, c0: number, c1: number) => c0 >= q.c0 && c1 <= q.c1 && q.zones.every(([a, b]) => c1 < a || c0 > b);
  const reserve = (q: Piece, c0: number, c1: number, row?: number, needed = true) => {
    q.zones.push([c0, c1]);
    if (needed) q.needed = true;
    if (row !== undefined) q.anchors.push({ c0, c1, row });
  };
  const pickRow = (k: number, prefer?: number, min = -Infinity) => {
    const [lo, hi] = floorRange(k);
    const from = Math.max(lo, min);
    if (from > hi) fail(`band ${k} can't put a floor at row ${min} or lower`);
    if (prefer !== undefined && prefer >= from && prefer <= hi) return prefer;
    return rng.int(from, hi);
  };

  // Side doors.
  const doorsOut: TraversalOpening[] = [];
  for (const d of [...side("left"), ...side("right")].filter((d) => !gated(d))) {
    const k = sideDoorBand.get(d.id)!;
    const col = d.side === "left" ? 1 : C - 2;
    const q = pieceAt(k, col) ?? fail(`the ${d.side} door's band is cut`);
    const row = pickRow(k, d.prefer);
    const [c0, c1] = d.side === "left" ? [1, 4] : [C - 5, C - 2];
    if (!zoneFree(q, c0, c1)) fail(`the ${d.side} door's floor is taken`);
    reserve(q, c0, c1, row);
    doorsOut.push({ id: d.id, side: d.side, offset: row - 3, size: 3 });
  }
  // Block entries and doors.
  for (const b of placed) {
    const ef = b.y + b.block.entry.offset + b.block.entry.size;
    const k = bandAt(ef);
    const entryLeft = b.block.entry.side === "left";
    const edge = entryLeft ? b.x - 1 : b.x + gridCols(b.block.grid);
    const q = pieceAt(k, edge) ?? fail(`a gate's entry opens onto nothing`);
    const [c0, c1] = entryLeft ? [edge - 3, edge] : [edge, edge + 3];
    if (!zoneFree(q, c0, c1)) fail("a gate's entry floor is taken");
    reserve(q, c0, c1, ef);
    const door = b.block.door;
    const offset = door.side === "left" || door.side === "right" ? b.y + door.offset : b.x + door.offset;
    doorsOut.push({ id: b.door.id, side: b.door.side, offset, size: door.size });
  }

  // Ladders under top doors, chutes for drops in; holes in the bottom floor.
  const ladders: { k: number; x: number; aLeft: boolean; top: number }[] = [];
  const features: (() => void)[] = [];
  const paint = new Paint(C, H);
  for (const d of tops.filter((d) => !gated(d))) {
    if (d.flow === "in") {
      const w = u.hatch + 2;
      const x = pickColumn("top", w + 4, d.prefer === undefined ? undefined : d.prefer - 3, (c) => !pieceAt(0, c) || !zoneFree(pieceAt(0, c)!, c, c + w + 3));
      if (x === null) fail("no room for a drop-in chute");
      const q = pieceAt(0, x!)!;
      reserve(q, x!, x! + w + 3, pickRow(0, undefined, u.chute + 3));
      taken.top.push([x!, x! + w + 3]);
      const ox = x! + 3;
      doorsOut.push({ id: d.id, side: "top", offset: ox, size: u.hatch });
      features.push(() => {
        paint.fill(ox, 0, u.hatch, 1, "empty");
        paint.fill(ox - 1, 0, 1, u.chute + 1, "solid");
        paint.fill(ox + u.hatch, 0, 1, u.chute + 1, "solid");
      });
    } else {
      const w = u.hatch + 1 + u.half;
      const x = pickColumn("top", w + 2, d.prefer === undefined ? undefined : d.prefer - 1, (c) => !pieceAt(0, c) || !zoneFree(pieceAt(0, c)!, c, c + w + 1));
      if (x === null) fail("no room for a ladder under a top door");
      const q = pieceAt(0, x!)!;
      const aLeft = rng.chance(0.5);
      const ox = aLeft ? x! + 1 : x! + 1 + u.half + 1;
      reserve(q, x!, x! + w + 1, pickRow(0, undefined, u.topRung + 3));
      taken.top.push([x!, x! + w + 1]);
      doorsOut.push({ id: d.id, side: "top", offset: ox, size: u.hatch });
      ladders.push({ k: 0, x: x! + 1, aLeft, top: u.topRung });
    }
  }
  const last = bands.length - 1;
  for (const d of side("bottom").filter((d) => !gated(d))) {
    const w = u.hatch;
    const x = pickColumn("bottom", w + 4, d.prefer === undefined ? undefined : d.prefer - 2, (c) => !pieceAt(last, c) || !zoneFree(pieceAt(last, c)!, c, c + w + 3));
    if (x === null) fail("no room for a hole in the floor");
    const q = pieceAt(last, x!)!;
    reserve(q, x!, x! + w + 3, H - 2);
    taken.bottom.push([x!, x! + w + 3]);
    const ox = x! + 2;
    doorsOut.push({ id: d.id, side: "bottom", offset: ox, size: w });
    const cover = d.flow === "both";
    features.push(() => {
      paint.fill(ox, H - 2, w, 2, "empty");
      if (cover) paint.fill(ox, H - 2, Math.floor(w / 2), 1, "oneway");
    });
  }

  // Wide flat floor to fight on (the arena), in the widest piece of a low band.
  if (open >= 0.3 && !plain) {
    const candidates = pieces.filter((q) => q.c1 - q.c0 + 1 >= 10).sort((a, b) => b.band - a.band || b.c1 - b.c0 - (a.c1 - a.c0));
    const q = candidates[0];
    if (q) {
      const width = q.c1 - q.c0 + 1;
      const want = Math.max(8, Math.min(width - 2, Math.round(width * open)));
      const starts: number[] = [];
      for (let c = q.c0; c + want - 1 <= q.c1; c++) if (zoneFree(q, c, c + want - 1)) starts.push(c);
      let w = want;
      while (!starts.length && w > 8) {
        w -= 2;
        for (let c = q.c0; c + w - 1 <= q.c1; c++) if (zoneFree(q, c, c + w - 1)) starts.push(c);
      }
      if (starts.length) {
        const c = starts[Math.floor(starts.length / 2 + (rng.next() - 0.5) * starts.length * 0.5)]!;
        const fw = starts.length && w !== want ? w : want;
        reserve(q, c, c + fw - 1, bands[q.band]!.base, false);
        q.arena = [c, c + fw - 1];
      }
    }
  }

  // ------------------------------------------------------------ ladders between bands, connectivity
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const join = (a: number, b: number) => (parent[find(a)] = find(b));
  const climbs: { upper: Piece; lower: Piece; x: number; aLeft: boolean }[] = [];
  const tryClimb = (upper: Piece, lower: Piece): boolean => {
    const lo = Math.max(upper.c0, lower.c0) + 1;
    const hi = Math.min(upper.c1, lower.c1) - 1 - u.ladder;
    const xs: number[] = [];
    for (let x = lo; x <= hi; x++) if (zoneFree(upper, x - 1, x + u.ladder) && zoneFree(lower, x - 1, x + u.ladder)) xs.push(x);
    if (!xs.length) return false;
    const x = rng.pick(xs);
    reserve(upper, x - 1, x + u.ladder, pickRow(upper.band), false);
    reserve(lower, x - 1, x + u.ladder, pickRow(lower.band), false);
    climbs.push({ upper, lower, x, aLeft: rng.chance(0.5) });
    return true;
  };
  const pairs: [number, number][] = [];
  pieces.forEach((a, i) =>
    pieces.forEach((b, j) => {
      if (b.band === a.band + 1 && Math.min(a.c1, b.c1) - Math.max(a.c0, b.c0) + 1 >= u.ladder + 4) pairs.push([i, j]);
    }),
  );
  for (const [i, j] of rng.shuffle(pairs)) if (find(i) !== find(j) && tryClimb(pieces[i]!, pieces[j]!)) join(i, j);
  // Extra ladders (loops) with verticality.
  for (const [i, j] of rng.shuffle(pairs)) {
    const width = Math.min(pieces[i]!.c1, pieces[j]!.c1) - Math.max(pieces[i]!.c0, pieces[j]!.c0);
    if (!plain && rng.chance(v * Math.min(1, width / 40))) tryClimb(pieces[i]!, pieces[j]!);
  }
  const roots = new Set(pieces.flatMap((q, i) => (q.needed ? [find(i)] : [])));
  if (roots.size > 1) fail("the room's floors can't all be joined by ladders");
  const root = roots.size ? [...roots][0]! : find(pieces.findIndex((q) => q.band === last));
  for (const [i, q] of pieces.entries()) q.used = find(i) === root;
  for (let i = climbs.length - 1; i >= 0; i--) if (!climbs[i]!.upper.used) climbs.splice(i, 1);

  // ------------------------------------------------------------ floors
  const segMax = Math.max(3, Math.round(3 + (1 - dens) * 5 + open * 8 - v * 3));
  const stepChance = plain ? 0 : Math.min(0.9, 0.25 + 0.6 * v + 0.25 * dens);
  for (const q of pieces.filter((q) => q.used)) {
    const [lo, hi] = floorRange(q.band);
    const anchors = [...q.anchors].sort((a, b) => a.c0 - b.c0);
    let row = anchors[0]?.row ?? rng.int(lo, hi);
    let c = q.c0;
    const floor = new Array<number>(C).fill(-1);
    for (const a of [...anchors, { c0: q.c1 + 1, c1: q.c1 + 1, row: -1 }]) {
      while (c < a.c0) {
        const width = Math.min(a.c0 - c, rng.int(3, segMax));
        if (a.c0 - c - width < 3 && a.c0 - c - width > 0) {
          // Don't leave a sliver: run to the anchor.
          for (; c < a.c0; c++) floor[c] = row;
          break;
        }
        if (rng.chance(stepChance)) row = rng.int(lo, hi);
        for (let i = 0; i < width; i++) floor[c++] = row;
      }
      if (a.row < 0) break;
      for (c = a.c0; c <= a.c1; c++) floor[c] = a.row;
      row = a.row;
    }
    q.floor = floor;
  }
  const floorAt = (k: number, col: number) => {
    const q = pieceAt(k, col);
    return q?.used && q.floor[col]! >= 0 ? q.floor[col]! : bands[k]!.base;
  };
  const ceilAt = (k: number, col: number) => (k === 0 ? 1 : floorAt(k - 1, col) + bands[k - 1]!.slab);

  // ------------------------------------------------------------ carve
  const pits: { k: number; c0: number; c1: number }[] = [];
  for (const q of pieces.filter((q) => q.used)) {
    for (let c = q.c0; c <= q.c1; c++) paint.fill(c, ceilAt(q.band, c), 1, q.floor[c]! - ceilAt(q.band, c), "empty");
  }
  // Spike strips in flat runs of floor away from everything else.
  if (hz > 0) {
    for (const q of pieces.filter((q) => q.used)) {
      const n = Math.round(hz * ((q.c1 - q.c0 + 1) / 12) + (rng.next() - 0.5));
      for (let i = 0; i < n; i++) {
        const w = rng.int(Math.min(2, u.pit), u.pit);
        const c0 = rng.int(q.c0 + 2, q.c1 - 2 - w);
        const flat = (from: number, to: number) => {
          for (let c = from; c <= to; c++) if (q.floor[c] !== q.floor[c0]) return false;
          return true;
        };
        if (c0 < q.c0 + 2 || !zoneFree(q, c0 - 2, c0 + w + 1) || !flat(c0 - 2, c0 + w + 1)) continue;
        if (pits.some((t) => t.k === q.band && c0 - 3 <= t.c1 && c0 + w + 2 >= t.c0)) continue;
        pits.push({ k: q.band, c0, c1: c0 + w - 1 });
        q.zones.push([c0 - 1, c0 + w]);
        paint.fill(c0, q.floor[c0]!, w, 1, "hazard");
      }
    }
  }
  // Ladders.
  for (const cl of climbs) {
    const { x } = cl;
    const u0 = floorAt(cl.upper.band, x);
    const f = floorAt(cl.lower.band, x);
    const [aX, bX] = cl.aLeft ? [x, x + u.half + 1] : [x + u.half + 1, x];
    for (let c = x; c < x + u.ladder; c++) paint.fill(c, u0, 1, ceilAt(cl.lower.band, c) - u0, "empty");
    rungRows(u0, f, u.rise).forEach((r, i) => paint.fill(i % 2 === 0 ? aX : bX, r, u.half, 1, "oneway"));
  }
  for (const l of ladders) {
    const f = floorAt(0, l.x);
    const [aX, aW, bX] = l.aLeft ? [l.x, u.hatch, l.x + u.hatch + 1] : [l.x + u.half + 1, u.hatch, l.x];
    paint.fill(aX, 0, aW, 1, "empty");
    rungRows(l.top, f, u.rise).forEach((r, i) => (i % 2 === 0 ? paint.fill(aX, r, aW, 1, "oneway") : paint.fill(bX, r, u.half, 1, "oneway")));
  }
  for (const f of features) f();
  // Side door openings.
  for (const d of doorsOut) if ((d.side === "left" || d.side === "right") && !placed.some((b) => b.door.id === d.id)) paint.fill(d.side === "left" ? 0 : C - 1, d.offset, 1, d.size, "empty");

  // Floating platforms, in tiers.
  if (dens > 0) {
    for (const q of pieces.filter((q) => q.used)) {
      const width = q.c1 - q.c0 + 1;
      const arena = q.arena;
      const n = Math.round(dens * width / 9 + (rng.next() - 0.5));
      const made: { c0: number; c1: number; r: number }[] = [];
      for (let i = 0; i < n * 3 && made.length < n * (1 + v); i++) {
        const w = rng.int(3, 6);
        const c0 = rng.int(q.c0 + 2, q.c1 - 1 - w);
        const c1 = c0 + w - 1;
        if (c0 < q.c0 + 2 || !zoneFree(q, c0 - 1, c1 + 1)) continue;
        // On a tier above another platform it overlaps, or above the floor.
        const under = made.filter((m) => m.c0 <= c1 + 1 && m.c1 >= c0 - 1);
        let base = Infinity;
        for (let c = c0 - 1; c <= c1 + 1; c++) base = Math.min(base, q.floor[c]!);
        let r = base - u.rise;
        if (under.length && rng.chance(0.5 + v * 0.4)) r = Math.min(...under.map((m) => m.r)) - u.rise;
        else if (under.length) continue;
        if (arena && c1 >= arena[0] - 1 && c0 <= arena[1] + 1 && base - r < u.rise + u.body + 2) continue;
        let top = 0;
        for (let c = c0 - 1; c <= c1 + 1; c++) top = Math.max(top, ceilAt(q.band, c));
        if (r - top < u.body + 1) continue;
        // Clear of other platforms by a row of air above and below and a column at the ends.
        if (made.some((m) => m.c0 <= c1 + 2 && m.c1 >= c0 - 2 && Math.abs(m.r - r) < u.body + 1)) continue;
        if (pits.some((t) => t.k === q.band && t.c0 <= c1 + 1 && t.c1 >= c0 - 1)) continue;
        made.push({ c0, c1, r });
        paint.fill(c0, r, w, 1, "oneway");
      }
    }
  }

  // Blocks last (their own tiles win).
  for (const b of placed) paint.stamp(b.block.grid, b.x, b.y);
  const grid = fixUnstandable(paint.grid(), p);
  return { grid, doors: doorsOut };
}

export type { Units };
