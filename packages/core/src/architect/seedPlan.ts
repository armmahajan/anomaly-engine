import type { ProjectSpec } from "../schema.ts";
import { ArchitectPlan, RoomPlan, type RoomContent, type RoomLink } from "./plan.ts";

/**
 * A plan derived from the progression alone, with no model: each region's
 * rooms in a chain, regions joined as the progression joins them (gates and
 * one-way drops copied), the start and ending placed, every ability or key put
 * where the progression says (a guardian that locks its room and grants it, or a
 * pickup), enemies spread through the region and a save point in each region.
 * The model's plan stage starts from this and the creator can edit it; tests use
 * it as a valid plan for any progression. Keeps the creator's existing guidance,
 * notes, settings and pinned rooms.
 */
export function seedPlan(project: ProjectSpec, options: { maxRoomsPerRegion?: number } = {}): ArchitectPlan {
  const p = project.progression;
  const max = options.maxRoomsPerRegion ?? 8;
  const order = regionOrder(project);
  const pinned = project.architect.rooms.filter((r) => r.pinned);
  const rooms: RoomPlan[] = [];
  const links: RoomLink[] = [];
  const byRegion = new Map<string, RoomPlan[]>();
  const enemies = new Set(project.characters.filter((c) => c.kind === "enemy").map((c) => c.id));

  for (const regionId of order) {
    const region = p.regions.find((r) => r.id === regionId)!;
    const count = Math.max(1, Math.min(max, region.rooms));
    const list: RoomPlan[] = [];
    for (let i = 0; i < count; i++) {
      const id = `${regionId}_${i + 1}`;
      const kept = pinned.find((r) => r.id === id);
      list.push(
        kept ??
          RoomPlan.parse({
            id,
            name: `${region.name} ${i + 1}`,
            regionId,
            seed: hash(id),
          }),
      );
    }
    for (let i = 1; i < list.length; i++) links.push(link(`${list[i - 1]!.id}_to_${list[i]!.id}`, list[i - 1]!.id, list[i]!.id));
    byRegion.set(regionId, list);
    rooms.push(...list);
  }

  // Regions join as the progression joins them: the far end of `from` to the near end of `to`.
  const used = new Map<string, number>();
  for (const c of p.connections) {
    const from = byRegion.get(c.from);
    const to = byRegion.get(c.to);
    if (!from?.length || !to?.length) continue;
    const n = used.get(c.from) ?? 0;
    used.set(c.from, n + 1);
    const a = from[Math.max(0, from.length - 1 - n)]!;
    // A built gate only blocks a -> b: a gated two-way connection gets its gate on the side the player meets
    // first (the region earlier in play order), whichever way round the progression lists it.
    const reversed = !c.oneWay && c.requires.length > 0 && order.indexOf(c.to) < order.indexOf(c.from);
    links.push(reversed ? { ...link(c.id, to.at(-1)!.id, from[0]!.id), requires: [...c.requires] } : { ...link(c.id, a.id, to[0]!.id), requires: [...c.requires], oneWay: c.oneWay });
  }

  const add = (room: RoomPlan | undefined, content: RoomContent) => {
    if (room && !room.pinned) room.contents.push(content);
  };
  const mid = (list: RoomPlan[]) => list[Math.floor(list.length / 2)];

  if (p.start) add(byRegion.get(p.start)?.[0], { kind: "start" });
  if (p.ending) add(byRegion.get(p.ending)?.at(-1), { kind: "ending", after: "touch" });

  for (const ability of p.abilities) {
    let list = ability.obtainedIn ? byRegion.get(ability.obtainedIn.regionId) : undefined;
    if (!list?.length) continue;
    // Behind other abilities inside its region: its own room, reached through a link that requires them.
    const inner = ability.obtainedIn!.requires;
    if (inner.length > 0) {
      const id = `${ability.id}_cache`;
      const from = mid(list)!;
      const cache = pinned.find((r) => r.id === id) ?? RoomPlan.parse({ id, name: `${ability.name} cache`, regionId: from.regionId, seed: hash(id) });
      rooms.push(cache);
      links.push({ ...link(`${from.id}_to_${id}`, from.id, id), requires: [...inner] });
      list = [cache];
    }
    const region = p.regions.find((r) => r.id === ability.obtainedIn!.regionId)!;
    const guardian = ability.obtainedIn!.source === "boss" ? (region.boss ?? region.enemies[0]) : undefined;
    if (guardian && enemies.has(guardian)) {
      const room = list.at(-1)!;
      const existing = room.contents.find((c): c is Extract<RoomContent, { kind: "enemy" }> => c.kind === "enemy" && c.characterId === guardian && c.lockRoom);
      if (existing) existing.grants.push(ability.id);
      else add(room, { kind: "enemy", characterId: guardian, count: 1, lockRoom: true, grants: [ability.id], healthBar: true });
      if (!room.pinned) room.terrain = { ...room.terrain, open: 0.8, density: 0.3 };
    } else {
      add(mid(list), { kind: "pickup", grants: ability.id });
    }
  }

  for (const regionId of order) {
    const region = p.regions.find((r) => r.id === regionId)!;
    const list = byRegion.get(regionId)!;
    const pool = region.enemies.filter((e) => enemies.has(e) && e !== region.boss);
    list.forEach((room, i) => {
      if (room.pinned || room.contents.some((c) => c.kind === "enemy" && c.lockRoom) || pool.length === 0) return;
      if (room.contents.some((c) => c.kind === "start")) return;
      add(room, { kind: "enemy", characterId: pool[i % pool.length]!, count: 1 + (i % 2), lockRoom: false, grants: [], healthBar: false });
    });
    if (list.length > 2) add(mid(list), { kind: "save" });
  }

  return ArchitectPlan.parse({
    ...project.architect,
    rooms,
    links: dedupeLinks(links),
    stages: project.architect.stages,
  });
}

/** Regions in the order the player meets them (breadth first from the start), then the rest. */
export function regionOrder(project: ProjectSpec): string[] {
  const p = project.progression;
  const seen: string[] = p.start ? [p.start] : [];
  for (let i = 0; i < seen.length; i++) {
    for (const c of p.connections) {
      if (c.from === seen[i] && !seen.includes(c.to)) seen.push(c.to);
      if (!c.oneWay && c.to === seen[i] && !seen.includes(c.from)) seen.push(c.from);
    }
  }
  return [...seen, ...p.regions.map((r) => r.id).filter((id) => !seen.includes(id))];
}

const link = (id: string, a: string, b: string): RoomLink => ({ id, a: { room: a }, b: { room: b }, requires: [], oneWay: false });

function dedupeLinks(links: RoomLink[]): RoomLink[] {
  const ids = new Set<string>();
  return links.map((l) => {
    let id = l.id;
    for (let n = 2; ids.has(id); n++) id = `${l.id}_${n}`;
    ids.add(id);
    return { ...l, id };
  });
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) % 1_000_000;
}
