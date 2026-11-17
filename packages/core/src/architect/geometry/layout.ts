import { OPPOSITE, type DoorSide, type WorldRoom } from "../../world/world.ts";
import type { ArchitectPlan, RoomLink, RoomPlan } from "../plan.ts";
import { linkDoorId } from "../plan.ts";
import type { StageIssue } from "../stages.ts";
import { doorCapacity } from "./capacity.ts";
import { hashText } from "./rng.ts";
import type { Units } from "./units.ts";

/**
 * The layout stage's work: place rooms on the world map (tiles) and choose
 * which side of each room every link leaves from.
 *
 * Breadth first from the start room (pinned rooms stay where they are): each
 * room goes right next to the room it is first reached from, on the side its
 * link leaves from, sliding along that side until it overlaps nothing. Sides
 * the creator set are kept (the other end faces it); a link to a pinned room's
 * existing door takes that door's side; one-way links are drops (a's bottom to
 * b's top); gated two-way links leave from the left or right; otherwise the
 * side that fits the map, preferring left and right. Sides stay within what a
 * room can hold (capacity.ts). Links between rooms already placed take the
 * sides that face each other.
 */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const HORIZONTAL: DoorSide[] = ["right", "left"];

export interface LayoutResult {
  plan: ArchitectPlan;
  issues: StageIssue[];
  placed: number;
}

