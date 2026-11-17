import { describe, expect, it } from "vitest";
import {
  applyBatch,
  applyOperation,
  createDefaultProject,
  fixtureProject,
  FIXTURE_END_ROOM,
  FIXTURE_START_ROOM,
  gridToSolids,
  lintProject,
  ProjectSpec,
  tileAt,
  toRuntimeProject,
  type OperationResult,
  type ProjectSpec as Project,
} from "../src/index.ts";

function ok(result: OperationResult): Project {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}
function err(result: OperationResult) {
  if (result.ok) throw new Error("expected an error");
  return result.error;
}
const op = (p: Project, name: string, input: unknown) => applyOperation(p, name, input);
const room = (p: Project, id: string) => p.world.rooms.find((r) => r.id === id)!;

/** Two 20x10 rooms, a and b (and no others). */
function twoRooms(): Project {
  const empty = createDefaultProject();
  empty.world = { ...empty.world, rooms: [], start: null, playtest: null };
  return ok(
    applyBatch(empty, [
      { name: "createWorldRoom", input: { name: "A", cols: 20, rows: 10 } },
      { name: "createWorldRoom", input: { name: "B", cols: 20, rows: 10 } },
    ]),
  );
}

describe("world rooms", () => {
  it("creates bordered rooms with ids from names, side by side on the map", () => {
    const p = twoRooms();
    expect(p.world.rooms.map((r) => [r.id, r.at])).toEqual([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 22, y: 0 }],
    ]);
    expect(room(p, "a").grid.rows[0]).toBe("#".repeat(20));
    expect(room(p, "a").grid.rows[1]).toBe(`#${".".repeat(18)}#`);
    expect(ok(op(p, "createWorldRoom", { name: "A" })).world.rooms[2]!.id).toBe("a_2");
    expect(err(op(p, "createWorldRoom", { name: "X", id: "a" })).message).toContain('"a" already exists');
    expect(err(op(p, "createWorldRoom", { name: "X", cols: 2 })).code).toBe("invalid_input");
  });

  it("updates name, map position, dressing check and region", () => {
    let p = twoRooms();
    p = ok(op(p, "updateWorldRoom", { roomId: "a", changes: { name: "Atrium", at: { x: -5, y: 3 } } }));
    expect(room(p, "a")).toMatchObject({ name: "Atrium", at: { x: -5, y: 3 } });
    expect(err(op(p, "updateWorldRoom", { roomId: "a", changes: { dressing: { biome: "nope", room: "x" } } })).message).toContain('unknown biome "nope"');
    expect(err(op(p, "updateWorldRoom", { roomId: "a", changes: { regionId: "nowhere" } })).message).toContain("unknown progression region");
    expect(err(op(p, "updateWorldRoom", { roomId: "zz", changes: {} })).message).toContain("known: a, b");
  });

  it("deletes a room, unlinking doors to it and clearing the start", () => {
    let p = twoRooms();
    p = ok(
      applyBatch(p, [
        { name: "setDoor", input: { roomId: "a", door: { side: "right", offset: 6, size: 3 } } },
        { name: "setDoor", input: { roomId: "b", door: { side: "left", offset: 6, size: 3 } } },
        { name: "connectDoors", input: { from: { roomId: "a", doorId: "door_1" }, to: { roomId: "b", doorId: "door_1" } } },
        { name: "setWorldStart", input: { roomId: "b", x: 64, y: 288 } },
      ]),
    );
    p = ok(op(p, "deleteWorldRoom", { roomId: "b" }));
    expect(p.world.rooms.map((r) => r.id)).toEqual(["a"]);
    expect(room(p, "a").doors[0]!.to).toBeNull();
    expect(p.world.start).toBeNull();
    expect(err(op(p, "deleteWorldRoom", { roomId: "b" })).code).toBe("not_found");
  });

  it("resizes, keeping content, doors, spawns and the start in place relative to the shift", () => {
    let p = twoRooms();
    p = ok(
      applyBatch(p, [
        { name: "setDoor", input: { roomId: "a", door: { side: "top", offset: 4, size: 2 } } },
        { name: "addRoomSpawn", input: { roomId: "a", characterId: "crawler", x: 100, y: 288 } },
        { name: "setWorldStart", input: { roomId: "a", x: 64, y: 288 } },
      ]),
    );
    p = ok(op(p, "resizeWorldRoom", { roomId: "a", cols: 25, rows: 12, shiftX: 3, shiftY: 2 }));
    const a = room(p, "a");
    expect(a.grid.rows.length).toBe(12);
    expect(a.grid.rows[0]).toBe("#".repeat(25));
    expect(tileAt(a.grid, 3, 2)).toBe("solid"); // the old top-left corner moved
    expect(tileAt(a.grid, 7, 2)).toBe("empty"); // the old top door opening moved with it
    expect(a.doors[0]).toMatchObject({ side: "top", offset: 7 });
    expect(a.spawns[0]).toMatchObject({ x: 196, y: 352 });
    expect(p.world.start).toEqual({ room: "a", x: 160, y: 352 });
    expect(err(op(p, "resizeWorldRoom", { roomId: "a", cols: 25, rows: 12, shiftX: -10 })).message).toContain("cropped off");
    expect(err(op(p, "resizeWorldRoom", { roomId: "a", cols: 6, rows: 12 })).message).toContain("runs past");
  });
});

