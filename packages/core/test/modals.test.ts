import { describe, expect, it } from "vitest";
import { applyOperation, createDefaultProject, lintProject, modalImageChoices, type OperationResult, type ProjectSpec } from "../src/index.ts";

function ok(result: OperationResult): ProjectSpec {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}
const op = (p: ProjectSpec, name: string, input: unknown) => applyOperation(p, name, input);
const codes = (p: ProjectSpec) => lintProject(p).filter((w) => w.code.startsWith("modal") || w.code.startsWith("map"));

describe("modal operations", () => {
  it("create (id from the title), update and delete modals, one revision each", () => {
    let p = createDefaultProject();
    p = ok(op(p, "createModal", { title: "The End!" }));
    p = ok(op(p, "createModal", { title: "The End!", body: "again" }));
    expect(p.world.modals.map((m) => m.id)).toEqual(["the_end", "the_end_2"]);
    expect(p.world.modals[0]).toEqual({ id: "the_end", title: "The End!", body: "", image: null, buttons: [] });
    expect(op(p, "createModal", { id: "the_end" })).toMatchObject({ ok: false, error: { message: 'a modal "the_end" already exists' } });

    const revision = p.revision;
    p = ok(op(p, "updateModal", { modalId: "the_end", changes: { body: "Thanks", buttons: [{ label: "Again", do: [{ type: "setFlag", flag: "again" }] }] } }));
    expect(p.revision).toBe(revision + 1);
    expect(p.world.modals[0]).toMatchObject({ title: "The End!", body: "Thanks", buttons: [{ label: "Again", do: [{ type: "setFlag", flag: "again", value: true }] }] });
    expect(op(p, "updateModal", { modalId: "nope", changes: {} })).toMatchObject({ ok: false, error: { code: "not_found", message: expect.stringContaining("known: the_end, the_end_2") } });
    expect(op(p, "updateModal", { modalId: "the_end", changes: { buttons: [{ label: "x" }, { label: "x" }, { label: "x" }, { label: "x" }, { label: "x" }] } }).ok).toBe(false);
    expect(op(p, "updateModal", { modalId: "the_end", changes: { buttons: [{ label: "Go", do: [{ type: "showModal", modal: "ghost" }] }] } })).toMatchObject({
      ok: false,
      error: { code: "invalid_result" },
    });

    p = ok(op(p, "deleteModal", { modalId: "the_end_2" }));
    expect(p.world.modals.map((m) => m.id)).toEqual(["the_end"]);
  });

  it("refuse to delete a modal a handler or another modal's button shows, saying where", () => {
    let p = ok(op(createDefaultProject(), "createModal", { id: "credits" }));
    p = ok(op(p, "createModal", { id: "menu", buttons: [{ label: "Credits", do: [{ type: "showModal", modal: "credits" }] }] }));
    p = ok(op(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomEntered" }, do: [{ type: "endGame", modal: "credits" }] } }));
    const refused = op(p, "deleteModal", { modalId: "credits" });
    expect(refused).toMatchObject({ ok: false, error: { message: 'modal "credits" is shown by world.rooms.0.handlers.0, world.modals.1.buttons.0; change those first' } });
    // A modal whose own button shows it again can still go.
    p = ok(op(p, "updateModal", { modalId: "menu", changes: { buttons: [{ label: "Again", do: [{ type: "showModal", modal: "menu" }] }] } }));
    expect(ok(op(p, "deleteModal", { modalId: "menu" })).world.modals.map((m) => m.id)).toEqual(["credits"]);
  });

  it("turn the map on and off", () => {
    const p = ok(op(createDefaultProject(), "setMap", { enabled: true }));
    expect(p.world.map).toEqual({ enabled: true });
    expect(ok(op(p, "setMap", { enabled: false })).world.map).toEqual({ enabled: false });
    expect(op(p, "setMap", {}).ok).toBe(false);
  });

  it("offer the project's images", () => {
    const p = createDefaultProject();
    const file = "0123456789abcdef.png";
    const art = { ...p.art, assets: [{ id: "cave", kind: "biome", name: "Cave", brief: "", concepts: [], chosen: null, kit: { backdrop: file, ground: file, pieces: [], quality: "draft" }, rooms: [] }] };
    expect(modalImageChoices({ ...p, art } as ProjectSpec)).toEqual([{ file, label: "Cave backdrop" }]);
  });
});

describe("modal lint", () => {
  it("flags unused modals, modals that never close and a map with one room", () => {
    let p = ok(op(createDefaultProject(), "createModal", { id: "loop", buttons: [{ label: "Again", do: [{ type: "showModal", modal: "loop" }] }] }));
    p = ok(op(p, "setMap", { enabled: true }));
    expect(codes(p).map((w) => [w.code, w.path])).toEqual([
      ["modal_unused", "world.modals.0"],
      ["modal_never_closes", "world.modals.0"],
      ["map_too_small", "world.map"],
    ]);
    p = ok(op(p, "addHandler", { handler: { on: { type: "gameStarted" }, do: [{ type: "showModal", modal: "loop" }] } }));
    p = ok(op(p, "updateModal", { modalId: "loop", changes: { buttons: [{ label: "Again", do: [{ type: "showModal", modal: "loop" }] }, { label: "Play", do: [] }] } }));
    p = ok(op(p, "createWorldRoom", { name: "Second" }));
    expect(codes(p)).toEqual([]);
  });
});
