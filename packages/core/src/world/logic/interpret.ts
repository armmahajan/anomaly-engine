import type { ProjectSpec } from "../../schema.ts";
import type { Effect, GameCondition, Handler } from "../../events/events.ts";
import { ruleHandlers } from "../../events/rules.ts";
import type { Modal, Prop, PropSwitch, WorldRoom } from "../world.ts";

/**
 * The game-logic engine in TypeScript, mirroring the runtime line for line:
 * game/scripts/events.gd (handler matching and scoping, conditions judged when
 * the event is handled, before any of its handlers run, the run's effects),
 * the parts of world_runtime.gd the effects reach (respawn, entering rooms,
 * saving and loading a run), props.gd (presence, hits, destroyed) and
 * modal.gd (the queue, buttons, endGame). The checker drives it; the mirror
 * test (game/test/logic.test.ts) runs the same scripts in the real runtime.
 *
 * What it leaves to its driver: where the player is (`feet`, and the room
 * entered with `lastEnter`), whether damage kills (`damaged`), putting the
 * player back on safe ground (`toSafe`) and time (timers fire when told).
 */

export interface Point {
  x: number;
  y: number;
}
export interface Checkpoint extends Point {
  room: string;
}
export interface LogicEvent {
  type: string;
  room?: string;
  spawn?: string;
  character?: string;
  prop?: string;
  timer?: string;
}
/** What world_runtime.save_run stores (map reveals aside). */
export interface RunSnapshot {
  room: string;
  entry: Point;
  abilities: string[];
  visited: string[];
  flags: string[];
  items: Record<string, number>;
  checkpoint: Checkpoint | null;
}

export interface LogicGame {
  rooms: Map<string, WorldRoom>;
  /** The rules' preset handlers, then the world's (as toRuntimeProject sends them). */
  handlers: Handler[];
  start: Checkpoint | null;
  /** Where this run began (respawn at start without a world start). */
  origin: { room: string; at: Point };
  enemies: Set<string>;
  modals: Map<string, Modal>;
  /** grantAbility of these does nothing (gate checks). */
  without: Set<string>;
}

export function logicGame(project: ProjectSpec, origin: { room: string; at: Point }, without: readonly string[] = []): LogicGame {
  const world = project.world;
  return {
    rooms: new Map(world.rooms.map((r) => [r.id, r])),
    handlers: [...ruleHandlers(world.rules), ...world.handlers],
    start: world.start,
    origin,
    enemies: new Set(project.characters.filter((c) => c.kind === "enemy").map((c) => c.id)),
    modals: new Map(world.modals.map((m) => [m.id, m])),
    without: new Set(without),
  };
}

/** Everything the run holds (memory, the current visit, pending screens and timers). */
export interface RunState {
  room: string;
  entry: Point;
  settled: boolean;
  flags: Set<string>;
  items: Map<string, number>;
  abilities: string[];
  checkpoint: Checkpoint | null;
  visited: string[];
  timers: Set<string>;
  /** Queued modals; the first is open. `end`: the run ends when it closes. */
  modals: { id: string; end: boolean }[];
  /** Spawns alive this visit (built while their `when` held, not killed since). */
  alive: Set<string>;
  hits: Map<string, number>;
  destroyed: Set<string>;
}

const MAX_EVENTS_PER_FLUSH = 200;
type Context = { prop?: Prop };

export class LogicRun implements RunState {
  room = "";
  entry: Point = { x: 0, y: 0 };
  settled = false;
  flags = new Set<string>();
  items = new Map<string, number>();
  abilities: string[] = [];
  checkpoint: Checkpoint | null = null;
  visited: string[] = [];
  timers = new Set<string>();
  modals: { id: string; end: boolean }[] = [];
  alive = new Set<string>();
  hits = new Map<string, number>();
  destroyed = new Set<string>();

