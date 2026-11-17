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

  describe("spans", () => {
    const beam = { kind: "span" as const, size: 40, width: 400, height: 40 }; // 400px wide at scale 1
    const pieces = [
      { id: "pillar", ...pillar },
      { id: "beam", ...beam },
    ];
    const placed = (id: string, piece: string, layer: "mid" | "play" | "front", x: number, y: number, scale = 1) => ({ id, piece, layer, x, y, scale });

    it("rest on the tops of two structures in their layer", () => {
      const pillars = [placed("a", "pillar", "mid", 400, 610), placed("b", "pillar", "mid", 700, 610)]; // tops at 210
      const result = snapPlacement(placed("s", "beam", "mid", 550, 300), beam, room, { placements: pillars, pieces });
      expect(result.placement.y).toBe(210);
    });

    it("rest on the higher of two nearly level supports, and lie on the floor between uneven ones", () => {
      const near = [placed("a", "pillar", "mid", 400, 610), placed("b", "pillar", "mid", 700, 620)]; // tops 210 and 220
      expect(snapPlacement(placed("s", "beam", "mid", 550, 300), beam, room, { placements: near, pieces }).placement.y).toBe(210);
      const uneven = [placed("a", "pillar", "mid", 400, 610), placed("b", "pillar", "mid", 700, 610, 1.2)]; // tops 210 and 130
      expect(snapPlacement(placed("s", "beam", "mid", 550, 300), beam, room, { placements: uneven, pieces }).placement.y).toBe(610);
    });

    it("ignore structures in other layers", () => {
      const others = [placed("a", "pillar", "play", 400, 610), placed("b", "pillar", "play", 700, 610)];
      expect(snapPlacement(placed("s", "beam", "mid", 550, 300), beam, room, { placements: others, pieces }).placement.y).toBe(610);
    });

    it("bridge a gap between two ledges in the play layer", () => {
      const gap: SnapRoom = {
        ...room,
        platforms: [room.platforms[0]!, { x: 200, y: 450, width: 200, height: 30 }, { x: 600, y: 455, width: 200, height: 30 }],
      };
      expect(snapPlacement(placed("s", "beam", "play", 500, 300), beam, gap).placement.y).toBe(450);
      expect(snapPlacement(placed("s", "beam", "play", 500, 520), beam, gap).placement.y).toBe(610); // below the ledges: down to the floor
    });

    it("can be set into two walls at any height", () => {
      const shaft: SnapRoom = { ...room, platforms: [{ x: 0, y: 0, width: 40, height: 720 }, { x: 440, y: 0, width: 40, height: 720 }] };
      expect(snapPlacement(placed("s", "beam", "play", 240, 300), beam, shaft).placement).toMatchObject({ x: 240, y: 300 });
    });

    it("rest on structures after those are snapped, whatever the order", () => {
      const result = snapPlacements(
        [placed("s", "beam", "mid", 550, 100), placed("a", "pillar", "mid", 400, 500), placed("b", "pillar", "mid", 700, 500)],
        pieces,
        room,
      );
      expect(result.placements.map((p) => p.y)).toEqual([210, 610, 610]);
    });

    it("only rest where they stay in view, and on a structure's top rather than its base", () => {
      const tall = [placed("a", "pillar", "mid", 400, 400), placed("b", "pillar", "mid", 700, 400)]; // tops at the room's top edge
      expect(snapPlacement(placed("s", "beam", "mid", 550, 0), beam, room, { placements: tall, pieces }).placement.y).toBe(610);
      const apart = [placed("a", "pillar", "mid", 310, 610), placed("b", "pillar", "mid", 790, 610)]; // only their bases (full image width) reach the beam's ends
      expect(snapPlacement(placed("s", "beam", "mid", 550, 300), beam, room, { placements: apart, pieces }).placement.y).toBe(610);
    });

    it("cross the top edge in the front layer", () => {
      expect(snapPlacement(placed("s", "beam", "front", 550, 500), beam, room).placement.y).toBe(40);
    });
  });

  it("leaves unknown pieces alone", () => {
    const p = at("play", 300, 300);
    expect(snapPlacement(p, undefined, room)).toEqual({ placement: p, moved: false, unsupported: false });
  });
});
