import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createDefaultProject,
  progressionReport,
  validateProject,
  type OperationResult,
  type ProjectSpec,
} from "../src/index.ts";

function apply(project: ProjectSpec, name: string, input: unknown): ProjectSpec {
  const result = applyOperation(project, name, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.project;
}
const steps = (project: ProjectSpec, ...calls: [string, unknown][]) => calls.reduce((p, [name, input]) => apply(p, name, input), project);
const error = (result: OperationResult) => (result.ok ? null : result.error);

const region = (id: string, extra = {}) => ["createRegion", { region: { id, name: id, status: "canon", ...extra } }] as [string, unknown];
const ability = (id: string, regionId: string, requires: string[] = [], extra = {}) =>
  ["createAbility", { ability: { id, name: id, mechanic: "key", obtainedIn: { regionId, source: "pickup", requires }, status: "canon", ...extra } }] as [string, unknown];
const link = (id: string, from: string, to: string, requires: string[] = [], oneWay = false) =>
  ["createConnection", { connection: { id, from, to, requires, oneWay, status: "canon" } }] as [string, unknown];

/**
 * gate (start) <-> city <-dash-> tower -lamp_key-> deep (ending)
 *                  city <-double_jump-> vault
 * dash in city, lamp_key and double_jump in the tower.
 */
const lamplight = () =>
  steps(
    createDefaultProject(),
    region("gate"),
    region("city", { enemies: ["crawler"], boss: "charger" }),
    region("tower"),
    region("deep"),
    region("vault"),
    ability("dash", "city"),
    ability("lamp_key", "tower"),
    ability("double_jump", "tower"),
    link("gate_city", "gate", "city"),
    link("city_tower", "city", "tower", ["dash"]),
    link("tower_deep", "tower", "deep", ["lamp_key"], true),
    link("city_vault", "city", "vault", ["double_jump"]),
    ["setProgressionEnds", { start: "gate", ending: "deep" }],
  );

const codes = (project: ProjectSpec) => progressionReport(project).issues.map((i) => i.code);

describe("progression checks", () => {
  it("orders regions and abilities into spheres and finds the critical path", () => {
    const report = progressionReport(lamplight());
    expect(report.spheres).toEqual([
      { regions: ["gate", "city"], abilities: ["dash"] },
      { regions: ["tower"], abilities: ["lamp_key", "double_jump"] },
      { regions: ["deep", "vault"], abilities: [] },
    ]);
    expect(report.finishable).toBe(true);
    expect(report.criticalPath).toEqual(["dash", "lamp_key"]);
    expect(report.issues).toEqual([]);
  });

  it("finds a one-way drop that traps the player", () => {
    const project = steps(lamplight(), region("pit"), link("city_pit", "city", "pit", [], true));
    const [lock] = progressionReport(project).issues;
    expect(lock).toMatchObject({ code: "soft_lock", severity: "error", ids: ["pit", "city_pit"] });
    expect(lock!.message).toContain("holding nothing (sphere 0)");
    // A way back out fixes it, but only once you can use it: with the dash, the trap is gone.
    expect(codes(steps(project, link("pit_city", "pit", "city", [], true)))).toEqual([]);
    expect(codes(steps(project, link("pit_city", "pit", "city", ["dash"], true)))).toEqual(["soft_lock"]);
  });

  it("reports an unbeatable game, unplaced and unobtainable abilities, and unreachable regions", () => {
    const unplaced = apply(lamplight(), "updateAbility", { abilityId: "lamp_key", changes: { obtainedIn: null } });
    expect(unplaced.progression.abilities.find((a) => a.id === "lamp_key")).not.toHaveProperty("obtainedIn");
    expect(codes(unplaced)).toEqual(["unbeatable", "unplaced"]);
    expect(progressionReport(unplaced).criticalPath).toEqual([]);

    const island = steps(lamplight(), region("island"), ability("bell", "island"), link("island_vault", "island", "vault", ["bell"], true));
    const report = progressionReport(island);
    expect(report.issues.map((i) => [i.code, i.ids[0]])).toEqual([
      ["unobtainable", "bell"],
      ["unreachable_region", "island"],
    ]);
    expect(report.issues[0]!.message).toBe("bell can never be collected: island is unreachable.");
  });

  it("warns about abilities that gate nothing or come all at once", () => {
    const flat = steps(createDefaultProject(), region("a"), region("b"), ability("x", "a"), ability("y", "a"), link("ab", "a", "b", ["x"]), ["setProgressionEnds", { start: "a", ending: "b" }]);
    expect(codes(flat)).toEqual(["gates_nothing", "front_loaded"]);
    expect(codes(createDefaultProject())).toEqual([]);
    expect(codes(steps(createDefaultProject(), region("a")))).toEqual(["no_start", "no_ending"]);
  });

  it("checks story beats against the wiki's order and links", () => {
    const page = (id: string, order: string) => ["createWikiPage", { page: { id, kind: "story", title: id, fields: { order }, status: "canon" } }] as [string, unknown];
    const beat = (id: string, wikiPageId: string, regionId: string, requires: string[] = []) =>
      ["createStoryBeat", { beat: { id, wikiPageId, regionId, requires, status: "canon" } }] as [string, unknown];
    const project = steps(lamplight(), page("arrival", "1"), page("the_flood", "2"), beat("b1", "arrival", "tower"), beat("b2", "the_flood", "gate"));
    const report = progressionReport(project);
    expect(report.beatSphere).toEqual({ b1: 1, b2: 0 });
    expect(report.issues).toMatchObject([{ code: "beat_order", ids: ["b2", "b1"] }]);

    const unlinked = steps(project, ["deleteWikiPage", { pageId: "arrival" }], ["updateRegion", { regionId: "gate", changes: { wikiPageId: "gate_page" } }]);
    expect(codes(unlinked)).toEqual(["missing_wiki_page", "missing_wiki_page"]);
  });
});

describe("progression operations", () => {
  it("validate references and keep ids unique across all lists", () => {
    const project = lamplight();
    expect(error(applyOperation(project, "createAbility", { ability: { id: "city", name: "City", mechanic: "dash", status: "draft" } }))).toMatchObject({
      message: 'progression id "city" is already used',
    });
    const badLink = error(applyOperation(project, ...link("x", "city", "moon")));
    expect(badLink?.code).toBe("invalid_result");
    expect(badLink?.message).toContain('unknown region "moon" (known: gate, city, tower, deep, vault)');
    expect(error(applyOperation(project, ...link("y", "city", "city")))?.message).toContain("two different regions");
    expect(error(applyOperation(project, "updateRegion", { regionId: "gate", changes: { boss: "player" } }))?.message).toContain('unknown enemy character "player"');
    expect(error(applyOperation(project, "updateAbility", { abilityId: "dash", changes: { obtainedIn: { regionId: "city", source: "boss", requires: ["dash"] } } }))?.message).toContain(
      "can't require itself",
    );
  });

  it("cascade deletes so nothing dangles", () => {
    const noTower = apply(lamplight(), "deleteProgressionItem", { id: "tower" });
    expect(noTower.progression.connections.map((c) => c.id)).toEqual(["gate_city", "city_vault"]);
    expect(noTower.progression.abilities.filter((a) => a.obtainedIn).map((a) => a.id)).toEqual(["dash"]);

    const noDash = apply(lamplight(), "deleteProgressionItem", { id: "dash" });
    expect(noDash.progression.connections.find((c) => c.id === "city_tower")!.requires).toEqual([]);

    const noEnds = apply(lamplight(), "deleteProgressionItem", { id: "gate" });
    expect(noEnds.progression.start).toBeUndefined();

    const noCharger = apply(lamplight(), "deleteCharacter", { characterId: "charger" });
    expect(noCharger.progression.regions.find((r) => r.id === "city")).toMatchObject({ enemies: ["crawler"] });
    expect(noCharger.progression.regions.find((r) => r.id === "city")).not.toHaveProperty("boss");
  });

  it("accept drafts, clear optional fields with null, and set the ends", () => {
    const project = steps(lamplight(), ["createRegion", { region: { id: "shore", name: "Shore", status: "draft" } }]);
    expect(project.progression.regions.at(-1)).toEqual({ id: "shore", name: "Shore", rooms: 8, enemies: [], status: "draft" });
    const accepted = apply(project, "acceptProgressionItem", { id: "shore" });
    expect(accepted.progression.regions.at(-1)!.status).toBe("canon");
    expect(error(applyOperation(accepted, "acceptProgressionItem", { id: "shore" }))?.message).toBe('"shore" is already canon');
    expect(error(applyOperation(accepted, "acceptProgressionItem", { id: "moon" }))?.code).toBe("not_found");

    const cleared = apply(accepted, "updateRegion", { regionId: "city", changes: { boss: null, rooms: 12 } });
    expect(cleared.progression.regions.find((r) => r.id === "city")).toEqual({ id: "city", name: "city", rooms: 12, enemies: ["crawler"], status: "canon" });
    const ends = apply(cleared, "setProgressionEnds", { start: "shore", ending: null });
    expect(ends.progression).toMatchObject({ start: "shore" });
    expect(ends.progression).not.toHaveProperty("ending");
  });

  it("projects saved before progression existed load with an empty one", () => {
    const { progression: _p, ...old } = createDefaultProject();
    const result = validateProject(old);
    expect(result.ok && result.project.progression).toEqual({ abilities: [], regions: [], connections: [], beats: [] });
  });
});
