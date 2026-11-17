import { beforeAll, describe, expect, it } from "vitest";
import { fixtureSliceProject, sliceGuardian } from "@anomaly/core";
import { entity, range, simulate, type Input, type Sample } from "./simulate.ts";

// The fixture slice (packages/core/src/world/fixtureSlice.ts) played start to
// finish in the real runtime with scripted input: a game made only of generic
// primitives. The fight uses a one-hit guardian (the guardian's own fight is
// proven in combat_primitives.test.ts); everything around it is the real slice.

const hold = (action: Input, from: number, to: number) => ({ action, from, to });
/** Entering the spike pit at frame t (from the fixture route in world.test.ts). */
const spikes = (t: number) => [hold("jump", t + 50, t + 80), hold("jump", t + 108, t + 138), hold("move_right", t + 170, t + 208), hold("jump", t + 170, t + 200), hold("jump", t + 216, t + 250)];
const ROUTE = [
  hold("jump", 5, 8), // "Begin" on the title
  hold("move_right", 20, 348),
  hold("jump", 36, 60), // onto the ledge: the key
  hold("interact", 356, 358), // the lock post opens the hatch
  hold("move_right", 370, 398), // down the shaft
  hold("move_left", 405, 429),
  hold("interact", 440, 442), // rest at the save spot
  hold("move_right", 450, 752),
  ...spikes(617),
  hold("move_right", 849, 1126), // bridge, into the sanctum
  hold("move_left", 1142, 1150), // step back from the cleave
  hold("move_right", 1187, 1196),
  hold("attack", 1196, 1198), // strike during its recovery
  hold("jump", 1206, 1209), // close "won"
  hold("move_right", 1215, 1420),
  hold("jump", 1240, 1262),
  hold("jump", 1270, 1292), // the double jump it granted, up to the summit door
  hold("jump", 1440, 1443), // close the ending
];

let route: Sample[];
let sealed: Sample[];
beforeAll(() => {
  [route, sealed] = simulate([
    { project: fixtureSliceProject(sliceGuardian(1)), world: { room: "entrance", x: 96, y: 384, abilities: [] }, frames: 1460, samples: range(0, 1460), input: ROUTE },
    { project: fixtureSliceProject(), world: { room: "sanctum", x: 15, y: 384, abilities: [] }, frames: 120, samples: range(0, 120), input: [hold("jump", 3, 6), hold("move_right", 15, 35), hold("move_left", 45, 120)] },
  ]) as [Sample[], Sample[]];
}, 180_000);

const first = (pred: (s: Sample) => boolean) => route.find(pred);

describe("the fixture slice, played from the title to the ending", () => {
  it("opens on the title, which waits for a button", () => {
    expect(route[0]!.modal).toBe("title");
    expect(route[10]!.modal).toBeNull();
  });

  it("the key on the ledge opens the hatch over the shaft", () => {
    const key = first((s) => s.items.key === 1)!;
    expect(key.room).toBe("entrance");
    expect(first((s) => s.room === "hall")!.props.find((p) => p.id === "hatch")).toMatchObject({ visible: true, solid: true });
    const open = first((s) => s.flags.includes("hatch_open"))!;
    expect(open.items).toEqual({});
    expect(open.modal).toBeNull(); // "locked" is only for a player without the key
  });

  it("rests at the save spot and gets through the spike pit unhurt", () => {
    expect(first((s) => s.checkpoint !== null)).toMatchObject({ room: "cistern", checkpoint: { room: "cistern" } });
    expect(route.every((s) => s.deaths === 0)).toBe(true);
  });

  it("is sealed in the sanctum with the guardian, whose death unseals it, grants double jump and stays beaten", () => {
    const inside = first((s) => s.room === "sanctum" && entity(s, "player").x > 60)!;
    expect(inside.flags).toContain("sealed");
    expect(inside.healthBars).toEqual(["guardian_1"]);
    expect(inside.props.find((p) => p.id === "seal")).toMatchObject({ visible: true, solid: true });
    const won = first((s) => s.flags.includes("guardian_beaten"))!;
    expect(won).toMatchObject({ modal: "won", healthBars: [], abilities: ["double_jump"] });
    expect(won.props.find((p) => p.id === "seal")).toMatchObject({ visible: false, solid: false });
  });

  it("reaches the summit only by double jumping, and the altar ends the game", () => {
    const summit = first((s) => s.room === "summit")!;
    expect(summit.abilities).toEqual(["double_jump"]);
    const end = first((s) => s.modal === "ending")!;
    expect(end.room).toBe("summit");
    // Closing the ending starts a fresh game on the title.
    expect(route.at(-1)).toMatchObject({ room: "entrance", modal: "title", flags: [], items: {}, abilities: [], checkpoint: null });
  });

  it("the seal keeps the player in while the guardian lives", () => {
    const last = sealed.at(-1)!;
    expect(last.room).toBe("sanctum");
    expect(entity(last, "player").x).toBeGreaterThanOrEqual(32 + 14);
    expect(last.flags).toEqual(["sealed"]);
  });
});
