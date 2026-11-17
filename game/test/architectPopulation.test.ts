import { beforeAll, describe, expect, it } from "vitest";
// This worktree's core (the @anomaly/core link points at the main checkout).
import { populationStage, ProjectSpec, screensStage } from "../../packages/core/src/index.ts";
import { handBuiltProject } from "../../packages/core/test/architectPopulationWorld.ts";
import { entity, range, simulate, type Input, type Sample } from "./simulate.ts";

// A room the Architect's population stage locked around its guardian
// (packages/core/src/architect/population), played in the real runtime: the
// doors close behind the player, the way back stays shut while the guardian
// lives, and its fall opens them, grants double jump and shows the message.

const hold = (action: Input, from: number, to: number) => ({ action, from, to });

function game(): ProjectSpec {
  const base = handBuiltProject({ contents: { depths_1: [] } });
  // A one-hit guardian: the fight itself is the combat tests' business.
  const characters = base.characters.map((c) => (c.id === "warden" && c.kind === "enemy" ? { ...c, stats: { ...c.stats, health: 1, contactDamage: 0 } } : c));
  return screensStage(populationStage(ProjectSpec.parse({ ...base, characters })).project).project;
}

const START = { room: "depths_1", x: 800, y: 416, abilities: [] };
let fight: Sample[];
let shut: Sample[];
beforeAll(() => {
  [fight, shut] = simulate([
    {
      project: game(),
      world: START,
      frames: 440,
      samples: range(0, 440),
      input: [
        hold("jump", 5, 8), // "Begin" on the title
        hold("move_right", 20, 100), // into the arena; wait facing its guardian on patrol
        ...range(262, 294, 8).map((f) => hold("attack", f, f + 2)), // strike as it comes back
        hold("jump", 310, 313), // close "You got Wings"
        hold("move_left", 330, 440), // and leave the way we came
      ],
    },
    { project: game(), world: START, frames: 200, samples: range(0, 200), input: [hold("jump", 5, 8), hold("move_right", 20, 80), hold("move_left", 90, 200)] },
  ]) as [Sample[], Sample[]];
}, 180_000);

const first = (samples: Sample[], pred: (s: Sample) => boolean) => samples.find(pred);

describe("a room locked around its guardian, in the runtime", () => {
  const seals = (s: Sample) => s.props.filter((p) => p.id.startsWith("seal_")).map((p) => [p.id, p.visible, p.solid]);

  it("closes behind the player, with the guardian's health bar up", () => {
    const inside = first(fight, (s) => s.room === "depths_2" && entity(s, "player").x > 60)!;
    expect(inside.flags).toEqual(["depths_2_sealed"]);
    expect(inside.healthBars).toEqual(["warden_1"]);
    expect(seals(inside)).toEqual([
      ["seal_d1_d2_b", true, true],
      ["seal_depths_to_peak_a", true, true],
    ]);
  });

  it("keeps the way back shut while the guardian lives", () => {
    const last = shut.at(-1)!;
    expect(last.room).toBe("depths_2");
    expect(entity(last, "player").x).toBeGreaterThanOrEqual(32 + 14);
    expect(last.flags).toEqual(["depths_2_sealed"]);
  });

  it("opens when it falls, granting double jump with its message, and lets the player out", () => {
    const won = first(fight, (s) => s.flags.includes("depths_2_warden_beaten"))!;
    expect(won).toMatchObject({ room: "depths_2", modal: "got_wings", abilities: ["double_jump"], healthBars: [] });
    expect(seals(won)).toEqual([
      ["seal_d1_d2_b", false, false],
      ["seal_depths_to_peak_a", false, false],
    ]);
    expect(fight.at(-1)).toMatchObject({ room: "depths_1", modal: null, abilities: ["double_jump"] });
  });
});