describe("paintTiles", () => {
  it("paints a rectangle or cells in a room", () => {
    let p = twoRooms();
    p = ok(op(p, "paintTiles", { roomId: "a", kind: "ledge", area: { col: 2, row: 5, cols: 4, rows: 1 } }));
    expect(room(p, "a").grid.rows[5]).toBe("#.====.............#");
    p = ok(op(p, "paintTiles", { roomId: "a", kind: "hazard", cells: [[1, 8], [2, 8]] }));
    expect(room(p, "a").grid.rows[8]!.slice(0, 4)).toBe("#^^.");
    p = ok(op(p, "paintTiles", { roomId: "b", kind: "oneway", cells: [[5, 5]] }));
    expect(tileAt(room(p, "b").grid, 5, 5)).toBe("oneway");
  });

  it("rejects cells outside the grid, unknown rooms and bad kinds", () => {
    const p = twoRooms();
    expect(err(op(p, "paintTiles", { roomId: "a", kind: "solid", cells: [[20, 0]] })).message).toContain("outside room \"a\" (20x10 tiles)");
    expect(err(op(p, "paintTiles", { roomId: "a", kind: "solid", area: { col: 18, row: 0, cols: 3, rows: 1 } })).message).toContain("runs past");
    expect(err(op(p, "paintTiles", { roomId: "q", kind: "solid", cells: [[1, 1]] })).message).toContain("known: a, b");
    expect(err(op(p, "paintTiles", { roomId: "a", kind: "lava", cells: [[1, 1]] })).code).toBe("invalid_input");
    expect(err(op(p, "paintTiles", { roomId: "a", kind: "solid" })).issues[0]!.message).toContain("either area or cells");
  });
});

