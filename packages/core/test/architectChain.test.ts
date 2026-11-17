import { describe, expect, it } from "vitest";
import { difficultyStage, estimatePlayTime, fixtureReferenceProject, geometryStage, layoutStage, populationStage, ProjectSpec, screensStage, seedPlan, verifyStage, type StageOutcome } from "../src/index.ts";

// The Architect's code stages end to end, no model and no hand edits: the plan seeded from the
// progression -> layout -> geometry -> population (+ difficulty) -> screens -> verify.
export function buildFromProgression(project: ProjectSpec) {
  const steps: [string, (p: ProjectSpec) => StageOutcome][] = [
    ["layout", (p) => layoutStage(p)],
    ["geometry", (p) => geometryStage(p)],
    ["population", (p) => populationStage(p)],
    ["difficulty", (p) => difficultyStage(p)],
    ["screens", (p) => screensStage(p)],
  ];
  let current = ProjectSpec.parse({ ...project, architect: seedPlan(project) });
  const log: string[] = [];
  for (const [name, run] of steps) {
    const out = run(current);
    log.push(`${name}: ${out.summary}${out.issues.length ? ` [${out.issues.map((i) => i.code).join(", ")}]` : ""}`);
    current = ProjectSpec.parse(out.project);
  }
  return { project: current, log };
}

describe("the Architect's code stages end to end", () => {
  it("build the reference game's progression into a proven game: beatable, no dead states, gates hold, lint clean", () => {
    const reference = fixtureReferenceProject();
    // Only the design documents and the cast: the hand-built world is not used.
    const design = ProjectSpec.parse({ ...reference, world: { ...reference.world, rooms: [], start: null, playtest: null, handlers: [], modals: [], items: [] } });
    const { project, log } = buildFromProgression(design);
    const verdict = verifyStage(project);
    expect({ log, issues: verdict.issues }).toMatchObject({ issues: [] });
    expect(verdict.verdict).toMatchObject({ beatable: true, deadStates: 0, gatesHold: true, abilitiesNeeded: true, lint: [] });
    expect(project.world.rooms.map((r) => r.id).sort()).toEqual(project.architect.rooms.map((r) => r.id).sort());
    expect(estimatePlayTime(project).minutes).toBeGreaterThan(0);
  }, 120_000);
});
