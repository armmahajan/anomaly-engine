import { SCHEMA_VERSION, type EnemyCharacter, type ProjectSpec } from "./schema.ts";
import { defaultWiki } from "./wiki/wiki.ts";
import { defaultProgression } from "./progression/progression.ts";
import { defaultAbilityTuning } from "./movement/params.ts";
import { borderedGrid, fillTiles, TILE, type TileGrid } from "./world/tiles.ts";
import { defaultWorld } from "./world/world.ts";
import { defaultArtSection } from "./art/asset.ts";

/** Starter project: one room, the arena, with a patroller and a charger; ▶ Play tests there. */
export function createDefaultProject(): ProjectSpec {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "untitled",
    name: "Untitled Game",
    revision: 0,
    characters: [
      {
        id: "player",
        kind: "player",
        name: "Wanderer",
        color: "#e8e3d3",
        size: { width: 28, height: 44 },
        stats: {
          runSpeed: 320,
          jumpVelocity: 760,
          health: 5,
          attackDamage: 1,
          attackReach: 56,
          attackCooldown: 0.35,
          pogoVelocity: 620,
          maxFallSpeed: 1100,
          coyoteTime: 0.1,
          jumpBuffer: 0.12,
        },
        abilities: defaultAbilityTuning(),
      },
      {
        id: "crawler",
        kind: "enemy",
        movement: "ground",
        name: "Crawler",
        color: "#c0504d",
        size: { width: 40, height: 28 },
        stats: { knockback: 350, health: 2, contactDamage: 1 },
        behavior: {
          initial: "patrol",
          states: {
            patrol: { action: { type: "patrol", speed: 120, distance: 420, turnAtLedge: false, turnAtWall: true }, transitions: [] },
          },
          interrupts: [],
        },
      },
      {
        id: "charger",
        kind: "enemy",
        movement: "ground",
        name: "Charger",
        color: "#8e6cc2",
        size: { width: 44, height: 36 },
        stats: { knockback: 650, health: 4, contactDamage: 1 },
        behavior: {
          initial: "patrol",
          states: {
            patrol: {
              action: { type: "patrol", speed: 60, distance: 200, turnAtLedge: false, turnAtWall: true },
              transitions: [{ when: { type: "playerWithin", distance: 260 }, and: [{ type: "playerLevel", margin: 60 }], to: "windup" }],
            },
            windup: {
              action: { type: "telegraph", color: "#ffd27a", shake: false },
              transitions: [{ when: { type: "after", seconds: 0.6 }, to: "charge" }],
            },
            charge: {
              action: { type: "charge", speed: 520, direction: "horizontal" },
              transitions: [
                { when: { type: "hitWall" }, to: "recover" },
                { when: { type: "after", seconds: 0.9 }, to: "recover" },
              ],
            },
            recover: {
              action: { type: "wait" },
              transitions: [{ when: { type: "after", seconds: 0.8 }, to: "patrol" }],
            },
          },
          interrupts: [],
        },
      },
    ],
    wiki: defaultWiki(),
    progression: defaultProgression(),
    art: defaultArtSection(),
    world: {
      ...defaultWorld(),
      rooms: [
        {
          id: "arena",
          name: "Arena",
          grid: defaultArenaGrid(),
          at: { x: 0, y: 0 },
          doors: [],
          spawns: [
            { id: "crawler_1", characterId: "crawler", x: 1150, y: ARENA_FLOOR },
            { id: "charger_1", characterId: "charger", x: 640, y: ARENA_FLOOR },
          ],
          dressing: null,
        },
      ],
      start: { room: "arena", x: 160, y: ARENA_FLOOR },
      playtest: { room: "arena", x: 160, y: ARENA_FLOOR, abilities: [] },
    },
  };
}

/** Top of the default arena's floor, px. */
export const ARENA_FLOOR = 21 * TILE;

/**
 * The starter arena: 50 x 23 tiles (1600 x 736 px) with walls, a ceiling and
 * a two-tile floor; a ledge (x 384-608, top y 544) and a breakable block
 * (x 736-928, y 416-448) to stand on.
 */
export function defaultArenaGrid(): TileGrid {
  let grid = borderedGrid(50, 23);
  grid = fillTiles(grid, { col: 0, row: 21, cols: 50, rows: 1 }, "solid");
  grid = fillTiles(grid, { col: 12, row: 17, cols: 7, rows: 1 }, "ledge");
  grid = fillTiles(grid, { col: 23, row: 13, cols: 6, rows: 1 }, "breakable");
  return grid;
}

/** A plain patrolling enemy: the starting point for "+ Enemy" in the studio. */
export function newEnemyCharacter(id: string, name: string, color = "#5f9e6e"): EnemyCharacter {
  return {
    id,
    kind: "enemy",
    movement: "ground",
    name,
    color,
    size: { width: 36, height: 32 },
    stats: { knockback: 350, health: 2, contactDamage: 1 },
    behavior: {
      initial: "patrol",
      states: {
        patrol: { action: { type: "patrol", speed: 100, distance: 300, turnAtLedge: true, turnAtWall: true }, transitions: [] },
      },
      interrupts: [],
    },
  };
}
