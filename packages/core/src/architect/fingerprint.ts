import { roomLinks, type ArchitectPlan, type RoomPlan } from "./plan.ts";

/** FNV-1a, 32 bits, of the value's JSON with sorted keys, as hex: enough to tell versions of a document apart. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v)) ?? "";
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * What a room is built from: the parts of its plan that shape the built room (size, region, terrain,
 * contents, seed) and its links (doors, gates). Not its name, notes or map position. Population stamps
 * it on the plan room (RoomPlan.built) when it fills the room; a plan changed since differs from it.
 */
export function roomBuildStamp(plan: ArchitectPlan, room: RoomPlan): string {
  const links = roomLinks(plan, room.id).map(({ link, here }) => [link.id, here, link.a.side ?? null, link.b.side ?? null, link.requires, link.oneWay]);
  return fingerprint({ cols: room.cols, rows: room.rows, regionId: room.regionId, terrain: room.terrain, contents: room.contents, seed: room.seed, links });
}

/** A built room whose plan changed since it was built (it has a stamp, and it no longer matches). */
export const roomPlanChanged = (plan: ArchitectPlan, room: RoomPlan): boolean => room.built !== undefined && room.built !== roomBuildStamp(plan, room);
