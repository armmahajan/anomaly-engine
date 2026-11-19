import { expect } from "vitest";
import {
  borderedGrid,
  createDefaultProject,
  fillTiles,
  linkDoorId,
  newEnemyCharacter,
  populationStage,
  ProjectSpec,
  screensStage,
  validateProject,
  type Door,
  type ProjectSpec as Project,
  type RoomContent,
  type TileGrid,
} from "../src/index.ts";

// A small game built by hand up to the population stage: plan rooms with their
// world rooms (tiles and doors named as the geometry stage names them), and the
// progression they come from. Population and screens fill them; the checker proves
// the result.
//
//   cave_1 (start, save) - cave_2 (rusty key, crawlers) =rusty key=> depths_1 (charger, save)
//   - depths_2 (the warden locks the room, grants wings = double jump) =wings=> peak_1 (ending)

export const FLOOR = 13; // floor row of a 14-row bordered room: feet at 416 px

const side = (id: string, s: Door["side"], offset: number, toRoom: string, toDoor: string): Door => ({ id, side: s, offset, size: 3, to: { room: toRoom, door: toDoor } });
/** A bordered room with its doors cut out of the border. */
function room(id: string, regionId: string, grid: TileGrid, doors: Door[], x: number, y = 0) {
  let g = grid;
  for (const d of doors) {
    const cols = g.rows[0]!.length;
    const rows = g.rows.length;
    g =
      d.side === "left" || d.side === "right"
        ? fillTiles(g, { col: d.side === "left" ? 0 : cols - 1, row: d.offset, cols: 1, rows: d.size }, "empty")
        : fillTiles(g, { col: d.offset, row: d.side === "top" ? 0 : rows - 1, cols: d.size, rows: 1 }, "empty");
  }
  return { id, name: id.replace("_", " "), regionId, grid: g, at: { x, y }, doors, spawns: [], props: [], handlers: [] };
}

const link = (id: string, a: string, b: string, requires: string[] = []) => ({ id, a: { room: a }, b: { room: b }, requires, oneWay: false });

export interface Options {
  /** Contents per plan room (default: the game above). */
  contents?: Partial<Record<string, RoomContent[]>>;
  rules?: { onDeath?: "room" | "start" | "checkpoint"; save?: "room" | "never" };
  pinned?: string[];
}

