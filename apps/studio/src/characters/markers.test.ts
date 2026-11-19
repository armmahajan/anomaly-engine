import { describe, expect, it } from "vitest";
import { addMarker, freeSpot, MAX_MARKERS, moveMarker, removeMarker, renameMarker, roundT, timeAt } from "./markers.ts";

const two = [
  { t: 0.2, name: "step" },
  { t: 0.7, name: "impact" },
];

describe("clip marker edits", () => {
  it("add a marker where asked, or in the widest free stretch, named freshly, kept in time order", () => {
    expect(addMarker([], undefined)).toEqual({ markers: [{ t: 0.5, name: "marker" }], index: 0 });
    expect(addMarker(two, 0.5)).toEqual({ markers: [two[0], { t: 0.5, name: "marker" }, two[1]], index: 1 });
    expect(addMarker([...two, { t: 0.9, name: "marker" }], 0.1)!.markers[0]).toEqual({ t: 0.1, name: "marker_2" });
    expect(addMarker(two, undefined, "Lands Here")!.markers[1]).toEqual({ t: 0.45, name: "lands_here" });
    expect(freeSpot(two)).toBe(0.45);
    expect(addMarker(Array.from({ length: MAX_MARKERS }, (_, i) => ({ t: i / 20, name: "m" })), 0.9)).toBeNull();
  });

  it("move a marker (clamped, rounded, re-sorted) and say where it went", () => {
    expect(moveMarker(two, 0, 0.9)).toEqual({ markers: [two[1], { t: 0.9, name: "step" }], index: 1 });
    expect(moveMarker(two, 1, -3)).toEqual({ markers: [{ t: 0, name: "impact" }, two[0]], index: 0 });
    expect(moveMarker(two, 0, 0.2)).toBeNull();
    expect(moveMarker(two, 5, 0.3)).toBeNull();
    expect(roundT(0.12345)).toBe(0.123);
  });

  it("rename to an id, refusing empty or unchanged names; delete by position", () => {
    expect(renameMarker(two, 1, "Big Hit")).toEqual({ markers: [two[0], { t: 0.7, name: "big_hit" }], index: 1 });
    expect(renameMarker(two, 1, "  ")).toBeNull();
    expect(renameMarker(two, 1, "impact")).toBeNull();
    expect(removeMarker(two, 0)).toEqual([two[1]]);
  });

  it("read the time under the pointer on the bar", () => {
    expect(timeAt(150, 100, 200)).toBe(0.25);
    expect(timeAt(50, 100, 200)).toBe(0);
    expect(timeAt(400, 100, 200)).toBe(1);
  });
});
