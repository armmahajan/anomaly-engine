import { describe, expect, it } from "vitest";
import { clearPassages, doorBlockers, doorZone, passageIntrusion, seenRect, type DoorOpening, type SnapRoom } from "../src/index.ts";

// A 1600x448 room (50x14 tiles): floor at y 384, a door in each side wall at rows 9-11 and one in the floor.
const room: SnapRoom = { width: 1600, height: 448, platforms: [{ x: 0, y: 384, width: 1600, height: 64 }, { x: 600, y: 240, width: 200, height: 20 }] };
const doors: DoorOpening[] = [
  { side: "left", offset: 9, size: 3 },
  { side: "right", offset: 9, size: 3 },
  { side: "bottom", offset: 25, size: 3 },
];
const pieces = [
  { id: "shrub", kind: "decor" as const, size: 40, width: 40, height: 40 },
  { id: "pillar", kind: "structure" as const, size: 400, width: 100, height: 400 },
  { id: "vine", kind: "hanging" as const, size: 200, width: 30, height: 200 },
];
const at = (id: string, piece: string, layer: "mid" | "back" | "play" | "front", x: number, y: number, scale = 1) => ({ id, piece, layer, x, y, scale });

describe("doors and passages", () => {
  it("knows where a door's opening and approach are, and where the camera is then", () => {
    expect(doorZone(doors[0]!, room)).toEqual({ rect: { x: 0, y: 288, width: 160, height: 96 }, camera: 480 });
    expect(doorZone(doors[1]!, room)).toEqual({ rect: { x: 1440, y: 288, width: 160, height: 96 }, camera: 1120 });
    expect(doorZone(doors[2]!, room).rect).toEqual({ x: 800, y: 288, width: 96, height: 160 });
  });

  it("sees parallax layers where they are drawn with the camera at the door", () => {
    // Front scrolls faster: a silhouette placed at x 300 is drawn left of it while the camera is at the left end.
    expect(seenRect(at("a", "pillar", "front", 300, 0), pieces[1]!, room, 480).x).toBeCloseTo(300 * 1.35 - 0.35 * 480 - (448 * 0.42 * 0.25) / 2);
    expect(seenRect(at("a", "shrub", "play", 300, 384), pieces[0]!, room, 480)).toEqual({ x: 280, y: 344, width: 40, height: 40 });
  });

  it("finds pieces covering doors: play, front and big back pieces, not distant ones", () => {
    const placements = [
      at("shrub_by_left_door", "shrub", "play", 60, 384),
      at("shrub_mid_room", "shrub", "play", 400, 384),
      at("front_pillar", "pillar", "front", 1400, 448),
      at("back_pillar", "pillar", "back", 830, 384),
      at("mid_pillar", "pillar", "mid", 60, 384),
      at("back_shrub", "shrub", "back", 1500, 384),
    ];
    expect(doorBlockers(placements, pieces, room, doors)).toEqual([
      ["shrub_by_left_door", 0],
      ["front_pillar", 1],
      ["back_pillar", 2],
    ]);
  });

  it("pushes blockers off doorways, shortens hanging pieces reaching into a passage, drops what can't be fixed", () => {
    const placements = [
      at("shrub", "shrub", "play", 60, 384),
      at("front", "pillar", "front", 1400, 448),
      at("vine", "vine", "play", 300, 0, 1.8), // hangs to y 360: 24px above the floor
      at("short_vine", "vine", "play", 700, 260, 0.1), // under the ledge, 20px long: clear
      at("lantern_in_floor_door", "shrub", "play", 848, 384),
    ];
    const cleared = clearPassages(placements, pieces, room, doors);
    expect(doorBlockers(cleared.placements, pieces, room, doors)).toEqual([]);
    for (const p of cleared.placements) expect(passageIntrusion(p, pieces.find((k) => k.id === p.piece)!, room)).toBeLessThanOrEqual(0);
    expect(cleared.moved).toEqual(["shrub", "front", "lantern_in_floor_door"]);
    expect(cleared.scaled).toEqual(["vine"]);
    expect(cleared.placements.find((p) => p.id === "shrub")!.x).toBeGreaterThanOrEqual(160 + 20);
    expect(cleared.placements.find((p) => p.id === "vine")!.scale).toBeLessThan(1.8);
    expect(cleared.placements.find((p) => p.id === "short_vine")).toEqual(placements[3]);
    // A piece that can't get clear (here: a span of wall too wide to push aside) is dropped.
    const wide = [{ id: "wall", kind: "structure" as const, size: 300, width: 2000, height: 300 }];
    expect(clearPassages([at("wall", "wall", "play", 800, 384)], wide, room, doors)).toMatchObject({ placements: [], dropped: ["wall"] });
  });
});
