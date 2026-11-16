import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createDefaultProject,
  validateProject,
  wikiGaps,
  wikiKinds,
  wikiLinks,
  type OperationResult,
  type ProjectSpec,
} from "../src/index.ts";

const page = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "character", title: id, status: "draft", ...extra });

function apply(project: ProjectSpec, name: string, input: unknown): ProjectSpec {
  const result = applyOperation(project, name, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.project;
}

const withPages = (...pages: object[]) =>
  pages.reduce<ProjectSpec>((p, pg) => apply(p, "createWikiPage", { page: pg }), createDefaultProject());

const error = (result: OperationResult) => (result.ok ? null : result.error);

describe("wiki pages", () => {
  it("accept any snake_case kind, fill defaults, and reject duplicates and bad ids", () => {
    const project = withPages(page("sun_god", { kind: "deity" }));
    expect(project.wiki.pages[0]).toEqual({ id: "sun_god", kind: "deity", title: "sun_god", summary: "", body: "", fields: {}, status: "draft" });
    expect(error(applyOperation(project, "createWikiPage", { page: page("sun_god") }))).toMatchObject({ code: "invalid_input" });
    expect(error(applyOperation(project, "createWikiPage", { page: page("Sun God") }))).toMatchObject({ code: "invalid_input" });
    expect(error(applyOperation(project, "createWikiPage", { page: page("x", { kind: "Deity!" }) }))).toMatchObject({ code: "invalid_input" });
  });

  it("projects saved before the wiki existed load with an empty one", () => {
    const { wiki: _wiki, ...old } = createDefaultProject();
    const result = validateProject(old);
    expect(result.ok && result.project.wiki).toEqual({ pages: [] });
  });

  it("update changes only what is given; fields replace; characterId null unlinks", () => {
    let project = withPages(page("hero", { fields: { role: "player" }, characterId: "player", body: "old" }));
    project = apply(project, "updateWikiPage", { pageId: "hero", changes: { title: "The Lamplighter", fields: { motivation: "keep the light" } } });
    expect(project.wiki.pages[0]).toMatchObject({ title: "The Lamplighter", body: "old", fields: { motivation: "keep the light" }, characterId: "player" });
    project = apply(project, "updateWikiPage", { pageId: "hero", changes: { characterId: null } });
    expect(project.wiki.pages[0]).not.toHaveProperty("characterId");
    expect(error(applyOperation(project, "updateWikiPage", { pageId: "nobody", changes: { title: "x" } }))).toMatchObject({ code: "not_found" });
    expect(error(applyOperation(project, "updateWikiPage", { pageId: "hero", changes: {} }))).toMatchObject({ code: "invalid_input" });
  });

  it("accept makes a draft canon; delete removes a page", () => {
    let project = withPages(page("hero"));
    project = apply(project, "acceptWikiPage", { pageId: "hero" });
    expect(project.wiki.pages[0]!.status).toBe("canon");
    expect(error(applyOperation(project, "acceptWikiPage", { pageId: "hero" }))).toMatchObject({ code: "invalid_input" });
    expect(apply(project, "deleteWikiPage", { pageId: "hero" }).wiki.pages).toEqual([]);
  });
});

describe("links, kinds and gaps", () => {
  it("parse [[links]] and [[links|labels]] once each", () => {
    expect(wikiLinks("See [[hero]], [[old_city|the city]] and [[hero]] again. [[Not A Link]]")).toEqual(["hero", "old_city"]);
  });

  it("order kinds: suggested ones first, then the project's own", () => {
    const project = withPages(page("a", { kind: "deity" }), page("b", { kind: "place" }), page("c", { kind: "ability" }), page("d"));
    expect(wikiKinds(project.wiki)).toEqual(["character", "place", "ability", "deity"]);
  });

  it("report a missing overview, broken links, unwritten and deleted characters, without blocking edits", () => {
    let project = withPages(page("charger_page", { characterId: "charger", body: "Feared by [[villagers]]." }));
    project = apply(project, "deleteCharacter", { characterId: "charger" });
    expect(wikiGaps(project).map((g) => [g.code, g.pageId ?? g.characterId])).toEqual([
      ["no_overview", undefined],
      ["broken_link", "charger_page"],
      ["missing_character", "charger_page"],
      ["unwritten_character", "player"],
      ["unwritten_character", "crawler"],
    ]);
  });
});
