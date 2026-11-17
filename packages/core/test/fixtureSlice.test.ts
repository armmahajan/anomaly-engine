import { describe, expect, it } from "vitest";
import { fixtureSliceProject, gateCheck, lintProject, movementParams, SLICE_GATE_ABILITY, validateProject, worldTraversal, type MovementAbility, type PlayerCharacter } from "../src/index.ts";

describe("the fixture slice", () => {
  const project = fixtureSliceProject();
  const params = movementParams(project.characters[0] as PlayerCharacter, project.world.gravity);
  const reachesSummit = (abilities: MovementAbility[]) => worldTraversal(project.world, params, abilities).rooms.has("summit");

  it("is a valid, lint-free project", () => {
    expect(validateProject(project).ok).toBe(true);
    expect(lintProject(project)).toEqual([]);
  });

  it("gates the summit behind the ability the guardian grants (tiles only; props aside)", () => {
    expect(gateCheck(reachesSummit, [], SLICE_GATE_ABILITY)).toEqual({ withAbility: true, without: false, holds: true });
  });
});
