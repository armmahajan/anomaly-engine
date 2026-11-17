import { SCHEMA_VERSION } from "./schema.ts";
import { snapPlacement } from "./art/worldSnap.ts";
import { fillTiles, isOpen, rectsToGrid, TILE, type TileGrid } from "./world/tiles.ts";

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

  /**
   * v4 -> v5: the arena's platform rectangles become a 32 px tile grid (its
   * size is the grid's). Walls, floor and ceiling that sat outside the old
   * arena's edges become its border tiles; spawns left inside a solid tile
   * move up out of it.
   */
  4: (project) => {
    const { width: w, height: h, platforms, ...sandbox } = isObject(project.sandbox) ? project.sandbox : ({} as Json);
    const width = Number(w) || 1600;
    const height = Number(h) || 720;
    const cols = Math.max(4, Math.ceil(width / TILE));
    const rows = Math.max(4, Math.ceil(height / TILE));
    type R = { x: number; y: number; width: number; height: number; breakable?: boolean };
    const rects = (Array.isArray(platforms) ? platforms : []).filter(isObject) as unknown as R[];
    let grid: TileGrid = rectsToGrid(rects, cols, rows);
    const tall = (r: R) => r.height >= height / 2;
    const wide = (r: R) => r.width >= width / 2;
    if (rects.some((r) => r.x + r.width <= 0 && tall(r))) grid = fillTiles(grid, { col: 0, row: 0, cols: 1, rows }, "solid");
    if (rects.some((r) => r.x >= width && tall(r))) grid = fillTiles(grid, { col: cols - 1, row: 0, cols: 1, rows }, "solid");
    if (rects.some((r) => r.y + r.height <= 0 && wide(r))) grid = fillTiles(grid, { col: 0, row: 0, cols, rows: 1 }, "solid");
    if (rects.some((r) => r.y >= height && wide(r))) grid = fillTiles(grid, { col: 0, row: rows - 1, cols, rows: 1 }, "solid");
    const spawns = (Array.isArray(sandbox.spawns) ? sandbox.spawns : []).map((s: unknown) => {
      if (!isObject(s)) return s;
      const x = Math.min(Math.max(Number(s.x), TILE * 1.5), cols * TILE - TILE * 1.5);
      let y = Number(s.y);
      // A box about a character's size, moved up a tile at a time until it is clear.
      for (let tries = 0; tries < rows && !isOpen(grid, x, y, 28, 40); tries++) y = (Math.ceil(y / TILE) - 1) * TILE;
      return { ...s, x, y };
    });
    return { ...project, schemaVersion: 5, sandbox: { ...sandbox, grid, spawns } };
  },

  /**
   * v5 -> v6: the arena is just a room. It joins the world as room "Arena"
   * (its tiles, enemies and dressing); the player's spawn and the arena's
   * abilities become the world's playtest; gravity and colors move to the world.
   */
  5: (project) => {
    const sandbox = isObject(project.sandbox) ? project.sandbox : {};
    const world = isObject(project.world) ? project.world : {};
    const rooms = (Array.isArray(world.rooms) ? world.rooms : []).filter(isObject);
    const players = new Set(
      (Array.isArray(project.characters) ? project.characters : []).filter((c) => isObject(c) && c.kind === "player").map((c) => (c as Json).id),
    );
    const spawns = (Array.isArray(sandbox.spawns) ? sandbox.spawns : []).filter(isObject);
    const playerSpawn = spawns.find((s) => players.has(s.characterId));
    const taken = new Set(rooms.map((r) => r.id));
    let id = "arena";
    for (let n = 2; taken.has(id); n++) id = `arena_${n}`;
    const grid = isObject(sandbox.grid) ? sandbox.grid : { rows: [] };
    const cols = Array.isArray(grid.rows) && typeof grid.rows[0] === "string" ? grid.rows[0].length : 0;
    const left = Math.min(0, ...rooms.map((r) => (isObject(r.at) ? Number(r.at.x) || 0 : 0)));
    const arena = {
      id,
      name: "Arena",
      grid,
      at: { x: rooms.length ? left - cols - 4 : 0, y: 0 },
      doors: [],
      spawns: spawns.filter((s) => !players.has(s.characterId)),
      dressing: sandbox.dressing ?? null,
    };
    const { sandbox: _sandbox, ...rest } = project;
    return {
      ...rest,
      schemaVersion: 6,
      world: {
        ...world,
        gravity: sandbox.gravity ?? 1800,
        backgroundColor: sandbox.backgroundColor ?? "#1b2030",
        platformColor: sandbox.platformColor ?? "#4a5470",
        rooms: [arena, ...rooms],
        playtest: { room: id, x: Number(playerSpawn?.x ?? 160), y: Number(playerSpawn?.y ?? 0), abilities: sandbox.playerAbilities ?? [] },
      },
    };
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
