import { z } from "zod";
import { fail, validateProject, type OperationError } from "./operations.ts";
import type { ProjectSpec } from "./schema.ts";

/** Who made a change. Every history entry is attributed. */
export const Author = z.enum(["user", "ai"]);
export type Author = z.infer<typeof Author>;

export type Change =
  | { kind: "operation"; name: string; input: unknown }
  /** Several operations applied atomically as one revision. */
  | { kind: "batch"; operations: { name: string; input: unknown }[] }
  | { kind: "undo"; undoes: number }
  /** One stage of an Architect run, committed as one revision (undo restores the project before it). */
  | { kind: "stage"; stage: string; summary: string };

/**
 * One append-only history record. `before` is a full snapshot: projects are
 * small, and snapshots make undo trivially correct.
 */
export interface HistoryEntry {
  /** The revision this change produced. */
  revision: number;
  at: string;
  author: Author;
  change: Change;
  before: ProjectSpec;
}

/**
 * Linear undo over an append-only log: the target is the most recent
 * operation that has not been undone. Undo entries are never undone
 * themselves (no redo yet).
 */
export function findUndoTarget(history: readonly HistoryEntry[]): HistoryEntry | null {
  const undone = new Set<number>();
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (entry.change.kind === "undo") {
      undone.add(entry.change.undoes);
    } else if (!undone.has(entry.revision)) {
      return entry;
    }
  }
  return null;
}

export type UndoResult =
  | { ok: true; project: ProjectSpec; undoes: number }
  | { ok: false; error: OperationError };

/** Restore the project to before the last un-undone operation, as a new revision. */
export function undoLast(project: ProjectSpec, history: readonly HistoryEntry[]): UndoResult {
  const target = findUndoTarget(history);
  if (!target) return fail("nothing_to_undo", "there is nothing to undo");
  const validated = validateProject({ ...target.before, revision: project.revision + 1 });
  if (!validated.ok) {
    return fail("invalid_result", `cannot undo revision ${target.revision}: snapshot is invalid`, validated.issues);
  }
  return { ok: true, project: validated.project, undoes: target.revision };
}

export function summarizeChange(change: Change): string {
  switch (change.kind) {
    case "undo":
      return `undo revision ${change.undoes}`;
    case "batch":
      return `batch: ${change.operations.map((o) => o.name).join(", ")}`;
    case "operation":
      return change.name;
    case "stage":
      return `architect ${change.stage}: ${change.summary}`;
  }
}
