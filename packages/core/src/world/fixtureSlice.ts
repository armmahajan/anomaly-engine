import { ProjectSpec as ProjectSchema, type ProjectSpec } from "../schema.ts";
import { fillTiles, TILE } from "./tiles.ts";
import { fixtureProject } from "./fixture.ts";
import { WorldRoom } from "./world.ts";

/**
 * A playable slice of a game, built only from generic primitives (props,
 * flags, items, modals, handlers, conditional spawns) on the fixture world:
 *
 *   title -> entrance (an item on the ledge) -> hall (a lock post opens the
 *   hatch over the shaft) -> cistern (a save spot) -> spikes -> bridge ->
 *   sanctum (sealed while its guardian lives; winning grants double jump) ->
 *   summit (a door high in the sanctum's wall, only reachable with double
 *   jump; touching the altar ends the game)
 *
 * Content names (key, guardian, altar) live here, in data; no code knows them.
 */

export const SLICE_GUARDIAN = "guardian";
export const SLICE_GATE_ABILITY = "double_jump";

/** The guardian until a richer enemy replaces it: a charger that charges faster below half health. */
export function sliceGuardian(): unknown {
  return {
    id: SLICE_GUARDIAN,
    kind: "enemy",
    name: "Guardian",
    color: "#a05a8c",
    size: { width: 56, height: 72 },
    stats: { knockback: 380, health: 8, contactDamage: 1 },
    movement: "ground",
    behavior: {
      initial: "watch",
      states: {
        watch: { action: { type: "wait" }, transitions: [{ when: { type: "after", seconds: 0.8 }, to: "windup" }] },
        windup: { action: { type: "telegraph", color: "#ffd27a", shake: true }, transitions: [{ when: { type: "after", seconds: 0.6 }, to: "charge" }] },
        charge: { action: { type: "charge", speed: 520 }, transitions: [{ when: { type: "actionDone" }, to: "rest" }] },
        rest: {
          action: { type: "wait" },
          transitions: [
            { when: { type: "healthBelow", fraction: 0.5 }, to: "rage_windup" },
            { when: { type: "after", seconds: 1 }, to: "windup" },
          ],
        },
        rage_windup: { action: { type: "telegraph", color: "#ff6a5a", shake: true }, transitions: [{ when: { type: "after", seconds: 0.45 }, to: "rage_charge" }] },
        rage_charge: { action: { type: "charge", speed: 700 }, transitions: [{ when: { type: "actionDone" }, to: "rage_rest" }] },
        rage_rest: { action: { type: "wait" }, transitions: [{ when: { type: "after", seconds: 0.7 }, to: "rage_windup" }] },
      },
      interrupts: [],
    },
  };
}

const flag = (name: string, is = true) => ({ type: "flag", flag: name, is });