describe("doors", () => {
  it("adds doors (carving the edge), updates and removes them", () => {
    let p = twoRooms();
    p = ok(op(p, "setDoor", { roomId: "a", door: { side: "right", offset: 6, size: 3 } }));
    expect(room(p, "a").doors).toEqual([{ id: "door_1", side: "right", offset: 6, size: 3, to: null }]);
    expect(room(p, "a").grid.rows.slice(6, 9).map((r) => r.at(-1))).toEqual([".", ".", "."]);
    p = ok(op(p, "setDoor", { roomId: "a", door: { id: "door_1", side: "right", offset: 5, size: 2 }, carve: false }));
    expect(room(p, "a").doors[0]).toMatchObject({ offset: 5, size: 2 });
    expect(tileAt(room(p, "a").grid, 19, 5)).toBe("solid");
    expect(err(op(p, "setDoor", { roomId: "a", door: { side: "left", offset: 8, size: 3 } })).message).toContain("runs past the room's left side (10 tiles)");
    p = ok(op(p, "removeDoor", { roomId: "a", doorId: "door_1" }));
    expect(room(p, "a").doors).toEqual([]);
    expect(err(op(p, "removeDoor", { roomId: "a", doorId: "door_1" })).message).toContain("has no door");
  });

  it("connects opposite doors both ways, re-links and disconnects", () => {
    let p = twoRooms();
    p = ok(
      applyBatch(p, [
        { name: "setDoor", input: { roomId: "a", door: { id: "east", side: "right", offset: 6, size: 3 } } },
        { name: "setDoor", input: { roomId: "a", door: { id: "up", side: "top", offset: 3, size: 3 } } },
        { name: "setDoor", input: { roomId: "b", door: { id: "west", side: "left", offset: 6, size: 3 } } },
        { name: "setDoor", input: { roomId: "b", door: { id: "west2", side: "left", offset: 2, size: 3 } } },
      ]),
    );
    p = ok(op(p, "connectDoors", { from: { roomId: "a", doorId: "east" }, to: { roomId: "b", doorId: "west" } }));
    expect(room(p, "a").doors[0]!.to).toEqual({ room: "b", door: "west" });
    expect(room(p, "b").doors[0]!.to).toEqual({ room: "a", door: "east" });
    // Re-linking cuts the old partner's link.
    p = ok(op(p, "connectDoors", { from: { roomId: "a", doorId: "east" }, to: { roomId: "b", doorId: "west2" } }));
    expect(room(p, "b").doors.map((d) => d.to)).toEqual([null, { room: "a", door: "east" }]);
    const wrong = err(op(p, "connectDoors", { from: { roomId: "a", doorId: "up" }, to: { roomId: "b", doorId: "west" } }));
    expect(wrong.message).toContain("must lead to a bottom door");
    expect(wrong.message).toContain('bottom doors in "b": none');
    expect(err(op(p, "connectDoors", { from: { roomId: "a", doorId: "nope" }, to: null })).message).toContain("known: east, up");
    p = ok(op(p, "connectDoors", { from: { roomId: "b", doorId: "west2" }, to: null }));
    expect(room(p, "a").doors[0]!.to).toBeNull();
    expect(room(p, "b").doors[1]!.to).toBeNull();
  });

  it("moving a connected door to another side disconnects both ends", () => {
    let p = twoRooms();
    p = ok(
      applyBatch(p, [
        { name: "setDoor", input: { roomId: "a", door: { id: "east", side: "right", offset: 6, size: 3 } } },
        { name: "setDoor", input: { roomId: "b", door: { id: "west", side: "left", offset: 6, size: 3 } } },
        { name: "connectDoors", input: { from: { roomId: "a", doorId: "east" }, to: { roomId: "b", doorId: "west" } } },
      ]),
    );
    expect(room(ok(op(p, "setDoor", { roomId: "a", door: { id: "east", side: "right", offset: 4, size: 3 } })), "b").doors[0]!.to).not.toBeNull();
    p = ok(op(p, "setDoor", { roomId: "a", door: { id: "east", side: "top", offset: 4, size: 3 } }));
    expect(room(p, "a").doors[0]!.to).toBeNull();
    expect(room(p, "b").doors[0]!.to).toBeNull();
  });
});

