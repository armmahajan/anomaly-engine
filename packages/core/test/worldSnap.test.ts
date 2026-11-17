import { describe, expect, it } from "vitest";
import { floorLine, snapPlacement, snapPlacements, type SnapRoom } from "../src/index.ts";

const room: SnapRoom = {
  width: 1600,
  height: 720,
  platforms: [
    { x: 0, y: 610, width: 1600, height: 110 }, // floor
    { x: 600, y: 470, width: 220, height: 30 }, // ledge
    { x: -40, y: 0, width: 40, height: 720 }, // wall outside the room
  ],
};
const lantern = { kind: "light" as const, size: 40, width: 40, height: 40 };
const vine = { kind: "hanging" as const, size: 200, width: 40, height: 200 };
const pillar = { kind: "structure" as const, size: 400, width: 100, height: 400 };
const at = (layer: "mid" | "back" | "play" | "front", x: number, y: number) => ({ piece: "p", layer, x, y, scale: 1 });

describe("snapping pieces onto surfaces", () => {
  it("drops a standing play piece onto the first surface below it", () => {
    expect(snapPlacement(at("play", 700, 300), lantern, room).placement.y).toBe(470); // onto the ledge
    expect(snapPlacement(at("play", 300, 300), lantern, room).placement.y).toBe(610); // no ledge here: the floor
    expect(snapPlacement(at("play", 700, 480), lantern, room).placement.y).toBe(470); // a little below the ledge top still counts
    expect(snapPlacement(at("play", 700, 560), lantern, room).placement.y).toBe(610); // well below it: the floor
    expect(snapPlacement(at("play", 300, 690), lantern, room).placement.y).toBe(610); // sunk into the floor: back up
  });

  it("keeps a standing piece from overhanging a ledge by more than a quarter", () => {
    const placed = snapPlacement(at("play", 815, 400), lantern, room).placement;
    expect(placed).toMatchObject({ x: 810, y: 470 });
  });

  it("hangs pieces from the ceiling or the underside of a ledge", () => {
    expect(snapPlacement(at("play", 300, 200), vine, room).placement.y).toBe(0);
    expect(snapPlacement(at("play", 700, 520), vine, room).placement.y).toBe(500);
  });

  it("keeps distant layers at or below the floor line and front silhouettes at the edges", () => {
    expect(floorLine(room)).toBe(610);
    expect(snapPlacement(at("mid", 900, 400), pillar, room).placement.y).toBe(610);
    expect(snapPlacement(at("back", 900, 680), pillar, room).placement.y).toBe(680); // rising from behind the floor is fine
    expect(snapPlacement(at("back", 900, 90), vine, room).placement.y).toBe(0);
    expect(snapPlacement(at("front", 900, 500), pillar, room).placement.y).toBe(760);
    expect(snapPlacement(at("front", 900, 60), vine, room).placement.y).toBe(0);
  });

  it("reports pieces standing over nothing and counts the moves", () => {
    const pit: SnapRoom = { ...room, platforms: [{ x: 0, y: 610, width: 500, height: 110 }] };
    const result = snapPlacements(
      [
        { id: "a", ...at("play", 300, 500) },
        { id: "b", ...at("play", 900, 500) },
        { id: "c", ...at("play", 300, 610) },
      ],
      [{ id: "p", ...lantern }],
      pit,
    );
    expect(result.moved).toBe(1);
    expect(result.unsupported).toEqual(["b"]);
    expect(result.placements[1]!.y).toBe(500);
  });

  it("leaves unknown pieces alone", () => {
    const p = at("play", 300, 300);
    expect(snapPlacement(p, undefined, room)).toEqual({ placement: p, moved: false, unsupported: false });
  });
});
