import { describe, expect, it } from "vitest";
import {
  applyOperation,
  applyPreview,
  buildPreview,
  canPreview,
  createDefaultProject,
  fixtureReferenceProject,
  gameCharacterPages,
  markStagesStale,
  pageGameKind,
  previewOwnsPlan,
  progressionFingerprint,
  ProjectSpec,
  type WikiPage,
} from "../src/index.ts";

/** The reference game's design (wiki, progression, cast) with no world built yet. */
function design(): ProjectSpec {
  const reference = fixtureReferenceProject();
  return ProjectSpec.parse({ ...reference, world: { ...reference.world, rooms: reference.world.rooms.filter((r) => r.id === "arena"), start: null, playtest: null, handlers: [], modals: [], items: [] } });
}

const op = (project: ProjectSpec, name: string, input: unknown) => {
  const result = applyOperation(project, name, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.project;
};

describe("the live preview of the world", () => {
  it("builds proven rooms for every region from the progression, and owns the plan until someone shapes it", () => {
    const project = design();
    expect(canPreview(project)).toBe(true);
    expect(previewOwnsPlan(project)).toBe(true);
    const { project: built, issues } = buildPreview(project);
    expect(issues).toEqual([]);
    const saved = ProjectSpec.parse(built);
    const plan = saved.architect;
    expect(plan.rooms.length).toBeGreaterThan(3);
    for (const room of plan.rooms) expect(saved.world.rooms.find((r) => r.id === room.id)).toMatchObject({ regionId: room.regionId });
    expect(plan.stages.geometry).toMatchObject({ status: "done" });
    expect(plan.stages.plan).toBeUndefined(); // the model's plan stage hasn't run
    expect(saved.world.start).not.toBeNull();
    expect(previewOwnsPlan(saved)).toBe(true);

    // A plan edit, a pinned room, a stage run or a painted room: someone else has the plan now.
    const room = plan.rooms[0]!.id;
    expect(previewOwnsPlan(op(saved, "updateRoomPlan", { roomId: room, changes: { notes: "mine" } }))).toBe(false);
    expect(previewOwnsPlan(op(saved, "setRoomPinned", { roomId: room, pinned: true }))).toBe(false);
    expect(previewOwnsPlan(op(saved, "setStageStatus", { stage: "plan", status: { status: "done", summary: "model" } }))).toBe(false);
    expect(previewOwnsPlan(op(saved, "paintTiles", { roomId: room, kind: "hazard", cells: [[3, 3]] }))).toBe(false);
    // Other changes don't count.
    expect(previewOwnsPlan(op(saved, "setArchitectGuidance", { guidance: "short and sweet" }))).toBe(true);
  }, 60_000);

  it("lands on the project as it is now, keeping what changed meanwhile, and refuses once taken over", () => {
    const project = design();
    const { project: built } = buildPreview(project);
    const meanwhile = op(project, "createWikiPage", { page: { id: "later", kind: "lore", title: "Later", status: "canon" } });
    const landed = applyPreview(meanwhile, built)!;
    expect(landed.wiki.pages.some((p) => p.id === "later")).toBe(true);
    expect(landed.architect.rooms).toEqual(built.architect.rooms);
    expect(previewOwnsPlan(ProjectSpec.parse(landed))).toBe(true);
    // The progression moved on: this preview no longer applies.
    const renamed = op(meanwhile, "updateRegion", { regionId: project.progression.regions[0]!.id, changes: { name: "Elsewhere" } });
    expect(progressionFingerprint(renamed)).not.toBe(progressionFingerprint(meanwhile));
    expect(applyPreview(renamed, built)).toBeNull();
    // A rebuild replaces the rooms of the plan it replaces.
    const first = ProjectSpec.parse(landed);
    const fewer = op(first, "updateRegion", { regionId: project.progression.regions[0]!.id, changes: { rooms: 1 } });
    const rebuilt = ProjectSpec.parse(applyPreview(fewer, buildPreview(fewer).project)!);
    const planIds = new Set(rebuilt.architect.rooms.map((r) => r.id));
    expect(rebuilt.world.rooms.filter((r) => r.regionId !== undefined).every((r) => planIds.has(r.id))).toBe(true);
    expect(rebuilt.architect.rooms.length).toBeLessThan(first.architect.rooms.length);
  }, 60_000);

  it("marks done stages stale", () => {
    const { project: built } = buildPreview(design());
    const stale = markStagesStale(ProjectSpec.parse(built))!;
    expect(stale.architect.stages.geometry?.status).toBe("stale");
    expect(markStagesStale(stale)).toBeNull();
  }, 60_000);
});

describe("game characters in the wiki", () => {
  const page = (id: string, fields: Record<string, string>, extra: Partial<WikiPage> = {}): WikiPage => ({ id, kind: "character", title: id, summary: "", body: "", fields, status: "draft", ...extra });
  const project = createDefaultProject();

  it("reads the in_game field, then the link, the progression's lists and the role", () => {
    expect(pageGameKind(project, page("moth", { in_game: "enemy (boss)" }))).toBe("enemy");
    expect(pageGameKind(project, page("hero", { in_game: "Player" }))).toBe("player");
    expect(pageGameKind(project, page("sage", { in_game: "none", role: "enemy" }))).toBeNull();
    expect(pageGameKind(project, page("sage", { in_game: "" , role: "player character" }))).toBe("player");
    expect(pageGameKind(project, page("x", {}, { characterId: "crawler" }))).toBe("enemy");
    expect(pageGameKind(project, page("x", { role: "former enemy, now an ally" }))).toBeNull();
    expect(pageGameKind(project, page("x", { role: "mentor" }))).toBeNull();
    const listed = { ...project, progression: { ...project.progression, regions: [{ id: "r", name: "R", rooms: 2, enemies: ["charger"], status: "draft" as const }] } };
    expect(pageGameKind(listed, page("charger", {}))).toBe("enemy");
    expect(gameCharacterPages({ ...project, wiki: { pages: [page("a", { in_game: "enemy" }), page("b", { in_game: "none" })] } }).map((p) => p.page.id)).toEqual(["a"]);
  });
});
