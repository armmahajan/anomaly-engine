import { describe, expect, it } from "vitest";
import { fixtureReferenceProject, gameArtPlan, lintProject, progressionReport, REFERENCE_REGIONS, roomGroups, validateProject } from "../src/index.ts";

describe("the golden reference game", () => {
  const project = fixtureReferenceProject();

  it("is valid, lint-free, and its design documents are complete", () => {
    expect(validateProject(project).ok).toBe(true);
    expect(lintProject(project).map((w) => w.message)).toEqual([]);
    const report = progressionReport(project);
    expect(report.issues).toEqual([]);
    expect(report.finishable).toBe(true);
    expect(report.criticalPath).toEqual(["hatch_key", "double_jump"]);
  });

  it("has every room in a region, so the art plan paints a biome per region", () => {
    expect(roomGroups(project).map((g) => g.group).sort()).toEqual(Object.keys(REFERENCE_REGIONS).sort());
    expect(gameArtPlan(project).filter((s) => s.kind === "biome").map((s) => s.id).sort()).toEqual(["biome:spire", "biome:summit", "biome:undercroft"]);
    expect(gameArtPlan(project).find((s) => s.id === "biome:spire")!.request.brief).toContain("The Spire: A drowned cistern");
  });
});

describe("the golden reference game's gates", () => {
  it("are proven by the checker: the summit needs double jump, and the game is beatable with no dead states", async () => {
    const { checkGame, gateChecks } = await import("../src/index.ts");
    const project = fixtureReferenceProject();
    const result = checkGame(project);
    expect(result.beatable).toBe(true);
    expect(result.deadStates).toEqual([]);
    expect(gateChecks(project, result)).toEqual([
      { connection: "up_to_summit", from: "spire", to: "summit", needs: ["double_jump"], holdsWithout: true, reachableWith: true },
    ]);
  });
});
