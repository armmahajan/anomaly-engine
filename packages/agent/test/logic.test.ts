import { describe, expect, it } from "vitest";
import { fixtureSliceProject, ProjectSpec } from "@anomaly/core";
import { Draft, executeTool } from "../src/index.ts";

const check = (draft: Draft, args: object = {}) => executeTool(draft, "checkGame", JSON.stringify(args)) as Record<string, any>;

describe("the checkGame read tool", () => {
  it("proves the slice beatable, in a compact verdict", () => {
    const verdict = check(new Draft(fixtureSliceProject()));
    expect(verdict).toMatchObject({ ok: true, beatable: true, deadStates: [] });
    expect(verdict.route).toContain("summit: touch Altar: the game ends");
    expect(verdict.route.some((s: string) => /\(\d+, \d+\)/.test(s) && !s.includes("door"))).toBe(false); // moves within a room left out
    expect(JSON.stringify(verdict).length).toBeLessThan(1500);
  });

  it("shows a dead state with its last steps and why", () => {
    const base = fixtureSliceProject();
    const decoy = { id: "decoy", name: "Rusty lock", x: 640, y: 320, width: 32, height: 64, handlers: [{ on: { type: "interact" }, when: [{ type: "item", item: "key" }], do: [{ type: "takeItem", item: "key" }] }] };
    const project = ProjectSpec.parse({ ...base, world: { ...base.world, rooms: base.world.rooms.map((r) => (r.id === "hall" ? { ...r, props: [...r.props, decoy] } : r)) } });
    const verdict = check(new Draft(project));
    expect(verdict.beatable).toBe(true);
    expect(verdict.deadStates[0].why).toContain("needs item key");
    expect(verdict.deadStates[0].lastSteps.at(-1)).toBe("hall: use Rusty lock");
  });

  it("checks gates: without double jump the summit is out of reach", () => {
    const verdict = check(new Draft(fixtureSliceProject()), { withoutAbilities: ["double_jump"] });
    expect(verdict.beatable).toBe(false);
    expect(verdict.reachableRooms).not.toContain("summit");
    expect(check(new Draft(fixtureSliceProject()), { withoutAbilities: ["flying"] })).toMatchObject({ ok: false });
  });
});
