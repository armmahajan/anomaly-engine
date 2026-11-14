import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createDefaultProject,
  findUndoTarget,
  undoLast,
  type Change,
  type HistoryEntry,
} from "../src/index.ts";

const entry = (revision: number, change: Change): HistoryEntry => ({
  revision,
  at: "",
  author: "user",
  change,
  before: { ...createDefaultProject(), name: `before ${revision}` },
});
const op: Change = { kind: "operation", name: "updateCharacter", input: {} };

describe("findUndoTarget", () => {
  it("returns null for empty history", () => {
    expect(findUndoTarget([])).toBeNull();
  });

  it("skips undone operations and undo entries", () => {
    const history = [entry(1, op), entry(2, op), entry(3, { kind: "undo", undoes: 2 })];
    expect(findUndoTarget(history)?.revision).toBe(1);
    expect(findUndoTarget([...history, entry(4, { kind: "undo", undoes: 1 })])).toBeNull();
  });
});

describe("undoLast", () => {
  it("restores the snapshot as a new revision", () => {
    const current = { ...createDefaultProject(), revision: 2 };
    const result = undoLast(current, [entry(1, op), entry(2, op)]);
    expect(result).toMatchObject({ ok: true, undoes: 2, project: { name: "before 2", revision: 3 } });
  });

  it("fails cleanly with nothing to undo", () => {
    expect(undoLast(createDefaultProject(), [])).toMatchObject({ ok: false, error: { code: "nothing_to_undo" } });
  });
});

describe("applyOperation", () => {
  it("dispatches by name and rejects unknown operations", () => {
    const project = createDefaultProject();
    const input = { characterId: "player", changes: { stats: { runSpeed: 99 } } };
    expect(applyOperation(project, "updateCharacter", input).ok).toBe(true);
    expect(applyOperation(project, "toString", input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
