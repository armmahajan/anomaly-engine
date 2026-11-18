import { describe, expect, it } from "vitest";
import { exampleRig } from "@anomaly/core";
import { apply, posedBones, restBounds, stageMapping, turnAngle } from "./rigView.ts";

describe("the bone editor's view of the stage", () => {
  it("frames the rest bounds like stage_view.gd: about 60% of the height, round trips", () => {
    const rig = exampleRig();
    const b = restBounds(rig);
    const map = stageMapping(rig, 960, 540);
    const top = map.toScreen([b.x, b.y]);
    const bottom = map.toScreen([b.x, b.y + b.height]);
    const tall = (bottom[1] - top[1]) / 540 / 0.6;
    const wide = (map.toScreen([b.x + b.width, 0])[0] - top[0]) / 960 / 0.55;
    expect(Math.max(tall, wide)).toBeCloseTo(1, 3); // the tighter side fills its share
    const back = map.toRig(map.toScreen([12, -18]));
    expect(back[0]).toBeCloseTo(12);
    expect(back[1]).toBeCloseTo(-18);
    // Twice the size: everything scales with the canvas (canvas_items stretch).
    expect(stageMapping(rig, 1920, 1080).toScreen([12, -18])).toEqual(map.toScreen([12, -18]).map((v) => v * 2));
  });

  it("poses bones about their rest pivots, children following parents", () => {
    const rig = exampleRig();
    const posed = posedBones(rig, { head: 90 });
    expect(apply(posed.get("body")!, [5, 5])).toEqual([5, 5]);
    const horn = apply(posed.get("horn")!, [20, -24]); // the horn's pivot turns about the head's (12, -18)
    expect(horn[0]).toBeCloseTo(12 + 6);
    expect(horn[1]).toBeCloseTo(-18 + 8);
    expect(turnAngle([0, 0], [1, 0], [0, 1])).toBeCloseTo(90);
  });
});