export function layoutPlan(plan: ArchitectPlan, world: { rooms: WorldRoom[] }, units: Units, only?: Set<string>): LayoutResult {
  const issues: StageIssue[] = [];
  const rooms = new Map(plan.rooms.map((r) => [r.id, { ...r }]));
  const links = plan.links.map((l) => ({ ...l, a: { ...l.a }, b: { ...l.b } }));
  const movable = (id: string) => {
    const r = rooms.get(id);
    return !!r && !r.pinned && (!only || only.has(id));
  };
  const worldRoom = (id: string) => world.rooms.find((r) => r.id === id);

  // Fixed positions: pinned rooms (and rooms outside `only`) keep theirs.
  const at = new Map<string, { x: number; y: number }>();
  for (const r of rooms.values()) {
    if (!movable(r.id)) at.set(r.id, r.at ?? worldRoom(r.id)?.at ?? { x: 0, y: 0 });
  }
  const rect = (id: string): Rect => {
    const r = rooms.get(id)!;
    const p = at.get(id)!;
    return { x: p.x, y: p.y, w: r.cols, h: r.rows };
  };
  const free = (c: Rect, except?: string) => [...at.keys()].every((id) => id === except || !overlaps(c, rect(id)));

  // Sides fixed before placement: the creator's, and pinned rooms' existing doors.
  const end = (l: RoomLink, e: "a" | "b") => l[e];
  for (const l of links) {
    for (const e of ["a", "b"] as const) {
      const room = rooms.get(l[e].room);
      if (!room?.pinned || l[e].side) continue;
      const door = worldRoom(room.id)?.doors.find((d) => d.id === linkDoorId(l.id, e));
      if (door) l[e].side = door.side;
    }
    if (l.a.side && !l.b.side) l.b.side = OPPOSITE[l.a.side];
    if (l.b.side && !l.a.side) l.a.side = OPPOSITE[l.b.side];
    if (l.a.side && l.b.side && l.b.side !== OPPOSITE[l.a.side]) {
      issues.push({ stage: "layout", code: "sides-not-opposite", message: `link ${l.id}: ${l.a.room} leaves ${l.a.side} but ${l.b.room} enters ${l.b.side}; doors join opposite sides`, linkId: l.id });
    }
  }

  const used = new Map<string, number>();
  const count = (room: string, side: DoorSide) => used.get(`${room}/${side}`) ?? 0;
  const take = (room: string, side: DoorSide) => used.set(`${room}/${side}`, count(room, side) + 1);
  for (const l of links) {
    if (l.a.side) take(l.a.room, l.a.side);
    if (l.b.side) take(l.b.room, l.b.side);
  }
  const fits = (room: string, side: DoorSide) => {
    const r = rooms.get(room)!;
    return count(room, side) < doorCapacity(r.cols, r.rows, side, units);
  };

  /** Sides to try for the end of `l` in room `here`, best first. */
  const sideChoices = (l: RoomLink, here: "a" | "b"): DoorSide[] => {
    if (l[here].side) return [l[here].side!];
    if (l.oneWay) return [here === "a" ? "bottom" : "top"];
    const flip = hashText(l.id) % 2 === 1;
    const horizontal = flip ? ["left", "right"] : HORIZONTAL;
    const vertical: DoorSide[] = flip ? ["top", "bottom"] : ["bottom", "top"];
    const gated = l.requires.length > 0;
    return [...horizontal, ...(gated ? [] : vertical), ...(gated ? vertical : [])] as DoorSide[];
  };

  /** Place `child` next to `parent` across `side` (the side of parent), sliding along it until free. */
  const place = (parent: string, child: string, side: DoorSide): { x: number; y: number } | null => {
    const p = rect(parent);
    const c = rooms.get(child)!;
    const along = side === "left" || side === "right";
    const x0 = side === "right" ? p.x + p.w : side === "left" ? p.x - c.cols : p.x;
    const y0 = side === "bottom" ? p.y + p.h : side === "top" ? p.y - c.rows : p.y;
    // Slide so the facing edges overlap by as much as possible first.
    const span = along ? p.h + c.rows : p.w + c.cols;
    const offsets: number[] = [];
    const base = along ? Math.round((p.h - c.rows) / 2) : Math.round((p.w - c.cols) / 2);
    for (let d = 0; d <= span; d++) offsets.push(base + d, base - d);
    const minOverlap = 4;
    for (const o of offsets) {
      const cand = along ? { x: x0, y: p.y + o, w: c.cols, h: c.rows } : { x: p.x + o, y: y0, w: c.cols, h: c.rows };
      const overlap = along ? Math.min(p.y + p.h, cand.y + cand.h) - Math.max(p.y, cand.y) : Math.min(p.x + p.w, cand.x + cand.w) - Math.max(p.x, cand.x);
      if (overlap < Math.min(minOverlap, along ? Math.min(p.h, c.rows) : Math.min(p.w, c.cols))) continue;
      if (free(cand)) return { x: cand.x, y: cand.y };
    }
    return null;
  };

  /** Somewhere free in a direction, however far (when nothing adjacent is). */
  const placeFar = (parent: string, child: string, side: DoorSide): { x: number; y: number } => {
    const p = rect(parent);
    const c = rooms.get(child)!;
    for (let gap = 1; ; gap++) {
      const cand =
        side === "right"
          ? { x: p.x + p.w + gap, y: p.y, w: c.cols, h: c.rows }
          : side === "left"
            ? { x: p.x - c.cols - gap, y: p.y, w: c.cols, h: c.rows }
            : side === "bottom"
              ? { x: p.x, y: p.y + p.h + gap, w: c.cols, h: c.rows }
              : { x: p.x, y: p.y - c.rows - gap, w: c.cols, h: c.rows };
      if (free(cand)) return { x: cand.x, y: cand.y };
    }
  };

  const bounds = () => {
    const ids = [...at.keys()];
    if (!ids.length) return { x: 0, y: 0, w: 0, h: 0 };
    const rs = ids.map(rect);
    const x = Math.min(...rs.map((r) => r.x));
    const y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
  };

  const order = [...rooms.values()];
  const startRoom = order.find((r) => r.contents.some((c) => c.kind === "start"));
  const roots = [...(startRoom ? [startRoom] : []), ...order];
  const queue: string[] = [...at.keys()];
  let placed = 0;
  const visit = () => {
    while (queue.length) {
      const id = queue.shift()!;
      for (const l of links) {
        const here = l.a.room === id ? "a" : l.b.room === id ? "b" : null;
        if (!here) continue;
        const there = here === "a" ? "b" : "a";
        const other = l[there].room;
        if (!rooms.has(other) || at.has(other)) continue;
        let done = false;
        const choices = sideChoices(l, here);
        const fitting = choices.filter((s) => fits(id, s) && fits(other, OPPOSITE[s]));
        for (const side of fitting.length ? fitting : choices) {
          const pos = place(id, other, side);
          if (!pos) continue;
          at.set(other, pos);
          setSides(l, here, side);
          done = true;
          break;
        }
        if (!done) {
          const side = (fitting.length ? fitting : choices)[0]!;
          at.set(other, placeFar(id, other, side));
          setSides(l, here, side);
        }
        placed++;
        queue.push(other);
      }
    }
  };
  const setSides = (l: RoomLink, here: "a" | "b", side: DoorSide) => {
    const there = here === "a" ? "b" : "a";
    if (!l[here].side) {
      l[here].side = side;
      take(l[here].room, side);
    }
    if (!l[there].side) {
      l[there].side = OPPOSITE[side];
      take(l[there].room, OPPOSITE[side]);
    }
  };

  visit();
  for (const r of roots) {
    if (at.has(r.id)) continue;
    const b = bounds();
    at.set(r.id, at.size ? { x: b.x + b.w + 4, y: b.y } : { x: 0, y: 0 });
    placed++;
    queue.push(r.id);
    visit();
  }

  // Links between rooms that were both placed already: sides that face each other.
  for (const l of links) {
    if (l.a.side && l.b.side) continue;
    if (!rooms.has(l.a.room) || !rooms.has(l.b.room)) continue;
    const ra = rect(l.a.room);
    const rb = rect(l.b.room);
    const dx = rb.x + rb.w / 2 - (ra.x + ra.w / 2);
    const dy = rb.y + rb.h / 2 - (ra.y + ra.h / 2);
    const prefer: DoorSide[] = l.oneWay
      ? ["bottom"]
      : Math.abs(dx) * ra.h >= Math.abs(dy) * ra.w || l.requires.length > 0
        ? [dx >= 0 ? "right" : "left", dy >= 0 ? "bottom" : "top", dx >= 0 ? "left" : "right", dy >= 0 ? "top" : "bottom"]
        : [dy >= 0 ? "bottom" : "top", dx >= 0 ? "right" : "left", dy >= 0 ? "top" : "bottom", dx >= 0 ? "left" : "right"];
    const side = prefer.find((s) => fits(l.a.room, s) && fits(l.b.room, OPPOSITE[s])) ?? prefer[0]!;
    setSides(l, "a", side);
  }

  for (const l of links) {
    for (const e of ["a", "b"] as const) {
      const r = rooms.get(end(l, e).room);
      const side = end(l, e).side;
      if (r && side && count(r.id, side) > doorCapacity(r.cols, r.rows, side, units)) {
        issues.push({ stage: "layout", code: "side-crowded", message: `${r.id} has ${count(r.id, side)} doors on its ${side} side; it holds ${doorCapacity(r.cols, r.rows, side, units)} at ${r.cols}x${r.rows}`, roomId: r.id, linkId: l.id });
      }
    }
  }

  const nextRooms: RoomPlan[] = plan.rooms.map((r) => (movable(r.id) ? { ...rooms.get(r.id)!, at: at.get(r.id)! } : r));
  const seenIssue = new Set<string>();
  return {
    plan: { ...plan, rooms: nextRooms, links },
    issues: issues.filter((i) => {
      const k = `${i.code}/${i.roomId}/${i.linkId}`;
      return seenIssue.has(k) ? false : (seenIssue.add(k), true);
    }),
    placed,
  };
}
