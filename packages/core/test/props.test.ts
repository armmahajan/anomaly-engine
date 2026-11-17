import { describe, expect, it } from "vitest";
import { applyBatch, applyOperation, ARENA_FLOOR, createDefaultProject, lintProject, type OperationResult, type ProjectSpec } from "../src/index.ts";

function ok(result: OperationResult): ProjectSpec {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}
const op = (p: ProjectSpec, name: string, input: unknown) => applyOperation(p, name, input);
const props = (p: ProjectSpec) => p.world.rooms[0]!.props;
const base = () => ok(op(createDefaultProject(), "createItem", { name: "Brass Key" }));

describe("prop operations", () => {
  it("add props with ids from the name or prop_<n>, and defaults", () => {
    let p = ok(op(base(), "addProp", { roomId: "arena", name: "Old Gate", x: 900, y: 576, width: 32, height: 96 }));
    p = ok(op(p, "addProp", { roomId: "arena", x: 100, y: 100, width: 16, height: 16 }));
    p = ok(op(p, "addProp", { roomId: "arena", name: "Old Gate", x: 0, y: 0, width: 8, height: 8 }));
    expect(props(p).map((x) => x.id)).toEqual(["old_gate", "prop_1", "old_gate_2"]);
    expect(props(p)[1]).toMatchObject({ solid: false, visible: true, health: null, bounce: false, prompt: null, handlers: [], art: null });
    expect(p.revision).toBe(createDefaultProject().revision + 4);
  });

  it("reject bad input, unknown rooms and duplicate ids", () => {
    const p = ok(op(base(), "addProp", { roomId: "arena", id: "gate", x: 0, y: 0, width: 8, height: 8 }));
    expect(op(p, "addProp", { roomId: "arena", id: "gate", x: 0, y: 0, width: 8, height: 8 })).toMatchObject({ ok: false, error: { message: expect.stringContaining('already has a prop "gate"') } });
    expect(op(p, "addProp", { roomId: "nope", x: 0, y: 0, width: 8, height: 8 })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(op(p, "addProp", { roomId: "arena", x: 0, y: 0, width: 1, height: 8 })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(op(p, "addProp", { roomId: "arena", x: 0, y: 0, width: 8, height: 8, visible: { type: "item", item: "nope" } })).toMatchObject({
      ok: false,
      error: { code: "invalid_result", message: expect.stringContaining('unknown item "nope"') },
    });
    expect(op(p, "updateProp", { roomId: "arena", propId: "nope", changes: {} })).toMatchObject({ ok: false, error: { message: expect.stringContaining("known: gate") } });
  });

  it("update only the fields given, rename, clear the name, and remove", () => {
    let p = ok(op(base(), "addProp", { roomId: "arena", name: "Gate", x: 0, y: 0, width: 8, height: 8, solid: true, health: 3 }));
    p = ok(op(p, "updateProp", { roomId: "arena", propId: "gate", changes: { x: 40, visible: { type: "flag", flag: "open", is: false }, prompt: "Open" } }));
    expect(props(p)[0]).toMatchObject({ x: 40, y: 0, solid: true, health: 3, name: "Gate", prompt: "Open", visible: { type: "flag", flag: "open", is: false } });
    p = ok(op(p, "updateProp", { roomId: "arena", propId: "gate", changes: { id: "door", name: null, health: null } }));
    expect(props(p)[0]).toMatchObject({ id: "door", health: null });
    expect(props(p)[0]).not.toHaveProperty("name");
    p = ok(op(p, "removeProp", { roomId: "arena", propId: "door" }));
    expect(props(p)).toEqual([]);
  });

  it("move and resize in one batch is one undo step", () => {
    const p = ok(op(base(), "addProp", { roomId: "arena", x: 0, y: 0, width: 8, height: 8 }));
    const moved = ok(applyBatch(p, [{ name: "updateProp", input: { roomId: "arena", propId: "prop_1", changes: { x: 16, y: 32, width: 64, height: 24 } } }]));
    expect(props(moved)[0]).toMatchObject({ x: 16, y: 32, width: 64, height: 24 });
    expect(moved.revision).toBe(p.revision + 1);
  });
});

describe("item operations", () => {
  it("create (id from the name), update and delete", () => {
    let p = base();
    expect(p.world.items).toEqual([{ id: "brass_key", name: "Brass Key", description: "", color: "#e8c547" }]);
    expect(op(p, "createItem", { name: "x", id: "brass_key" })).toMatchObject({ ok: false });
    p = ok(op(p, "updateItem", { itemId: "brass_key", changes: { name: "Key", color: "#ff0000", description: "Opens things." } }));
    expect(p.world.items[0]).toEqual({ id: "brass_key", name: "Key", description: "Opens things.", color: "#ff0000" });
    expect(op(p, "updateItem", { itemId: "nope", changes: {} })).toMatchObject({ ok: false, error: { code: "not_found" } });
    p = ok(op(p, "deleteItem", { itemId: "brass_key" }));
    expect(p.world.items).toEqual([]);
  });

  it("refuse to delete an item still in use, naming where", () => {
    let p = ok(
      op(base(), "addProp", {
        roomId: "arena",
        id: "gate",
        x: 0,
        y: 0,
        width: 8,
        height: 8,
        solid: { type: "not", of: { type: "item", item: "brass_key" } },
        handlers: [{ on: { type: "touch" }, do: [{ type: "giveItem", item: "brass_key" }] }],
      }),
    );
    p = ok(op(p, "setHandlers", { handlers: [{ on: { type: "gameStarted" }, when: [{ type: "item", item: "brass_key" }], do: [{ type: "heal" }] }] }));
    const result = op(p, "deleteItem", { itemId: "brass_key" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe('item "brass_key" is still used by the game\'s handler 0, prop arena/gate (solid), prop arena/gate handler 0; change those first');
  });
});

describe("prop lint", () => {
  const lint = (p: ProjectSpec) => lintProject(p).filter((w) => w.code.startsWith("prop_"));

  it("flags props outside the room, never visible, and solid over the start or playtest spot", () => {
    const p = ok(
      applyBatch(base(), [
        { name: "addProp", input: { roomId: "arena", id: "out", x: 1590, y: 0, width: 32, height: 32 } },
        { name: "addProp", input: { roomId: "arena", id: "ghost", x: 300, y: 300, width: 32, height: 32, visible: false, handlers: [{ on: { type: "touch" }, do: [{ type: "heal" }] }] } },
        { name: "addProp", input: { roomId: "arena", id: "wall", x: 150, y: ARENA_FLOOR - 64, width: 32, height: 64, solid: { type: "flag", flag: "f" } } },
        { name: "addProp", input: { roomId: "arena", id: "plate", x: 150, y: ARENA_FLOOR - 64, width: 32, height: 64, handlers: [{ on: { type: "interact" }, do: [{ type: "heal" }] }] } },
      ]),
    );
    expect(lint(p).map((w) => [w.code, w.path])).toEqual([
      ["prop_out_of_bounds", "world.rooms.0.props.0"],
      ["prop_never_present", "world.rooms.0.props.1.visible"],
      ["prop_handlers_never_run", "world.rooms.0.props.1.handlers"],
      ["prop_blocks_spot", "world.rooms.0.props.2"],
      ["prop_blocks_spot", "world.rooms.0.props.2"],
    ]);
    expect(lint(p)[3]!.message).toContain("can be solid and covers the world's start");
  });
});