/** The fixture world as a small game, with `guardian` (an enemy character) fighting in the sanctum. */
export function fixtureSliceProject(guardian: unknown = sliceGuardian()): ProjectSpec {
  const base = fixtureProject();
  const rooms = base.world.rooms.map((room): unknown => {
    switch (room.id) {
      case "entrance":
        return {
          ...room,
          props: [{ id: "key", name: "Key", x: 9 * TILE + 4, y: 8 * TILE - 28, width: 24, height: 24, color: "#e8c547", visible: flag("got_key", false), handlers: [{ on: { type: "touch" }, do: [{ type: "giveItem", item: "key" }, { type: "setFlag", flag: "got_key" }] }] }],
        };
      case "hall":
        return {
          ...room,
          props: [
            { id: "hatch", name: "Hatch", x: 30 * TILE, y: 12 * TILE, width: 3 * TILE, height: 12, color: "#8a6a3a", solid: flag("hatch_open", false), visible: flag("hatch_open", false) },
            {
              id: "lock",
              name: "Lock post",
              x: 27 * TILE,
              y: 10 * TILE,
              width: TILE,
              height: 2 * TILE,
              color: "#c9a227",
              prompt: "Unlock",
              visible: flag("hatch_open", false),
              handlers: [
                { on: { type: "interact" }, when: [{ type: "item", item: "key" }], do: [{ type: "takeItem", item: "key" }, { type: "setFlag", flag: "hatch_open" }] },
                { on: { type: "interact" }, when: [{ type: "not", of: { type: "item", item: "key" } }], do: [{ type: "showModal", modal: "locked" }] },
              ],
            },
          ],
        };
      case "cistern":
        return {
          ...room,
          props: [
            {
              id: "rest",
              name: "Save spot",
              x: 2 * TILE,
              y: 15 * TILE,
              width: TILE,
              height: 2 * TILE,
              color: "#5aa8d0",
              prompt: "Rest",
              handlers: [{ on: { type: "interact" }, do: [{ type: "setCheckpoint" }, { type: "heal", amount: null }, { type: "saveRun" }] }],
            },
          ],
        };
      case "sanctum": {
        // A high door to the summit over a platform one jump can't reach from the floor (its old ledge is gone).
        let grid = fillTiles(room.grid, { col: 12, row: 8, cols: 6, rows: 1 }, "empty");
        grid = fillTiles(grid, { col: 29, row: 2, cols: 1, rows: 3 }, "empty");
        grid = fillTiles(grid, { col: 24, row: 5, cols: 5, rows: 1 }, "solid");
        return {
          ...room,
          grid,
          doors: [...room.doors, { id: "up", side: "right", offset: 2, size: 3, to: { room: "summit", door: "down" } }],
          spawns: [
            {
              id: "guardian_1",
              characterId: SLICE_GUARDIAN,
              x: 22 * TILE,
              y: 12 * TILE,
              when: flag("guardian_beaten", false),
              healthBar: { title: "The Guardian" },
              handlers: [
                {
                  on: { type: "enemyKilled" },
                  do: [
                    { type: "setFlag", flag: "guardian_beaten" },
                    { type: "grantAbility", ability: SLICE_GATE_ABILITY },
                    { type: "shake", strength: 12, seconds: 0.5 },
                    { type: "slowMotion", scale: 0.3, seconds: 0.8 },
                    { type: "saveRun" },
                    { type: "showModal", modal: "won" },
                  ],
                },
              ],
            },
          ],
          handlers: [{ on: { type: "roomEntered" }, when: [flag("guardian_beaten", false)], do: [{ type: "setFlag", flag: "sealed" }] }],
          props: [
            {
              id: "seal",
              name: "Seal",
              x: 0,
              y: 9 * TILE,
              width: TILE,
              height: 3 * TILE,
              color: "#6a4a8c",
              solid: { type: "all", of: [flag("sealed"), flag("guardian_beaten", false)] },
              visible: { type: "all", of: [flag("sealed"), flag("guardian_beaten", false)] },
            },
          ],
        };
      }
      default:
        return room;
    }
  });
  const summit = WorldRoom.parse({
    id: "summit",
    name: "Summit",
    at: { x: 148 + 30, y: 2 },
    grid: fillTiles(fixtureGrid(20, 10), { col: 0, row: 5, cols: 1, rows: 3 }, "empty"),
    doors: [{ id: "down", side: "left", offset: 5, size: 3, to: { room: "sanctum", door: "up" } }],
    props: [{ id: "altar", name: "Altar", x: 14 * TILE, y: 6 * TILE, width: 2 * TILE, height: 2 * TILE, color: "#f2e6c0", handlers: [{ on: { type: "touch" }, do: [{ type: "endGame", modal: "ending" }] }] }],
  });
  return ProjectSchema.parse({
    ...base,
    name: "Descent (slice)",
    characters: [...base.characters.filter((c) => c.id !== "charger"), guardian],
    world: {
      ...base.world,
      rooms: [...rooms, summit],
      rules: { onDeath: "checkpoint", save: "room", hazardDamage: 1 },
      items: [{ id: "key", name: "Key", description: "Opens the hatch in the hall.", color: "#e8c547" }],
      modals: [
        { id: "title", title: "Descent", body: "Find the way down, and the way back up.", buttons: [{ label: "Begin" }] },
        { id: "locked", title: "Locked", body: "The hatch is locked. There was a key somewhere." },
        { id: "won", title: "The guardian falls", body: "Your legs feel lighter: jump again in mid-air." },
        { id: "ending", title: "The End", body: "You reached the summit. Thanks for playing." },
      ],
      handlers: [{ on: { type: "gameStarted" }, do: [{ type: "showModal", modal: "title" }] }],
      map: { enabled: true },
    },
  });
}

/** A bordered room whose floor is its two bottom rows. */
const fixtureGrid = (cols: number, rows: number) => ({ rows: Array.from({ length: rows }, (_, r) => (r === 0 || r >= rows - 2 ? "#".repeat(cols) : `#${".".repeat(cols - 2)}#`)) });
