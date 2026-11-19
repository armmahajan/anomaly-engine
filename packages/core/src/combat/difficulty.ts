import type { Action } from "../behavior.ts";
import type { Handler } from "../events/events.ts";
import type { Character, EnemyCharacter, ProjectSpec } from "../schema.ts";
import type { WorldRoom as Room } from "../world/world.ts";
import { progressionReport } from "../progression/report.ts";
import { regionOrder } from "../architect/seedPlan.ts";
import type { StageIssue, StageOutcome } from "../architect/stages.ts";
import { weaponHealthCap } from "./weaponLint.ts";

/**
 * Difficulty by region (agent M owns this file): enemy stats rise with how deep in
 * the game the regions they appear in are (the progression's region order), so the
 * later regions are harder. Generic: works on any enemy character, from its spawns.
 * Used by the Architect's cast stage after the characters exist.
 *
 * A character as written is its first-depth self. Where it spawns deeper, those spawns
 * are pointed at a *variant* (`variantOf` it, id `<id>_d<depth>`): the same look,
 * behavior and art, with scaled stats. Variants are derived, never edited: every run
 * first folds them back into their originals, then makes them again, so running it
 * twice changes nothing and editing the original carries over. Pinned rooms (the
 * creator's) are left as they are.
 */

/** How much tougher each depth is than the one before (multipliers of the original's values). */
export const DIFFICULTY_CURVE = {
  /** Health × (1 + health × depth) rounded up, at most × healthMax (so always at least +1 deeper than the first depth). */
  health: 0.3,
  healthMax: 2.5,
  /** Contact damage and attack damage × (1 + damage × depth), rounded, at most × damageMax (0 stays 0). */
  damage: 0.3,
  damageMax: 2,
  /** Speed of its own movement (patrol, chase, charge, retreat, returnHome) × (1 + speed × depth), at most × speedMax. */
  speed: 0.05,
  speedMax: 1.2,
} as const;

/** Actions whose `speed` moves the enemy itself (projectile and shockwave speeds stay: they are dodged by timing). */
const OWN_SPEED = new Set<Action["type"]>(["patrol", "chase", "charge", "retreat", "returnHome"]);

/**
 * How deep each region is: 0 for where the game starts, then one more for each step
 * further. Regions are ordered by the progression's spheres (what the player must
 * collect first, progressionReport) and then by how many connections they are from
 * the start (regionOrder's walk); regions the start can't reach come last. Regions at
 * the same sphere and distance share a depth.
 */
