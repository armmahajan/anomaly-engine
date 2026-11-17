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

const go = (to: string, when: object, ...and: object[]) => ({ when, ...(and.length ? { and } : {}), to });
const after = (seconds: number) => ({ type: "after", seconds });
const done = { type: "actionDone" };
const level = { type: "playerLevel", margin: 60 };

/**
 * The sanctum's guardian: a heavy melee enemy (the Iron Warden of the combat
 * showcase). It cleaves at close range; below half health it roars, then
 * lunges and sends quakes along the floor. Plain data on the generic primitives.
 */
export function sliceGuardian(health = 10): unknown {
  return {
    id: SLICE_GUARDIAN,
    kind: "enemy",
    name: "Guardian",
    color: "#7d8a99",
    size: { width: 48, height: 64 },
    stats: { knockback: 420, health, contactDamage: 1, armor: 0.8 },
    behavior: {
      initial: "stalk",
      states: {
        stalk: {
          action: { type: "chase", speed: 110, stopDistance: 70 },
          transitions: [go("roar", { type: "healthBelow", fraction: 0.5 }), go("cleave", { type: "playerWithin", distance: 100 }, level)],
        },
        cleave: {
          action: { type: "strike", windup: 0.55, active: 0.2, recovery: 0.9, width: 80, height: 56, offsetX: 52, color: "#ffb347" },
          transitions: [go("stalk", done)],
        },
        roar: { action: { type: "telegraph", color: "#ff5a3d", shake: true }, transitions: [go("quake", after(0.8))] },
        quake: {
          action: { type: "slam", windup: 0.45, height: 0, waveSpeed: 480, waveReach: 700, waveHeight: 30, color: "#ff5a3d" },
          transitions: [go("rest", done)],
        },
        rest: { action: { type: "wait" }, transitions: [go("lunge", after(0.6), { type: "playerWithin", distance: 110 }, level), go("rush", after(0.6))] },
        rush: {
          action: { type: "chase", speed: 180, stopDistance: 80 },
          transitions: [go("lunge", { type: "playerWithin", distance: 110 }, level), go("quake", after(1.5))],
        },
        lunge: {
          action: { type: "strike", windup: 0.4, active: 0.25, recovery: 0.8, width: 80, height: 56, offsetX: 52, lunge: 100, color: "#ff5a3d" },
          transitions: [go("quake", done)],
        },
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
          props: [{ id: "key", name: "Key", x: 11 * TILE + 16, y: 8 * TILE - 28, width: 24, height: 24, color: "#e8c547", visible: flag("got_key", false), handlers: [{ on: { type: "touch" }, do: [{ type: "giveItem", item: "key" }, { type: "setFlag", flag: "got_key" }] }] }],
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
              healthBar: { title: "The Iron Guardian" },
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
      // ▶ Play plays the whole game from its start.
      playtest: { room: base.world.start!.room, x: base.world.start!.x, y: base.world.start!.y, abilities: [] },
      map: { enabled: true },
    },
  });
}

/** A bordered room whose floor is its two bottom rows. */
const fixtureGrid = (cols: number, rows: number) => ({ rows: Array.from({ length: rows }, (_, r) => (r === 0 || r >= rows - 2 ? "#".repeat(cols) : `#${".".repeat(cols - 2)}#`)) });
