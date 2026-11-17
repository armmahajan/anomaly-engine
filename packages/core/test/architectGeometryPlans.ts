import { doorCapacity, minimumSize, MOVEMENT_ABILITIES, unitsFor, type DoorNeed, type DoorSide, type MovementAbility, type MovementParams, type RoomRequest } from "../src/index.ts";

/** Random room plans for the geometry property tests (feasible: sized and sided as the layout stage would). */

export class TestRng {
  constructor(private s: number) {}
  next() {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  int(lo: number, hi: number) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)]!;
  }
}

const SIDES: DoorSide[] = ["left", "right", "top", "bottom"];
export const MECHANICS = Object.keys(MOVEMENT_ABILITIES) as MovementAbility[];

export function randomRequest(rng: TestRng, p: MovementParams, i: number): RoomRequest {
  const u = unitsFor(p);
  const kind = rng.next();
  let cols = kind < 0.7 ? rng.int(16, 60) : kind < 0.95 ? rng.int(30, 120) : rng.int(60, 240);
  let rows = kind < 0.7 ? rng.int(10, 30) : kind < 0.95 ? rng.int(14, 60) : rng.int(30, 135);
  const n = rng.int(1, 4);
  const doors: DoorNeed[] = [];
  for (let k = 0; k < n; k++) {
    const r = rng.next();
    // Every movement mechanic gates some links (the i-th plan cycles through them), one-way links are drops.
    if (r < 0.3) {
      const gate = rng.next() < 0.85 ? [MECHANICS[(i + k) % MECHANICS.length]!] : [rng.pick(MECHANICS), rng.pick(MECHANICS)];
      const oneWay = rng.next() < 0.3;
      doors.push({ id: `d${k}`, side: oneWay ? "bottom" : rng.next() < 0.8 ? rng.pick(["left", "right"] as const) : rng.pick(SIDES), gate: [...new Set(gate)], flow: oneWay ? "out" : "both" });
    } else if (r < 0.45) {
      const out = rng.next() < 0.5;
      doors.push({ id: `d${k}`, side: out ? "bottom" : "top", gate: [], flow: out ? "out" : "in" });
    } else {
      doors.push({ id: `d${k}`, side: rng.pick(SIDES), gate: [], flow: "both" });
    }
  }
  // Grow to fit (as layout does), then move doors off sides that are full.
  for (let pass = 0; pass < 3; pass++) {
    const min = minimumSize(p, u, doors);
    cols = Math.max(cols, min.cols);
    rows = Math.max(rows, min.rows);
    for (const d of doors) {
      const count = (s: DoorSide) => doors.filter((e) => e.side === s).length;
      if (count(d.side) <= doorCapacity(cols, rows, d.side, u)) continue;
      if (d.flow !== "both") continue;
      const free = SIDES.filter((s) => count(s) < doorCapacity(cols, rows, s, u) && (!d.gate.length || s === "left" || s === "right"));
      if (free.length) d.side = rng.pick(free);
      else rows += u.air + 1;
    }
  }
  return {
    cols,
    rows,
    seed: rng.int(0, 999_999),
    terrain: { verticality: rng.next(), hazards: rng.next(), density: rng.next(), open: rng.next() },
    fight: rng.next() < 0.2,
    doors,
  };
}