  /** Where the player's feet are now (setCheckpoint without a place). */
  feet: Point = { x: 0, y: 0 };
  /** Outcomes of the operations since `clearOutcomes`. */
  ended = false;
  damaged = false;
  toSafe = false;
  saved: RunSnapshot | null = null;
  /** The last room build: where, and through which door (null: placed at a point). */
  lastEnter: { room: string; at: Point; door: string | null } | null = null;

  private queue: LogicEvent[] = [];
  private dying = new Set<string>();

  readonly game: LogicGame;

  constructor(game: LogicGame, state?: RunState) {
    this.game = game;
    if (state) {
      Object.assign(this, {
        room: state.room,
        settled: state.settled,
        entry: { ...state.entry },
        flags: new Set(state.flags),
        items: new Map(state.items),
        abilities: [...state.abilities],
        checkpoint: state.checkpoint && { ...state.checkpoint },
        visited: [...state.visited],
        timers: new Set(state.timers),
        modals: state.modals.map((m) => ({ ...m })),
        alive: new Set(state.alive),
        hits: new Map(state.hits),
        destroyed: new Set(state.destroyed),
      });
    }
  }

  clone(): LogicRun {
    const run = new LogicRun(this.game, this);
    Object.assign(run, { feet: { ...this.feet }, ended: this.ended, damaged: this.damaged, toSafe: this.toSafe, saved: this.saved, lastEnter: this.lastEnter });
    return run;
  }

  clearOutcomes(): void {
    this.ended = this.damaged = this.toSafe = false;
    this.saved = null;
    this.lastEnter = null;
  }

  /** world_runtime.start: a fresh run (or one resumed from `saved`): gameStarted, then entering the room. */
  static start(game: LogicGame, abilities: readonly string[], saved?: RunSnapshot): LogicRun {
    const run = new LogicRun(game);
    run.abilities = [...abilities];
    let from = game.origin;
    if (saved) {
      run.abilities = [...saved.abilities];
      run.visited = [...saved.visited];
      for (const f of saved.flags) run.flags.add(f);
      for (const [item, n] of Object.entries(saved.items)) run.items.set(item, n);
      run.checkpoint = saved.checkpoint && { ...saved.checkpoint };
      from = { room: saved.room, at: saved.entry };
    }
    run.room = from.room;
    run.fire({ type: "gameStarted" });
    run.enter(from.room, from.at, null);
    run.flush();
    return run;
  }

  // --- conditions -----------------------------------------------------------------

  holds = (c: GameCondition | PropSwitch): boolean => {
    if (typeof c === "boolean") return c;
    switch (c.type) {
      case "flag":
        return this.flags.has(c.flag) === (c.is ?? true);
      case "item":
        return (this.items.get(c.item) ?? 0) >= (c.atLeast ?? 1);
      case "ability":
        return this.abilities.includes(c.ability);
      case "visited":
        return this.visited.includes(c.room);
      case "all":
        return c.of.every(this.holds);
      case "any":
        return c.of.some(this.holds);
      case "not":
        return !this.holds(c.of);
    }
  };

  currentRoom(): WorldRoom | undefined {
    return this.game.rooms.get(this.room);
  }

  /** props.gd is_present: visible and not destroyed this visit. */
  present(prop: Prop): boolean {
    return !this.destroyed.has(prop.id) && this.holds(prop.visible ?? true);
  }

  solid(prop: Prop): boolean {
    return this.present(prop) && this.holds(prop.solid ?? false);
  }

  // --- events (events.gd) ---------------------------------------------------------------

  fire(event: LogicEvent): void {
    this.queue.push(event.room === undefined ? { ...event, room: this.room } : event);
  }

  flush(): void {
    let handled = 0;
    while (this.queue.length && handled < MAX_EVENTS_PER_FLUSH) {
      const event = this.queue.shift()!;
      handled++;
      const ready = this.handlersFor(event).filter((found) => (found.handler.when ?? []).every(this.holds));
      for (const found of ready) this.run(found.handler.do, found.context);
    }
    if (handled >= MAX_EVENTS_PER_FLUSH) this.queue = [];
  }