describe("room spawns, start and rules", () => {
  it("adds, moves and removes enemy spawns", () => {
    let p = twoRooms();
    p = ok(op(p, "addRoomSpawn", { roomId: "a", characterId: "crawler", x: 200, y: 288 }));
    expect(room(p, "a").spawns).toEqual([{ id: "crawler_1", characterId: "crawler", x: 200, y: 288 }]);
    p = ok(op(p, "moveRoomSpawn", { roomId: "a", spawnId: "crawler_1", x: 300 }));
    expect(room(p, "a").spawns[0]).toMatchObject({ x: 300, y: 288 });
    expect(err(op(p, "addRoomSpawn", { roomId: "a", characterId: "player", x: 1, y: 1 })).message).toContain("is the player");
    expect(err(op(p, "addRoomSpawn", { roomId: "a", characterId: "ghost", x: 1, y: 1 })).message).toContain("known: crawler, charger");
    expect(err(op(p, "addRoomSpawn", { roomId: "a", characterId: "crawler", x: 9999, y: 1 })).message).toContain("outside room");
    expect(err(op(p, "moveRoomSpawn", { roomId: "a", spawnId: "x_1", x: 1 })).message).toContain("known: crawler_1");
    p = ok(op(p, "removeRoomSpawn", { roomId: "a", spawnId: "crawler_1" }));
    expect(room(p, "a").spawns).toEqual([]);
  });

  it("deleting a character removes its room spawns", () => {
    let p = ok(op(twoRooms(), "addRoomSpawn", { roomId: "b", characterId: "charger", x: 200, y: 288 }));
    p = ok(op(p, "deleteCharacter", { characterId: "charger" }));
    expect(room(p, "b").spawns).toEqual([]);
  });

  it("sets and clears the start", () => {
    let p = ok(op(twoRooms(), "setWorldStart", { roomId: "b", x: 64, y: 288 }));
    expect(p.world.start).toEqual({ room: "b", x: 64, y: 288 });
    expect(err(op(p, "setWorldStart", { roomId: "b" })).message).toContain("give the start's x and y");
    expect(err(op(p, "setWorldStart", { roomId: "c", x: 1, y: 1 })).message).toContain("known: a, b");
    expect(ok(op(p, "setWorldStart", { roomId: null })).world.start).toBeNull();
  });

  it("sets what ▶ Play tests, changing only what is named; deleting its room clears it", () => {
    let p = ok(op(twoRooms(), "setPlaytest", { roomId: "a", x: 64, y: 288, abilities: ["dash", "dash"] }));
    expect(p.world.playtest).toEqual({ room: "a", x: 64, y: 288, abilities: ["dash"] });
    p = ok(op(p, "setPlaytest", { x: 100 }));
    expect(p.world.playtest).toEqual({ room: "a", x: 100, y: 288, abilities: ["dash"] });
    expect(err(op(p, "setPlaytest", { roomId: "b" })).message).toContain("give x and y");
    expect(err(op(p, "setPlaytest", { x: 9999 })).message).toContain("outside room");
    expect(ok(op(p, "deleteWorldRoom", { roomId: "a" })).world.playtest).toBeNull();
  });

  it("changes only the named rules, and the ledge thickness", () => {
    let p = ok(op(createDefaultProject(), "setGameRules", { onDeath: "start" }));
    expect(p.world.rules).toEqual({ onDeath: "start", save: "room", hazardDamage: 1 });
    p = ok(op(p, "setGameRules", { hazardDamage: 3, save: "never" }));
    expect(p.world.rules).toEqual({ onDeath: "start", save: "never", hazardDamage: 3 });
    expect(err(op(p, "setGameRules", {})).message).toContain("nothing to change");
    expect(err(op(p, "setGameRules", { onDeath: "town" })).code).toBe("invalid_input");
    p = ok(op(p, "setLedgeThickness", { thickness: 12 }));
    expect(gridToSolids(p.world.rooms[0]!.grid, p.world.ledgeThickness).find((s) => s.kind === "ledge")!.height).toBe(12);
    expect(err(op(p, "setLedgeThickness", { thickness: 64 })).code).toBe("invalid_input");
  });
});

describe("fixture world", () => {
  it("is valid, lint-free, and joins start to end through every kind of door", () => {
    const p = fixtureProject();
    expect(ProjectSpec.safeParse(p).success).toBe(true);
    expect(lintProject(p)).toEqual([]);
    expect(p.world.start!.room).toBe(FIXTURE_START_ROOM);
    const sides = new Set(p.world.rooms.flatMap((r) => r.doors.map((d) => d.side)));
    expect([...sides].sort()).toEqual(["bottom", "left", "right", "top"]);
    const kinds = new Set(p.world.rooms.flatMap((r) => r.grid.rows.join("").split("")));
    expect([...kinds].sort()).toEqual(["#", "%", "-", ".", "=", "^"]);
    // Breadth-first over doors reaches the end room.
    const seen = new Set([FIXTURE_START_ROOM]);
    const queue = [FIXTURE_START_ROOM];
    while (queue.length) for (const d of room(p, queue.shift()!).doors) if (d.to && !seen.has(d.to.room)) seen.add(d.to.room) && queue.push(d.to.room);
    expect(seen.has(FIXTURE_END_ROOM)).toBe(true);
    expect(seen.size).toBe(p.world.rooms.length);
    expect(toRuntimeProject(p).world.rooms[0]).toMatchObject({ width: 960, height: 448 });
  });
});
