import { SCHEMA_VERSION } from "./schema.ts";
import { snapPlacement } from "./art/worldSnap.ts";

/**
 * Upgrade a stored project (or history snapshot) to the current schema
 * version. Runs before validation when loading from disk. Each step is a
 * plain function from version N to N+1; unknown input is passed through
 * unchanged so validation can report it.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const steps: Record<number, (project: Json) => Json> = {
  /** v1 -> v2: enemy patrol stats become a one-state patrol behavior. */
  1: (project) => ({
    ...project,
    schemaVersion: 2,
    characters: (Array.isArray(project.characters) ? project.characters : []).map((c: unknown) => {
      if (!isObject(c) || c.kind !== "enemy" || !isObject(c.stats)) return c;
      const { patrolSpeed, patrolDistance } = c.stats;
      return {
        ...c,
        stats: { knockback: 350 },
        behavior: {
          initial: "patrol",
          states: {
            patrol: { action: { type: "patrol", speed: patrolSpeed, distance: patrolDistance }, transitions: [] },
          },
        },
      };
    }),
  }),

  /** v2 -> v3: spawns get stable ids (`<characterId>_<n>`). */
  2: (project) => {
    const sandbox = isObject(project.sandbox) ? project.sandbox : {};
    const counts = new Map<string, number>();
    const spawns = (Array.isArray(sandbox.spawns) ? sandbox.spawns : []).map((s: unknown) => {
      if (!isObject(s)) return s;
      const base = String(s.characterId);
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      return { id: `${base}_${n}`, ...s };
    });
    return { ...project, schemaVersion: 3, sandbox: { ...sandbox, spawns } };
  },

  /**
   * v3 -> v4: world pieces composed before snapping existed can sit wholly
   * outside their room (e.g. a beam at y 0, above the top edge), where they
   * can't be seen or picked. Snap just those back in; the rest stay put.
   */
  3: (project) => {
    const sandbox = isObject(project.sandbox) ? project.sandbox : {};
    const platforms = (Array.isArray(sandbox.platforms) ? sandbox.platforms : []).filter((r) => isObject(r) && !r.breakable);
    const room = {
      width: Math.max(960, Number(sandbox.width) || 0),
      height: Math.max(360, Number(sandbox.height) || 0),
      platforms: platforms as { x: number; y: number; width: number; height: number }[],
    };
    const art = isObject(project.art) ? project.art : {};
    const assets = (Array.isArray(art.assets) ? art.assets : []).map((asset: unknown) => {
      if (!isObject(asset) || asset.kind !== "biome" || !isObject(asset.kit) || !Array.isArray(asset.kit.pieces) || !Array.isArray(asset.rooms)) return asset;
      const pieces = asset.kit.pieces as { id: string; kind: "structure" | "decor" | "light" | "hanging" | "span"; size: number; width: number; height: number }[];
      const rooms = asset.rooms.map((r: unknown) => {
        if (!isObject(r) || !isObject(r.composition) || !Array.isArray(r.composition.placements)) return r;
        const placements = r.composition.placements as { piece: string; layer: "far" | "mid" | "back" | "play" | "front"; x: number; y: number; scale?: number }[];
        const fixed = placements.map((placement) => {
          const piece = pieces.find((p) => p.id === placement.piece);
          if (!piece || placement.layer === "front") return placement;
          const height = piece.size * (placement.scale ?? 1);
          const outside =
            piece.kind === "hanging" ? placement.y + height <= 0 || placement.y >= room.height : placement.y <= 0 || placement.y - height >= room.height;
          return outside ? snapPlacement(placement, piece, room, { placements, pieces }).placement : placement;
        });
        return { ...r, composition: { ...r.composition, placements: fixed } };
      });
      return { ...asset, rooms };
    });
    return { ...project, schemaVersion: 4, ...(isObject(project.art) && { art: { ...art, assets } }) };
  },
};

export function migrateProject(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  let project = raw;
  while (typeof project.schemaVersion === "number" && project.schemaVersion < SCHEMA_VERSION) {
    const step = steps[project.schemaVersion];
    if (!step) break;
    project = step(project);
  }
  return project;
}
