import { createDefaultProject } from "../defaultProject.ts";
import type { ProjectSpec } from "../schema.ts";
import { borderedGrid, fillTiles, TILE, type TileGrid, type TileKind } from "./tiles.ts";
import { defaultWorld, WorldRoom, type Door, type World } from "./world.ts";

/**
 * A small test world for the starter characters: six rooms, start to end.
 *
 *   entrance -> hall -(fall down a shaft)-> cistern -> spikes -(jump up)-> bridge -> sanctum (end)
 *
 * It uses a ledge (entrance, spikes), a one-way platform (hall, spikes), a
 * hazard pit (spikes), a breakable floor patch (cistern) and both kinds of
 * vertical door. Every floor a door opens onto is level with the door's
 * bottom edge. No abilities are needed. Enemies stay off the route.
 */

type Paint = [kind: TileKind, col: number, row: number, cols?: number, rows?: number];

function grid(cols: number, rows: number, paint: Paint[]): TileGrid {
  return paint.reduce((g, [kind, col, row, w = 1, h = 1]) => fillTiles(g, { col, row, cols: w, rows: h }, kind), borderedGrid(cols, rows));
}

const door = (id: string, side: Door["side"], offset: number, size: number, room: string, to: string): Door => ({ id, side, offset, size, to: { room, door: to } });

function room(id: string, name: string, at: [number, number], tiles: TileGrid, doors: Door[], spawns: { id: string; characterId: string; x: number; y: number }[] = []): WorldRoom {
  return WorldRoom.parse({ id, name, grid: tiles, at: { x: at[0], y: at[1] }, doors, spawns, dressing: null });
}

export const FIXTURE_START_ROOM = "entrance";
export const FIXTURE_END_ROOM = "sanctum";

export function fixtureWorld(): World {
  return {
    ...defaultWorld(),
    start: { room: FIXTURE_START_ROOM, x: 3 * TILE, y: 12 * TILE },
    rooms: [
      room(
        "entrance",
        "Entrance",
        [0, 0],
        grid(30, 14, [
          ["solid", 0, 12, 30],
          ["ledge", 8, 8, 5],
          ["empty", 29, 9, 1, 3],
        ]),
        [door("east", "right", 9, 3, "hall", "west")],
      ),
      room(
        "hall",
        "Hall",
        [30, 0],
        grid(40, 14, [
          ["solid", 0, 12, 40],
          ["empty", 0, 9, 1, 3],
          ["oneway", 14, 8, 6],
          ["empty", 30, 12, 3, 2],
        ]),
        [door("west", "left", 9, 3, "entrance", "east"), door("shaft", "bottom", 30, 3, "cistern", "shaft")],
      ),
      room(
        "cistern",
        "Cistern",
        [56, 14],
        grid(30, 20, [
          ["solid", 0, 17, 30, 2],
          ["empty", 4, 0, 3],
          ["empty", 29, 14, 1, 3],
          ["breakable", 12, 17, 4],
          ["empty", 12, 18, 4],
          ["solid", 16, 8, 13],
          ["solid", 16, 7],
        ]),
        [door("shaft", "top", 4, 3, "hall", "shaft"), door("east", "right", 14, 3, "spikes", "west")],
        [{ id: "crawler_1", characterId: "crawler", x: 22 * TILE, y: 8 * TILE }],
      ),
      room(
        "spikes",
        "Spike Pit",
        [86, 19],
        grid(36, 14, [
          ["solid", 0, 12, 36],
          ["empty", 0, 9, 1, 3],
          ["empty", 10, 12, 5],
          ["hazard", 10, 13, 5],
          ["ledge", 21, 8, 4],
          ["oneway", 27, 4, 6],
          ["empty", 28, 0, 3],
        ]),
        [door("west", "left", 9, 3, "cistern", "east"), door("up", "top", 28, 3, "bridge", "down")],
      ),
      room(
        "bridge",
        "Bridge",
        [108, 7],
        grid(40, 12, [
          ["solid", 0, 10, 40],
          ["empty", 6, 10, 3, 2],
          ["empty", 39, 7, 1, 3],
          ["ledge", 18, 6, 5],
        ]),
        [door("down", "bottom", 6, 3, "spikes", "up"), door("east", "right", 7, 3, "sanctum", "west")],
      ),
      room(
        "sanctum",
        "Sanctum",
        [148, 5],
        grid(30, 14, [
          ["solid", 0, 12, 30],
          ["empty", 0, 9, 1, 3],
          ["ledge", 12, 8, 6],
        ]),
        [door("west", "left", 9, 3, "bridge", "east")],
        [{ id: "charger_1", characterId: "charger", x: 26 * TILE, y: 12 * TILE }],
      ),
    ],
  };
}

/** The starter project with the fixture world. */
export function fixtureProject(): ProjectSpec {
  return { ...createDefaultProject(), world: fixtureWorld() };
}