export function regionDepths(project: ProjectSpec): Record<string, number> {
  const p = project.progression;
  const order = regionOrder(project);
  const hops = new Map<string, number>(p.start ? [[p.start, 0]] : []);
  for (const at of order) {
    const h = hops.get(at);
    if (h === undefined) continue;
    for (const c of p.connections) {
      const next = c.from === at ? c.to : !c.oneWay && c.to === at ? c.from : undefined;
      if (next !== undefined && !hops.has(next)) hops.set(next, h + 1);
    }
  }
  const spheres = progressionReport(project).regionSphere;
  const far = order.length + 1;
  const key = (id: string) => [spheres[id] ?? far, hops.get(id) ?? far] as const;
  const keys = [...new Set(order.map((id) => key(id).join(":")))]
    .map((k) => k.split(":").map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((k) => k.join(":"));
  return Object.fromEntries(order.map((id) => [id, keys.indexOf(key(id).join(":"))]));
}

/**
 * The stats and behavior of `original` at `depth` (depth 0: unchanged). `healthCap`: scaled health
 * stops there (the most the player's weapons can beat in a fair number of hits), though never
 * below the original's own.
 */
export function scaleEnemy(original: EnemyCharacter, depth: number, healthCap: number | null = null): Pick<EnemyCharacter, "stats" | "behavior"> {
  if (depth <= 0) return { stats: original.stats, behavior: original.behavior };
  const c = DIFFICULTY_CURVE;
  const damage = (n: number, max: number) => (n <= 0 ? n : Math.min(max, Math.round(n * Math.min(c.damageMax, 1 + c.damage * depth))));
  const { health } = original.stats;
  const stats = {
    ...original.stats,
    health: Math.max(health, Math.min(999, healthCap ?? 999, Math.ceil(health * Math.min(c.healthMax, 1 + c.health * depth) - 1e-9))),
    contactDamage: damage(original.stats.contactDamage, 20),
  };
  const speed = Math.min(c.speedMax, 1 + c.speed * depth);
  const scaleAction = (action: Action): Action => {
    let out = action;
    if ("damage" in out) out = { ...out, damage: damage(out.damage, 20) } as Action;
    if (OWN_SPEED.has(out.type) && "speed" in out) out = { ...out, speed: Math.min(2000, Math.round(out.speed * speed)) } as Action;
    return out;
  };
  const states = Object.fromEntries(Object.entries(original.behavior.states).map(([id, s]) => [id, { ...s, action: scaleAction(s.action) }]));
  return { stats, behavior: { ...original.behavior, states } };
}

/** Rooms no stage rewrites (the creator's: RoomPlan.pinned; a plan room's id is its world room's). */
const pinnedRooms = (project: ProjectSpec) => new Set(project.architect.rooms.filter((r) => r.pinned).map((r) => r.id));

const isEnemy = (c: Character): c is EnemyCharacter => c.kind === "enemy";
const killedBy = (h: Handler) => (h.on.type === "enemyKilled" ? h.on.character : undefined);
const withKiller = (h: Handler, character: string): Handler => (h.on.type === "enemyKilled" ? ({ ...h, on: { ...h.on, character } } as Handler) : h);
const mapActions = (c: EnemyCharacter, f: (a: Action) => Action): EnemyCharacter => ({
  ...c,
  behavior: { ...c.behavior, states: Object.fromEntries(Object.entries(c.behavior.states).map(([id, s]) => [id, { ...s, action: f(s.action) }])) },
});
const summonsOf = (c: EnemyCharacter) => Object.values(c.behavior.states).flatMap((s) => (s.action.type === "summon" ? [s.action.character] : []));
const MAX_WORLD_HANDLERS = 50;

/** Every room's handlers, its spawns' and its props' with `f` applied. */
function mapRoomHandlers(room: Room, f: (h: Handler) => Handler): Room {
  return {
    ...room,
    handlers: room.handlers.map(f),
    spawns: room.spawns.map((s) => ({ ...s, handlers: s.handlers.map(f) })),
    props: room.props.map((p) => ({ ...p, handlers: p.handlers.map(f) })),
  };
}

/**
 * Fold variants back into their originals (outside pinned rooms): spawns, summons and
 * enemyKilled handlers name the original again, the world's per-variant handler copies
 * go, and variants nothing pinned uses are removed. What's left is the project as if
 * difficulty had never run.
 */
function foldVariants(project: ProjectSpec, pinned: Set<string>): ProjectSpec {
  const originalOf = new Map(project.characters.flatMap((c) => (isEnemy(c) && c.variantOf ? [[c.id, c.variantOf] as const] : [])));
  if (originalOf.size === 0) return project;
  const base = (id: string) => originalOf.get(id) ?? id;
  const keep = new Set(project.world.rooms.filter((r) => pinned.has(r.id)).flatMap((r) => r.spawns.map((s) => s.characterId)).filter((id) => originalOf.has(id)));
  const unfold = (h: Handler) => {
    const k = killedBy(h);
    return k !== undefined && originalOf.has(k) && !keep.has(k) ? withKiller(h, base(k)) : h;
  };
  // World handlers: a copy made for a variant goes when its original's handler is there.
  const world: Handler[] = [];
  for (const h of project.world.handlers) {
    const folded = unfold(h);
    if (folded !== h && world.some((w) => JSON.stringify(w) === JSON.stringify(folded))) continue;
    world.push(folded);
  }
  const characters = project.characters
    .filter((c) => !originalOf.has(c.id) || keep.has(c.id))
    .map((c) => (isEnemy(c) && !keep.has(c.id) ? mapActions(c, (a) => (a.type === "summon" && !keep.has(a.character) ? { ...a, character: base(a.character) } : a)) : c));
  return {
    ...project,
    characters,
    world: {
      ...project.world,
      handlers: world,
      rooms: project.world.rooms.map((r) =>
        pinned.has(r.id) ? r : mapRoomHandlers({ ...r, spawns: r.spawns.map((s) => ({ ...s, characterId: base(s.characterId) })) }, unfold),
      ),
    },
  };
}

/** The Architect's difficulty pass: enemies that appear deeper get tougher variants there (see the top of this file). */
export function difficultyStage(project: ProjectSpec): StageOutcome {
  const issues: StageIssue[] = [];
  const pinned = pinnedRooms(project);
  const oldAppearance = new Map(project.characters.flatMap((c) => (isEnemy(c) && c.variantOf && c.appearance ? [[c.id, c.appearance] as const] : [])));
  const folded = foldVariants(project, pinned);
  const depths = regionDepths(folded);
  const planRegion = new Map(folded.architect.rooms.map((r) => [r.id, r.regionId]));
  const regionOf = (room: Room) => room.regionId ?? planRegion.get(room.id);
  const depthOf = (room: Room) => depths[regionOf(room) ?? ""] ?? 0;
  const enemies = new Map(folded.characters.filter(isEnemy).map((c) => [c.id, c]));
  const originals = [...enemies.values()].filter((c) => !c.variantOf);

  // Depths each original is needed at: where it spawns, and where what summons it is needed.
  const need = new Map<string, Set<number>>(originals.map((c) => [c.id, new Set<number>()]));
  const regionsAt = new Map<string, Set<string>>(); // `${id}:${depth}` -> region ids it spawns in
  for (const room of folded.world.rooms) {
    const d = depthOf(room);
    if (d === 0 || pinned.has(room.id)) continue;
    for (const s of room.spawns) {
      if (!need.has(s.characterId)) continue;
      need.get(s.characterId)!.add(d);
      const key = `${s.characterId}:${d}`;
      regionsAt.set(key, new Set([...(regionsAt.get(key) ?? []), ...(regionOf(room) ? [regionOf(room)!] : [])]));
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of originals) {
      for (const target of summonsOf(c)) {
        const into = need.get(target);
        if (!into || target === c.id) continue;
        for (const d of need.get(c.id)!) {
          if (!into.has(d)) {
            into.add(d);
            changed = true;
          }
        }
      }
    }
  }

  // Variant ids: <id>_d<depth>, unless that names some other character (a variant kept for a pinned room is remade in place).
  const taken = new Set(folded.characters.map((c) => c.id));
  const ids = new Map<string, string>();
  for (const c of originals) {
    for (const d of [...need.get(c.id)!].sort((a, b) => a - b)) {
      const stem = `${c.id}_d${d}`.slice(0, 60);
      let vid = stem;
      for (let n = 2; taken.has(vid) && enemies.get(vid)?.variantOf !== c.id; n++) vid = `${stem}_${n}`;
      taken.add(vid);
      ids.set(`${c.id}:${d}`, vid);
    }
  }
  const variantId = (id: string, d: number) => ids.get(`${id}:${d}`)!;
  const remade = new Set(ids.values());
  const regionName = (id: string) => folded.progression.regions.find((r) => r.id === id)?.name ?? id;
  const order = regionOrder(folded);
  // Deeper enemies get tougher, but never past what the player's weakest weapon beats in a fair number of hits.
  const healthCap = weaponHealthCap(folded);

  // Each original, then its variants by depth.
  const characters: Character[] = [];
  const made: EnemyCharacter[] = [];
  for (const c of folded.characters) {
    if (remade.has(c.id)) continue;
    characters.push(c);
    if (!isEnemy(c) || c.variantOf) continue;
    for (const d of [...(need.get(c.id) ?? [])].sort((a, b) => a - b)) {
      const vid = variantId(c.id, d);
      const regions = [...(regionsAt.get(`${c.id}:${d}`) ?? [])].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const where = regions.length > 0 ? regions.map(regionName).join(", ") : `depth ${d}`;
      const scaled = scaleEnemy(c, d, healthCap);
      const appearance = c.appearance ?? oldAppearance.get(vid);
      const variant: EnemyCharacter = mapActions(
        { ...structuredClone(c), id: vid, name: `${c.name} (${where})`.slice(0, 80), stats: scaled.stats, behavior: scaled.behavior, variantOf: c.id, ...(appearance ? { appearance } : {}) },
        (a) => (a.type === "summon" && need.get(a.character)?.has(d) ? { ...a, character: variantId(a.character, d) } : a),
      );
      characters.push(variant);
      made.push(variant);
    }
  }

  // Spawns and the handlers of unpinned rooms point at their depth's variant.
  let repointed = 0;
  const rooms = folded.world.rooms.map((room) => {
    const d = depthOf(room);
    if (d === 0 || pinned.has(room.id)) return room;
    const at = (id: string) => (need.get(id)?.has(d) ? variantId(id, d) : id);
    const spawns = room.spawns.map((s) => {
      const to = at(s.characterId);
      if (to !== s.characterId) repointed++;
      return { ...s, characterId: to };
    });
    return mapRoomHandlers({ ...room, spawns }, (h) => {
      const k = killedBy(h);
      return k !== undefined ? withKiller(h, at(k)) : h;
    });
  });
  // World handlers on an original's death answer its variants' deaths too: one copy per variant.
  const handlers: Handler[] = [];
  let budget = MAX_WORLD_HANDLERS - folded.world.handlers.length;
  const same = (a: Handler) => (b: Handler) => JSON.stringify(a) === JSON.stringify(b);
  for (const h of folded.world.handlers) {
    handlers.push(h);
    const k = killedBy(h);
    if (k === undefined || !need.has(k)) continue;
    for (const d of [...need.get(k)!].sort((a, b) => a - b)) {
      const copy = withKiller(h, variantId(k, d));
      if (folded.world.handlers.some(same(copy)) || handlers.some(same(copy))) continue; // kept for a pinned room
      if (budget <= 0) {
        issues.push({ stage: "cast", code: "difficulty-handlers", message: `the world has too many handlers to copy its enemyKilled "${k}" handler for "${copy.on.type === "enemyKilled" ? copy.on.character : ""}"` });
        continue;
      }
      budget--;
      handlers.push(copy);
    }
  }

  const next: ProjectSpec = { ...folded, characters, world: { ...folded.world, rooms, handlers } };
  const byDepth = new Map<number, string[]>();
  for (const id of order) byDepth.set(depths[id]!, [...(byDepth.get(depths[id]!) ?? []), regionName(id)]);
  const curve = [...byDepth].map(([d, names]) => `${d}: ${names.join(", ")}`).join("; ");
  const originalsScaled = new Set(made.map((v) => v.variantOf)).size;
  const summary =
    made.length === 0
      ? `difficulty: no enemy appears deeper than the first region depth, nothing to scale${curve ? ` (depths ${curve})` : ""}`
      : `difficulty: ${made.length} tougher variant${made.length === 1 ? "" : "s"} of ${originalsScaled} enem${originalsScaled === 1 ? "y" : "ies"} (${made
          .map((v) => `${v.id}: health ${v.stats.health}, contact ${v.stats.contactDamage}`)
          .join("; ")}), ${repointed} spawn${repointed === 1 ? "" : "s"} repointed; depths ${curve}`;
  return { project: next, issues, summary };
}