  private handlersFor(event: LogicEvent): { handler: Handler; context: Context }[] {
    const out: { handler: Handler; context: Context }[] = [];
    for (const handler of this.game.handlers) if (matches(handler.on, event, {})) out.push({ handler, context: {} });
    const room = this.currentRoom();
    if (!room || (event.room ?? this.room) !== this.room) return out;
    for (const handler of room.handlers) if (matches(handler.on, event, { room: room.id })) out.push({ handler, context: {} });
    for (const prop of room.props) {
      if (!this.present(prop)) continue;
      for (const handler of prop.handlers) if (matches(handler.on, event, { room: room.id, prop: prop.id })) out.push({ handler, context: { prop } });
    }
    for (const spawn of room.spawns) for (const handler of spawn.handlers) if (matches(handler.on, event, { room: room.id, spawn: spawn.id })) out.push({ handler, context: {} });
    return out;
  }

  /** events.gd run_effects (with modal.gd's effects; feedback effects change nothing here). */
  run(effects: readonly Effect[], context: Context = {}): void {
    for (const e of effects) {
      switch (e.type) {
        case "setFlag":
          if (e.value ?? true) this.flags.add(e.flag);
          else this.flags.delete(e.flag);
          break;
        case "giveItem":
          this.items.set(e.item, (this.items.get(e.item) ?? 0) + (e.count ?? 1));
          break;
        case "takeItem": {
          const left = (this.items.get(e.item) ?? 0) - (e.count ?? 1);
          if (left > 0) this.items.set(e.item, left);
          else this.items.delete(e.item);
          break;
        }
        case "grantAbility":
          if (!this.game.without.has(e.ability) && !this.abilities.includes(e.ability)) this.abilities.push(e.ability);
          break;
        case "damage":
          if (e.amount > 0) this.damaged = true;
          break;
        case "respawn":
          this.respawn(e.at ?? "entry");
          break;
        case "returnToSafeGround":
          this.toSafe = true;
          break;
        case "setCheckpoint":
          if (e.room !== undefined) this.checkpoint = { room: e.room, x: e.x!, y: e.y! };
          else this.checkpoint = { room: this.room, x: context.prop ? context.prop.x + context.prop.width / 2 : this.feet.x, y: this.feet.y };
          break;
        case "saveRun":
          this.saved = this.snapshot();
          break;
        case "startTimer":
          this.timers.add(e.timer);
          break;
        case "showModal":
          if (this.game.modals.has(e.modal)) this.modals.push({ id: e.modal, end: false });
          break;
        case "endGame":
          if (e.modal === undefined) this.ended = true;
          else if (this.game.modals.has(e.modal)) this.modals.push({ id: e.modal, end: true });
          break;
        default:
          break; // heal, revealMap and feedback: nothing the logic reads
      }
    }
  }

  // --- the run (world_runtime.gd) -------------------------------------------------------

  /** _enter: build a room (its spawns by their `when` now, its props intact) with the player at `at`; roomEntered. */
  enter(room: string, at: Point, door: string | null): void {
    this.room = room;
    this.entry = { ...at };
    this.feet = { ...at };
    this.settled = false;
    if (!this.visited.includes(room)) this.visited.push(room);
    const data = this.currentRoom()!;
    this.alive = new Set(data.spawns.filter((s) => this.game.enemies.has(s.characterId) && (s.when == null || this.holds(s.when))).map((s) => s.id));
    this.hits = new Map();
    this.destroyed = new Set();
    this.dying = new Set();
    this.lastEnter = { room, at: { ...at }, door };
    this.fire({ type: "roomEntered" });
  }

  respawn(at: "entry" | "start" | "checkpoint"): void {
    let target = { room: this.room, at: this.entry };
    const cp = this.checkpoint;
    if (at === "checkpoint" && cp && this.game.rooms.has(cp.room)) target = { room: cp.room, at: { x: cp.x, y: cp.y } };
    else if (at === "start" || at === "checkpoint") {
      const start = this.game.start;
      target = start && this.game.rooms.has(start.room) ? { room: start.room, at: { x: start.x, y: start.y } } : this.game.origin;
    }
    this.enter(target.room, target.at, null);
  }

