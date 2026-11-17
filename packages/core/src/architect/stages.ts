import type { ProjectSpec } from "../schema.ts";
import type { ArchitectStage } from "./plan.ts";

/**
 * The Architect's stage contract. A stage is a pure function of the project:
 * it reads `project.architect` (the plan) and the rest of the project, and
 * returns the next project plus what it couldn't do. The server runs stages
 * in order, commits each result as one undoable revision, and pauses where
 * the plan says. Stages never touch pinned rooms (`RoomPlan.pinned`).
 *
 * Code stages live in core (this folder); model stages (plan, cast) run on
 * the server through the Architect agent, with a deterministic fallback here.
 */

export interface StageIssue {
  stage: ArchitectStage;
  /** Short kebab/snake code, stable for tests and repair routing. */
  code: string;
  message: string;
  roomId?: string;
  linkId?: string;
}

export interface StageOutcome {
  project: ProjectSpec;
  issues: StageIssue[];
  /** One line for the creator: what the stage did. */
  summary: string;
}

export interface StageOptions {
  /** Only these plan rooms (e.g. regenerate one room); default all unpinned rooms. */
  rooms?: string[];
}

export type CodeStage = (project: ProjectSpec, options?: StageOptions) => StageOutcome;

/** Plan rooms a stage may rewrite: unpinned, and among `options.rooms` when given. */
export function stageRooms(project: ProjectSpec, options: StageOptions = {}): string[] {
  return project.architect.rooms.filter((r) => !r.pinned && (!options.rooms || options.rooms.includes(r.id))).map((r) => r.id);
}

export const unchanged = (project: ProjectSpec, summary: string): StageOutcome => ({ project, issues: [], summary });
