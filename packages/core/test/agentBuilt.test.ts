import { describe, expect, it } from "vitest";
import agentBuilt from "./fixtures/agentBuiltRun.json" with { type: "json" };
import { abilityChecks, checkGame, migrateProject, progressionReport, ProjectSpec } from "../src/index.ts";

// A game the agents built from a pitch with the real models (scripts/agent-build.ts, art removed):
// the director's progression gates the pump key on dash, and the build assistant used a gate room.

describe("an agent-built game", () => {
  const project = ProjectSpec.parse(migrateProject(agentBuilt));

  it("is beatable with no dead states, and dash is really needed", () => {
    const result = checkGame(project);
    expect(result.beatable).toBe(true);
    expect(result.deadStates).toEqual([]);
    expect(abilityChecks(project, progressionReport(project).criticalPath)).toEqual([{ ability: "dash", mechanic: "dash", needed: true }]);
  });

  it("explains dead states without the ability (surfaces are matched across graphs with other solids)", () => {
    const without = checkGame(project, { withoutAbilities: ["dash"] });
    expect(without.beatable).toBe(false);
    expect(without.deadStates.length).toBeGreaterThan(0);
    expect(without.deadStates.every((d) => d.why.length > 0)).toBe(true);
  });
});