export function handBuiltProject(options: Options = {}): Project {
  const base = createDefaultProject();
  const L = (l: string) => linkDoorId(l, "a");
  const R = (l: string) => linkDoorId(l, "b");
  // depths_2: a 7-tile pillar under the high exit: one jump doesn't reach it, a double jump does.
  const pillar = fillTiles(borderedGrid(30, 14), { col: 24, row: FLOOR - 7, cols: 5, rows: 7 }, "solid");
  const peak = borderedGrid(20, 8);
  const rooms = [
    room("cave_1", "cave", borderedGrid(30, 14), [side(L("c1_c2"), "right", 10, "cave_2", R("c1_c2"))], 0),
    room("cave_2", "cave", borderedGrid(30, 14), [side(R("c1_c2"), "left", 10, "cave_1", L("c1_c2")), side(L("cave_to_depths"), "right", 10, "depths_1", R("cave_to_depths"))], 30),
    room("depths_1", "depths", borderedGrid(30, 14), [side(R("cave_to_depths"), "left", 10, "cave_2", L("cave_to_depths")), side(L("d1_d2"), "right", 10, "depths_2", R("d1_d2"))], 60),
    room("depths_2", "depths", pillar, [side(R("d1_d2"), "left", 10, "depths_1", L("d1_d2")), side(L("depths_to_peak"), "right", FLOOR - 7 - 3, "peak_1", R("depths_to_peak"))], 90),
    room("peak_1", "peak", peak, [side(R("depths_to_peak"), "left", 4, "depths_2", L("depths_to_peak"))], 120, 3),
  ];
  const contents: Record<string, RoomContent[]> = {
    cave_1: [{ kind: "start" }, { kind: "save" }],
    cave_2: [
      { kind: "pickup", grants: "rusty_key" },
      { kind: "enemy", characterId: "crawler", count: 2, lockRoom: false, grants: [], healthBar: false },
    ],
    depths_1: [{ kind: "enemy", characterId: "charger", count: 1, lockRoom: false, grants: [], healthBar: false }, { kind: "save" }],
    depths_2: [{ kind: "enemy", characterId: "warden", count: 1, lockRoom: true, grants: ["wings"], healthBar: true }],
    peak_1: [{ kind: "ending", after: "touch" }],
    ...options.contents,
  } as Record<string, RoomContent[]>;
  const plan = (id: string, regionId: string) => ({ id, name: id, regionId, contents: contents[id] ?? [], pinned: options.pinned?.includes(id) ?? false });
  const page = (id: string, kind: string, title: string, summary: string) => ({ id, kind, title, summary, body: "", fields: {}, status: "canon" as const });
  return ProjectSpec.parse({
    ...base,
    name: "Hollow Deep",
    characters: [...base.characters, { ...newEnemyCharacter("warden", "The Warden", "#7d8a99"), size: { width: 48, height: 64 }, stats: { knockback: 420, health: 8, contactDamage: 1 } }],
    wiki: {
      pages: [
        page("overview", "overview", "Hollow Deep", "A lantern-bearer descends into the [[cave]] and climbs to the [[peak]]."),
        page("cave", "place", "The Cave", "Wet stone and old roots."),
        page("peak", "place", "The Peak", "Wind and open sky at the top of the world."),
        page("wings_page", "ability", "Wings", "Moth wings, torn from the Warden."),
      ],
    },
    progression: {
      start: "cave",
      ending: "peak",
      abilities: [
        { id: "rusty_key", name: "Rusty Key", mechanic: "key", obtainedIn: { regionId: "cave", source: "pickup", requires: [] }, status: "canon" },
        { id: "wings", name: "Wings", mechanic: "double_jump", obtainedIn: { regionId: "depths", source: "boss", requires: [] }, wikiPageId: "wings_page", status: "canon" },
      ],
      regions: [
        { id: "cave", name: "The Cave", rooms: 2, enemies: ["crawler"], wikiPageId: "cave", status: "canon" },
        { id: "depths", name: "The Depths", rooms: 2, enemies: ["charger"], boss: "warden", status: "canon" },
        { id: "peak", name: "The Peak", rooms: 1, enemies: [], wikiPageId: "peak", status: "canon" },
      ],
      connections: [
        { id: "cave_to_depths", from: "cave", to: "depths", requires: ["rusty_key"], status: "canon" },
        { id: "depths_to_peak", from: "depths", to: "peak", requires: ["wings"], status: "canon" },
      ],
      beats: [],
    },
    architect: {
      rooms: [plan("cave_1", "cave"), plan("cave_2", "cave"), plan("depths_1", "depths"), plan("depths_2", "depths"), plan("peak_1", "peak")],
      links: [link("c1_c2", "cave_1", "cave_2"), link("cave_to_depths", "cave_2", "depths_1", ["rusty_key"]), link("d1_d2", "depths_1", "depths_2"), link("depths_to_peak", "depths_2", "peak_1", ["wings"])],
    },
    world: { ...base.world, rooms, start: null, playtest: null, rules: { onDeath: "room", save: "room", hazardDamage: 1, ...options.rules } },
  });
}

/** Population then screens, failing on any stage issue. */
export function build(project: Project): Project {
  const populated = populationStage(project);
  expect(populated.issues).toEqual([]);
  const screened = screensStage(populated.project);
  expect(screened.issues).toEqual([]);
  const valid = validateProject(screened.project);
  if (!valid.ok) throw new Error(valid.issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
  return valid.project;
}