  snapshot(): RunSnapshot {
    return {
      room: this.room,
      entry: { ...this.entry },
      abilities: [...this.abilities],
      visited: [...this.visited],
      flags: [...this.flags].sort(),
      items: Object.fromEntries([...this.items].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      checkpoint: this.checkpoint && { ...this.checkpoint },
    };
  }

  // --- what the player does (each handled like the runtime's frame: fire, then flush) ---

  /** Through a door into `room`, arriving at `at`. */
  goThrough(room: string, at: Point, door: string): void {
    this.enter(room, at, door);
    this.flush();
  }

  /** First safe ground in the room: entry moves there; roomSettled. */
  settle(at: Point): void {
    this.settled = true;
    this.entry = { ...at };
    this.fire({ type: "roomSettled" });
    this.flush();
  }

  touch(prop: string): void {
    this.fire({ type: "touch", prop });
    this.flush();
  }

  interact(prop: string): void {
    this.fire({ type: "interact", prop });
    this.flush();
  }

  /** props.gd strike: hit, and destroyed once its health runs out (gone after the frame's events). */
  hit(id: string): void {
    const prop = this.currentRoom()?.props.find((p) => p.id === id);
    if (!prop || !this.present(prop) || this.dying.has(id)) return;
    this.fire({ type: "hit", prop: id });
    if (prop.health != null) {
      const hits = (this.hits.get(id) ?? 0) + 1;
      this.hits.set(id, hits);
      if (hits >= prop.health) {
        this.dying.add(id);
        this.fire({ type: "destroyed", prop: id });
      }
    }
    this.flush();
    for (const gone of this.dying) this.destroyed.add(gone);
    this.dying.clear();
  }

  /** on_enemy_killed: enemyKilled, and roomCleared when it was the last one alive. */
  kill(spawn: string): void {
    const data = this.currentRoom()?.spawns.find((s) => s.id === spawn);
    if (!data || !this.alive.has(spawn)) return;
    this.alive.delete(spawn);
    this.fire({ type: "enemyKilled", spawn, character: data.characterId });
    if (this.alive.size === 0) this.fire({ type: "roomCleared" });
    this.flush();
  }

  die(): void {
    this.fire({ type: "playerDied" });
    this.flush();
  }

  touchHazard(): void {
    this.fire({ type: "hazardTouched" });
    this.flush();
  }

  timer(id: string): void {
    if (!this.timers.delete(id)) return;
    this.fire({ type: "timer", timer: id });
    this.flush();
  }

  /** modal.gd _press: the open modal's button `i` runs its effects; it closes (ending the run if it was the end). */
  press(i: number): void {
    const open = this.modals.shift();
    if (!open) return;
    const buttons = this.game.modals.get(open.id)?.buttons ?? [];
    this.run(i < buttons.length ? buttons[i]!.do : []);
    if (open.end) {
      this.ended = true;
      return;
    }
    this.flush();
  }
}

/** events.gd _matches: `on` matches `event`; `scope` pins fields for scoped handlers. Prop events only reach their prop. */
export function matches(on: Handler["on"], event: LogicEvent, scope: { room?: string; spawn?: string; prop?: string }): boolean {
  if (on.type !== event.type) return false;
  if (event.prop !== undefined && scope.prop !== event.prop) return false;
  for (const key of ["room", "spawn", "character", "timer"] as const) {
    const pinned = (on as Record<string, unknown>)[key];
    const wanted = pinned !== undefined ? pinned : (scope as Record<string, unknown>)[key];
    if (wanted == null) continue;
    if (event[key] !== undefined && event[key] !== wanted) return false;
    if (event[key] === undefined && key !== "room") return false;
  }
  return true;
}

/** Does a prop answer an event (props.gd _answers)? */
export const answers = (prop: Prop, type: string) => prop.handlers.some((h) => h.on.type === type);
