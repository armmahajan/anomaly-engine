import type { ProjectSpec } from "../../schema.ts";
import type { MovementAbility } from "../../movement/params.ts";

/**
 * The logic-aware checker (agent I): proves, deterministically and without
 * any model, that a game can be finished and has no dead states.
 *
 * A state is where the player is (a room and a traversal node: a standing
 * surface or a door entry) plus everything the run remembers: items, flags,
 * abilities, the checkpoint, and what is beaten or destroyed in the current
 * visit. Moves are the game's real rules: movement through the room with the
 * props that are solid in that state (traversal.ts, the runtime's physics),
 * doors, prop events (touch, interact, hit, destroyed) and their handlers,
 * enemy kills (fights count as winnable: fairness is the creator's call),
 * room clears, timers, modal buttons (each a choice), death where it can
 * happen (the game's death rule), and resuming a saved run (Continue).
 *
 * Beatable: the start reaches an ending (an endGame effect runs).
 * No dead states: every reachable state, and every state a save can resume
 * into, can still reach an ending.
 */

/** What the run remembers (a logical state, without the position). */
export interface LogicMemory {
  items: Record<string, number>;
  flags: string[];
  abilities: MovementAbility[];
  checkpoint: { room: string; x: number; y: number } | null;
}

/** One step of a counterexample, readable by people and the Architect. */
export interface LogicStep {
  /** e.g. "walk to the ledge", "touch prop key", "door east -> hall", "die (respawn at checkpoint)", "press 'Begin'". */
  action: string;
  room: string;
  /** The traversal node the player stands at after the step. */
  node: string;
  memory: LogicMemory;
}

export interface DeadState {
  /** How to get there from the start (or from Continue, when `fromSave`). */
  path: LogicStep[];
  /** Why nothing leads to an ending from there, in a sentence (e.g. "the lock needs item key, and no key is left"). */
  why: string;
  /** Reached by resuming a saved run. */
  fromSave: boolean;
}

export interface CheckResult {
  /** The game runs an endGame effect somewhere. */
  hasEnding: boolean;
  beatable: boolean;
  /** A shortest way from the start to an ending, when beatable. */
  route: LogicStep[] | null;
  /** Distinct dead states (one counterexample each, shortest first). */
  deadStates: DeadState[];
  stats: { states: number; ms: number; truncated: boolean };
}

export interface CheckOptions {
  /** Abilities the player starts with (default: the world start has none; the playtest's when checking from it). */
  abilities?: MovementAbility[];
  /** Stop after this many states (the result says `truncated`). */
  maxStates?: number;
}

export function checkGame(_project: ProjectSpec, _options: CheckOptions = {}): CheckResult {
  throw new Error("checkGame is not implemented yet");
}
