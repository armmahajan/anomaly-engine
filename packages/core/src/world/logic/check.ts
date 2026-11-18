import type { EnemyCharacter, PlayerCharacter, ProjectSpec } from "../../schema.ts";
import { MOVEMENT_ABILITIES, movementParams, type MovementAbility, type MovementParams } from "../../movement/params.ts";
import { deriveMovement, initialState, stepMovement, type MoveState, type Solid } from "../../movement/simulate.ts";
import { flattenConditions, type Effect, type GameCondition } from "../../events/events.ts";
import { ruleHandlers } from "../../events/rules.ts";
import { gridSize } from "../tiles.ts";
import { DOOR_UP_CARRY, type Prop, type PropSwitch, type WorldRoom } from "../world.ts";
import { doorEntry, moveTrace, reachableFrom, roomGraph, type RoomGraph, type TraversalMove } from "../traversal.ts";
import { answers, LogicRun, logicGame, weaponFlag, type Checkpoint, type LogicGame, type Point, type RunSnapshot } from "./interpret.ts";
import { attackBounds, triggerAims, type HitBox } from "../../combat/weaponModel.ts";
import type { Weapon } from "../../combat/weapon.ts";

export { LogicRun, logicGame, matches, type LogicEvent, type LogicGame, type RunSnapshot, type RunState } from "./interpret.ts";

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
 *
 * The model, where it differs from the runtime (README "Checking a game"):
 * - Logic runs through interpret.ts, the runtime's engine mirrored in TS.
 * - Positions are traversal nodes; a surface means "anywhere on it". Entering
 *   through a door uses the traversal's door entry (not the exact spot along
 *   the opening). A room is settled on the first landing after entering.
 * - Touch: forced when a move's simulated path overlaps the prop; optional
 *   (the player may or may not) when standing on a surface or jumping in
 *   place from it overlaps it. Interact: standing or jumping in place.
 *   Hit: the sword's reach from a surface, standing or jumping in place
 *   (not along moves): the built-in attack's, and every attack of the weapons
 *   the player has (their whole reach, standing for ground attacks and
 *   jumping in place for air ones, down strikes included: where the pogo is).
 *   Events during a move don't change where it ends.
 * - Solid props are collision; when they change under the player, the player
 *   stays on the piece of the surface where the event happened (or, for
 *   events with no place, any piece). Props solidifying around the player
 *   (a door entry, a respawn) are left out of that point's moves.
 * - Every enemy alive in the room can be killed, in any order. Death is
 *   possible near a living enemy that can hurt and after any damage effect (a
 *   hazard touched beside a surface, say); health is not tracked.
 * - Timers may fire at any later point (outside modals); `seconds` is ignored.
 * - endGame (with or without a modal) is the ending. Saves: the last saveRun of
 *   a step; each distinct one is a Continue start that must also reach an ending.
 * - Only what conditions read is kept: flags they check, item counts up to the
 *   largest they check (plus the largest single take), rooms in visited, and
 *   the weapons the player has (a reserved flag each, interpret.ts weaponFlag).
 * - Weapons: any weapon the player has can be used (loadout slots are not
 *   tracked); the built-in attack counts while the attack slot starts empty.
 *   A projectile's reach is its whole flight, solids aside.
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
  /** How to get there from the start (through a save and Continue, when `fromSave`). */
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
  /** Rooms some reachable state stands in (for gate checks: is a region reachable at all). */
  reachableRooms: string[];
  stats: { states: number; ms: number; truncated: boolean };
}

export interface CheckOptions {
  /** Abilities the player starts with (default: the world start has none; the playtest's when checking from it). */
  abilities?: MovementAbility[];
  /** Stop after this many states (the result says `truncated`). */
  maxStates?: number;
  /** Abilities the player never gets (grantAbility of them does nothing): for gate checks. */
  withoutAbilities?: MovementAbility[];
}

const MAX_DEAD_REPORTS = 20;
const ATTACKS = new Set(["strike", "shoot", "slam", "summon", "useWeapon"]);
const WEAPON_PREFIX = weaponFlag("");
const ALL_ABILITIES = Object.keys(MOVEMENT_ABILITIES) as MovementAbility[];

/** A logical state. x, y: where on the node the player is (representative; not part of its identity). */
interface State {
  room: string;
  node: string;
  x: number;
  y: number;
  flags: string[];
  items: [string, number][];
  abilities: string[];
  checkpoint: Checkpoint | null;
  visited: string[];
  alive: string[];
  hits: [string, number][];
  destroyed: string[];
  entry: Point;
  settled: boolean;
  modals: { id: string; end: boolean }[];
  timers: string[];
}

/** Where a step leaves the player: a node of `graph` (null: an entry or point node, the same in every graph). */
interface Pos {
  room: string;
  node: string;
  x: number;
  y: number;
  graph: RoomGraph | null;
  /** The event happened here (the player stays on this piece of a surface that changes). */
  positional: boolean;
}

interface Edge {
  action: string;
  to: State | null;
  saved: RunSnapshot | null;
}

type Rect = [x0: number, y0: number, x1: number, y1: number];
const overlaps = (a: Rect, b: Rect) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const overlapsStrict = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const propRect = (p: Prop): Rect => [p.x, p.y, p.x + p.width, p.y + p.height];
const round = (v: number) => Math.round(v);
const pointNode = (p: Point) => `p:${round(p.x)},${round(p.y)}`;
const isSurface = (node: string) => node.startsWith("s");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const propName = (p: Prop) => p.name ?? p.id;

export function checkGame(project: ProjectSpec, options: CheckOptions = {}): CheckResult {
  const t0 = performance.now();
  const world = project.world;
  const player = project.characters.find((c): c is PlayerCharacter => c.kind === "player");
  const begin = world.start ?? world.playtest;
  const effects = allEffects(project);
  const hasEnding = effects.some((e) => e.type === "endGame");
  if (!player || !begin) {
    return { hasEnding, beatable: false, route: null, deadStates: [{ path: [], why: player ? "the game has no start" : "the game has no player character", fromSave: false }], reachableRooms: [], stats: { states: 0, ms: performance.now() - t0, truncated: false } };
  }
  const without = options.withoutAbilities ?? [];
  const startAbilities = (options.abilities ?? (world.start ? [] : (world.playtest?.abilities ?? []))).filter((a) => !without.includes(a));
  const game = logicGame(project, { room: begin.room, at: { x: begin.x, y: begin.y } }, without);
  const params = movementParams(player, world.gravity);
  const model = new WorldModel(project, game, params, player);
  const search = new Search(model, options.maxStates ?? 100_000);

  const first = LogicRun.start(game, startAbilities);
  search.root(model.fromRun(first, model.startPos(first)), -1, "start", false);
  if (first.saved) search.resume(first.saved, 0, null, startAbilities);
  search.run(startAbilities);
  const reachableRooms = [...new Set(search.states.map((s) => s.room))].sort(cmp);
  const route = search.route();
  const deadStates = hasEnding ? search.deadStates() : [{ path: [search.step(0)], why: "the game has no ending: nothing runs endGame", fromSave: false }];
  return {
    hasEnding,
    beatable: route !== null,
    route,
    deadStates,
    reachableRooms,
    stats: { states: search.states.length, ms: Math.round(performance.now() - t0), truncated: search.truncated },
  };
}

// ------------------------------------------------------------------ what the game is made of

function allEffects(project: ProjectSpec): Effect[] {
  const w = project.world;
  const handlers = [...ruleHandlers(w.rules), ...w.handlers, ...w.rooms.flatMap((r) => [...r.handlers, ...r.props.flatMap((p) => p.handlers), ...r.spawns.flatMap((s) => s.handlers)])];
  return [...handlers.flatMap((h) => h.do), ...w.modals.flatMap((m) => m.buttons.flatMap((b) => b.do))];
}

/** Every condition in the game, with what it belongs to (for explanations). */
function allConditions(project: ProjectSpec): { c: GameCondition; ref: string; room: string | null; solid?: Prop }[] {
  const out: { c: GameCondition; ref: string; room: string | null; solid?: Prop }[] = [];
  const add = (list: GameCondition[], ref: string, room: string | null, solid?: Prop) => {
    for (const c of flattenConditions(list)) out.push({ c, ref, room, solid });
  };
  for (const room of project.world.rooms) {
    for (const p of room.props) {
      if (typeof p.solid !== "boolean") add([p.solid], propName(p), room.id, p);
      if (typeof p.visible !== "boolean") add([p.visible], propName(p), room.id);
      for (const h of p.handlers) add(h.when, propName(p), room.id);
    }
    for (const s of room.spawns) {
      if (s.when) add([s.when], `the enemy ${s.id}`, room.id);
      for (const h of s.handlers) add(h.when, `the enemy ${s.id}`, room.id);
    }
    for (const h of room.handlers) add(h.when, `a handler in ${room.id}`, room.id);
  }
  for (const h of project.world.handlers) add(h.when, "a game handler", null);
  return out;
}

function describe(c: GameCondition | PropSwitch): string {
  if (typeof c === "boolean") return c ? "always" : "never";
  switch (c.type) {
    case "flag":
      return c.is === false ? `flag ${c.flag} is unset` : `flag ${c.flag}`;
    case "item":
      return `${(c.atLeast ?? 1) > 1 ? `${c.atLeast} of ` : ""}item ${c.item}`;
    case "ability":
      return `ability ${c.ability}`;
    case "weapon":
      return `weapon ${c.weapon}`;
    case "visited":
      return `visited ${c.room}`;
    case "all":
      return c.of.map(describe).join(" and ");
    case "any":
      return c.of.map(describe).join(" or ");
    case "not":
      return `not (${describe(c.of)})`;
  }
}

/** The world as the checker sees it: room graphs per (abilities, solid props), and what is where. */
class WorldModel {
  readonly hw: number;
  readonly lift: number;
  readonly conditions: ReturnType<typeof allConditions>;
  readonly flags = new Set<string>();
  readonly itemCaps = new Map<string, number>();
  readonly itemSteps = new Map<string, number[]>();
  readonly visited = new Set<string>();
  readonly keepEntry: boolean;
  readonly dangerous = new Set<string>();
  readonly flagsSet = new Set<string>();
  readonly itemsGiven = new Set<string>();
  readonly weaponsGiven = new Set<string>();
  /** The project's weapons, and whether the built-in attack is in play (the attack slot starts empty, or there is none). */
  readonly weapons = new Map<string, Weapon>();
  readonly builtIn: boolean;
  private strikeBoxes = new Map<string, { ground: HitBox[]; air: HitBox[] }>();
  private hits = new WeakMap<RoomGraph, Map<string, Rect[]>>();
  private graphs = new Map<string, RoomGraph>();
  private traces = new WeakMap<TraversalMove, { states: MoveState[]; touches: [string, number][] }>();
  private walkOffs = new WeakMap<RoomGraph, Map<string, TraversalMove[]>>();
  private reaches = new WeakMap<RoomGraph, Map<string, { touch: Rect[]; tops: [number, number][]; hazard: boolean }>>();

  readonly project: ProjectSpec;
  readonly game: LogicGame;
  readonly params: MovementParams;
  readonly player: PlayerCharacter;

  constructor(project: ProjectSpec, game: LogicGame, params: MovementParams, player: PlayerCharacter) {
    this.project = project;
    this.game = game;
    this.params = params;
    this.player = player;
    this.hw = params.width / 2;
    this.lift = Math.sqrt(2 * params.gravity * DOOR_UP_CARRY);
    this.conditions = allConditions(project);
    const takes = new Map<string, number>();
    const effects = allEffects(project);
    for (const e of effects) {
      if (e.type === "takeItem") takes.set(e.item, Math.max(takes.get(e.item) ?? 0, e.count ?? 1));
      if (e.type === "setFlag" && (e.value ?? true)) this.flagsSet.add(e.flag);
      if (e.type === "giveItem") this.itemsGiven.add(e.item);
      if (e.type === "giveWeapon") this.weaponsGiven.add(e.weapon);
    }
    // Weapons the player has are kept in the state: conditions read them, and they change what can be struck.
    for (const w of project.weapons.list) {
      this.weapons.set(w.id, w);
      this.flags.add(weaponFlag(w.id));
    }
    for (const w of game.startWeapons) this.weaponsGiven.add(w);
    const attackSlot = project.weapons.loadout.slots.find((s) => s.action === "attack");
    this.builtIn = !attackSlot || attackSlot.start === null;
    for (const { c } of this.conditions) {
      if (c.type === "flag") this.flags.add(c.flag);
      // Weapons the player has are reserved flags (interpret.ts weaponFlag): keep them in the state when a condition reads them.
      if (c.type === "weapon") this.flags.add(weaponFlag(c.weapon));
      if (c.type === "visited") this.visited.add(c.room);
      if (c.type === "item") {
        const n = c.atLeast ?? 1;
        this.itemCaps.set(c.item, Math.max(this.itemCaps.get(c.item) ?? 0, n));
        this.itemSteps.set(c.item, [...new Set([...(this.itemSteps.get(c.item) ?? []), n])].sort((a, b) => a - b));
      }
    }
    for (const [item, cap] of this.itemCaps) this.itemCaps.set(item, cap + (takes.get(item) ?? 0));
    this.keepEntry = effects.some((e) => e.type === "saveRun" || (e.type === "respawn" && (e.at ?? "entry") === "entry"));
    for (const c of project.characters) {
      if (c.kind !== "enemy") continue;
      const e = c as EnemyCharacter;
      if (e.stats.contactDamage > 0 || Object.values(e.behavior.states).some((s) => ATTACKS.has(s.action.type))) this.dangerous.add(c.id);
    }
  }

  room(id: string): WorldRoom {
    return this.game.rooms.get(id)!;
  }

  // --- states and runs ---------------------------------------------------------------------

  fromRun(run: LogicRun, pos: Pos): State {
    const caps = this.itemCaps;
    return {
      room: run.room,
      node: pos.node,
      x: pos.x,
      y: pos.y,
      flags: [...run.flags].filter((f) => this.flags.has(f)).sort(cmp),
      items: [...run.items].filter(([i]) => caps.has(i)).map(([i, n]): [string, number] => [i, Math.min(n, caps.get(i)!)]).sort((a, b) => cmp(a[0], b[0])),
      abilities: [...run.abilities].sort(cmp),
      checkpoint: run.checkpoint && { room: run.checkpoint.room, x: round(run.checkpoint.x), y: round(run.checkpoint.y) },
      visited: run.visited.filter((r) => this.visited.has(r)).sort(cmp),
      alive: [...run.alive].sort(cmp),
      hits: [...run.hits].sort((a, b) => cmp(a[0], b[0])),
      destroyed: [...run.destroyed].sort(cmp),
      entry: this.keepEntry ? { x: round(run.entry.x), y: round(run.entry.y) } : { x: 0, y: 0 },
      settled: run.settled,
      modals: run.modals.map((m) => ({ ...m })),
      timers: [...run.timers].sort(cmp),
    };
  }

  toRun(s: State): LogicRun {
    const run = new LogicRun(this.game, {
      room: s.room,
      entry: s.entry,
      settled: s.settled,
      flags: new Set(s.flags),
      items: new Map(s.items),
      abilities: s.abilities,
      checkpoint: s.checkpoint,
      visited: s.visited,
      timers: new Set(s.timers),
      modals: s.modals,
      alive: new Set(s.alive),
      hits: new Map(s.hits),
      destroyed: new Set(s.destroyed),
    });
    run.feet = { x: s.x, y: s.y };
    return run;
  }

  /** A saved run with only what conditions read (so saves that differ in nothing that matters are one). */
  canonical(saved: RunSnapshot): RunSnapshot {
    const caps = this.itemCaps;
    return {
      room: saved.room,
      entry: { x: round(saved.entry.x), y: round(saved.entry.y) },
      abilities: [...saved.abilities].sort(cmp),
      visited: saved.visited.filter((r) => this.visited.has(r)).sort(cmp),
      flags: saved.flags.filter((f) => this.flags.has(f)).sort(cmp),
      items: Object.fromEntries(Object.entries(saved.items).filter(([i]) => caps.has(i)).map(([i, n]): [string, number] => [i, Math.min(n, caps.get(i)!)]).sort((a, b) => cmp(a[0], b[0]))),
      checkpoint: saved.checkpoint && { room: saved.checkpoint.room, x: round(saved.checkpoint.x), y: round(saved.checkpoint.y) },
    };
  }

  /** Where a fresh run or a Continue puts the player. */
  startPos(run: LogicRun): Pos {
    const at = run.lastEnter!.at;
    return { room: run.room, node: pointNode(at), x: round(at.x), y: round(at.y), graph: null, positional: true };
  }

  // --- graphs ------------------------------------------------------------------------------

  graph(room: string, abilities: readonly string[], solids: readonly Prop[]): RoomGraph {
    const key = `${room}|${abilities.join(",")}|${solids.map((p) => p.id).join(",")}`;
    let g = this.graphs.get(key);
    if (!g) {
      const r = this.room(room);
      const extraSolids: Solid[] = solids.map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height, kind: "solid" }));
      g = roomGraph(r.grid, r.doors, this.params, abilities.filter((a): a is MovementAbility => a in MOVEMENT_ABILITIES), { ledgeThickness: this.project.world.ledgeThickness, extraSolids });
      this.graphs.set(key, g);
    }
    return g;
  }

  solidProps(s: State, run = this.toRun(s)): Prop[] {
    return this.room(s.room).props.filter((p) => run.solid(p));
  }

  graphOf(s: State, run?: LogicRun): RoomGraph {
    return this.graph(s.room, s.abilities, this.solidProps(s, run));
  }

  /** Moves out of a node (point nodes are added on first use). */
  moves(g: RoomGraph, node: string): TraversalMove[] {
    if (node.startsWith("p:") && !g.entry(node)) {
      const [x, y] = node.slice(2).split(",").map(Number);
      g.addStart(node, x!, y!);
    }
    if (!isSurface(node)) return g.moves(node);
    let cache = this.walkOffs.get(g);
    if (!cache) this.walkOffs.set(g, (cache = new Map()));
    let moves = cache.get(node);
    if (!moves) cache.set(node, (moves = [...g.moves(node), ...this.walkOff(g, node, g.moves(node))]));
    return moves;
  }

  /**
   * Walking off an open end and falling onto what is below. The traversal
   * steers drops toward a target, which stands still over a surface that
   * runs on under this one (a ledge above a floor), so it misses these.
   */
  private walkOff(g: RoomGraph, node: string, known: TraversalMove[]): TraversalMove[] {
    const sf = g.surface(node)!;
    const mask = node.split("@")[1] ?? "";
    const w = (this.params.runSpeed / 60) * 1.001;
    const out: TraversalMove[] = [];
    for (const dir of [1, -1] as const) {
      if (!sf.open[dir > 0 ? 1 : 0] || sf.x1 - sf.x0 < w) continue;
      const move: TraversalMove = { from: node, to: "", kind: "drop", window: dir > 0 ? [sf.x1 - w, sf.x1] : [sf.x0, sf.x0 + w], plan: { dir } };
      const end = moveTrace(g, move).at(-1)!;
      for (let i = 0; ; i++) {
        const key = mask ? `s${i}@${mask}` : `s${i}`;
        const t = g.surface(key);
        if (!t) break;
        if (Math.abs(t.y - end.y) < 1e-6 && end.x >= t.x0 - 1e-6 && end.x <= t.x1 + 1e-6 && end.onFloor) {
          if (key !== node && !known.some((k) => k.to === key) && !out.some((k) => k.to === key)) out.push({ ...move, to: key });
          break;
        }
      }
    }
    return out;
  }

  /** The start point of an entry or point node. */
  startPoint(g: RoomGraph, node: string): Point {
    if (node.startsWith("p:")) {
      const [x, y] = node.slice(2).split(",").map(Number);
      return { x: x!, y: y! };
    }
    const e = g.entry(node)!;
    return { x: e.x, y: e.y };
  }

  /** An entry's graph: props that would solidify around the player there wait (props.gd), so they are left out. */
  waitingGraph(s: State, g: RoomGraph, run: LogicRun): RoomGraph {
    const at = this.startPoint(g, s.node);
    const box: Rect = [at.x - this.hw, at.y - this.params.height, at.x + this.hw, at.y];
    const solids = this.solidProps(s, run);
    const kept = solids.filter((p) => !overlapsStrict(box, propRect(p)));
    return kept.length === solids.length ? g : this.graph(s.room, s.abilities, kept);
  }

  /** The node(s) of `to` where a player at `pos` (a node of another graph of the room) is. */
  remap(pos: Pos, to: RoomGraph): string[] {
    if (!pos.graph || pos.graph === to || !isSurface(pos.node)) return [pos.node];
    const old = pos.graph.surface(pos.node)!;
    const mask = pos.node.split("@")[1] ?? "";
    const pieces: { key: string; x0: number; x1: number }[] = [];
    for (let i = 0; ; i++) {
      const key = mask ? `s${i}@${mask}` : `s${i}`;
      const t = to.surface(key);
      if (!t) break;
      if (Math.abs(t.y - old.y) < 1e-6 && t.x1 >= old.x0 - 1e-6 && t.x0 <= old.x1 + 1e-6) pieces.push({ key, x0: t.x0, x1: t.x1 });
    }
    if (!pieces.length) return [pointNode(pos)];
    if (!pos.positional) return pieces.map((p) => p.key);
    const on = pieces.find((p) => pos.x >= p.x0 - 1e-6 && pos.x <= p.x1 + 1e-6);
    if (on) return [on.key];
    const left = pieces.filter((p) => p.x1 < pos.x).sort((a, b) => b.x1 - a.x1)[0];
    const right = pieces.filter((p) => p.x0 > pos.x).sort((a, b) => a.x0 - b.x0)[0];
    return [left, right].filter((p) => p !== undefined).map((p) => p.key);
  }

  // --- what the player passes through and can reach ----------------------------------------------

  trace(g: RoomGraph, room: WorldRoom, m: TraversalMove) {
    let t = this.traces.get(m);
    if (!t) {
      const states = moveTrace(g, m);
      const touches: [string, number][] = [];
      for (const p of room.props) {
        if (!answers(p, "touch")) continue;
        const r = propRect(p);
        const f = states.findIndex((s) => overlaps([s.x - this.hw, s.y - this.params.height, s.x + this.hw, s.y], r));
        if (f >= 0) touches.push([p.id, f]);
      }
      touches.sort((a, b) => a[1] - b[1]);
      t = { states, touches };
      this.traces.set(m, t);
    }
    return t;
  }

  /** What a player on a surface can touch (standing or jumping in place) and strike with `weapons` (ids it has), and whether a hazard is within reach. */
  reach(g: RoomGraph, node: string, room: WorldRoom, weapons: readonly string[] = []): { touch: Rect[]; hit: Rect[]; hazard: boolean } {
    const base = this.reachBase(g, node, room);
    let cache = this.hits.get(g);
    if (!cache) this.hits.set(g, (cache = new Map()));
    const key = `${node}|${weapons.join(",")}`;
    let hit = cache.get(key);
    if (!hit) cache.set(key, (hit = this.strikes(g, node, base.tops, weapons)));
    return { touch: base.touch, hit, hazard: base.hazard };
  }

  /** Touches, the top of a jump in place from points along the surface, and hazards near it. */
  private reachBase(g: RoomGraph, node: string, room: WorldRoom): { touch: Rect[]; tops: [number, number][]; hazard: boolean } {
    let cache = this.reaches.get(g);
    if (!cache) this.reaches.set(g, (cache = new Map()));
    let r = cache.get(node);
    if (r) return r;
    const sf = g.surface(node)!;
    const { hw } = this;
    const h = this.params.height;
    const solids = g.solids(node.split("@")[1] ?? "");
    const touch: Rect[] = [[sf.x0 - hw, sf.y - h, sf.x1 + hw, sf.y]];
    const tops: [number, number][] = [];
    if (room.props.some((p) => answers(p, "touch") || answers(p, "interact") || answers(p, "hit") || p.health != null)) {
      const d = deriveMovement(this.params, g.abilities);
      const double = g.abilities.includes("double_jump");
      const xs: number[] = [];
      for (let x = sf.x0; x < sf.x1; x += Math.max(4, hw)) xs.push(x);
      xs.push(sf.x1);
      for (const x of xs) {
        let s = initialState(x, sf.y);
        for (let k = 0; k < 2; k++) s = stepMovement(s, {}, this.params, d, solids);
        let top = s.y;
        let prev = false;
        let phase = 0;
        for (let f = 0; f < 240; f++) {
          let held = false;
          if (phase === 0) held = f === 0 || s.vy < 0 ? true : ((phase = double ? 1 : 2), false);
          else if (phase === 1) (held = !prev), (phase = held ? 3 : 1);
          else if (phase === 3) held = s.vy < 0 || !prev ? true : ((phase = 2), false);
          s = stepMovement(s, { jump: held, jumpPressed: held && !prev, jumpReleased: !held && prev }, this.params, d, solids);
          prev = held;
          top = Math.min(top, s.y);
          if (f > 2 && s.onFloor) break;
        }
        touch.push([x - hw, top - h, x + hw, sf.y]);
        tops.push([x, top]);
      }
    }
    const zone: Rect = [sf.x0 - hw - 64, sf.y - h - 64, sf.x1 + hw + 64, sf.y + 96];
    const hazard = solids.some((z) => z.kind === "hazard" && overlaps(zone, [z.x, z.y, z.x + z.width, z.y + z.height]));
    r = { touch, tops, hazard };
    cache.set(node, r);
    return r;
  }

  /** What can be struck from a surface: the built-in attack (player.gd slash_rect) and the weapons' attacks, standing or jumping in place. */
  private strikes(g: RoomGraph, node: string, tops: readonly [number, number][], weapons: readonly string[]): Rect[] {
    const sf = g.surface(node)!;
    const { hw } = this;
    const h = this.params.height;
    const hit: Rect[] = [];
    if (this.builtIn) {
      const reachPx = this.player.stats.attackReach;
      const wide = this.params.width + 24;
      hit.push([sf.x0 + hw, sf.y - h, sf.x1 + hw + reachPx, sf.y], [sf.x0 - hw - reachPx, sf.y - h, sf.x1 - hw, sf.y], [sf.x0 - wide / 2, sf.y - h - reachPx, sf.x1 + wide / 2, sf.y - h]);
      for (const [x, top] of tops) hit.push([x - hw - reachPx, top - h, x + hw + reachPx, sf.y], [x - wide / 2, top - h - reachPx, x + wide / 2, sf.y + reachPx]);
    }
    const boxes = this.weaponBoxes(weapons);
    // Both ways it can face: x mirrored.
    const facings = (b: HitBox): HitBox[] => [b, [-b[2], b[1], -b[0], b[3]]];
    for (const b of boxes.ground.flatMap(facings)) hit.push([sf.x0 + b[0], sf.y - h / 2 + b[1], sf.x1 + b[2], sf.y - h / 2 + b[3]]);
    for (const b of boxes.air.flatMap(facings)) for (const [x, top] of tops) hit.push([x + b[0], top - h / 2 + b[1], x + b[2], sf.y - h / 2 + b[3]]);
    return hit;
  }

  /** The reach of every attack of these weapons (wielder space, facing right), standing and in the air. */
  private weaponBoxes(weapons: readonly string[]): { ground: HitBox[]; air: HitBox[] } {
    const key = weapons.join(",");
    let out = this.strikeBoxes.get(key);
    if (out) return out;
    out = { ground: [], air: [] };
    const body = { width: this.params.width, height: this.params.height };
    for (const id of weapons) {
      for (const attack of this.weapons.get(id)?.attacks ?? []) {
        for (const where of ["ground", "air"] as const) {
          for (const aim of triggerAims(attack, where)) {
            const b = attackBounds(attack, aim, body);
            if (b) out[where].push(b);
          }
        }
      }
    }
    this.strikeBoxes.set(key, out);
    return out;
  }

  /** The weapons a state's player has. */
  weaponsOf(s: State): string[] {
    return s.flags.filter((f) => f.startsWith(WEAPON_PREFIX)).map((f) => f.slice(WEAPON_PREFIX.length));
  }

  doorArrival(room: WorldRoom, doorId: string): { room: string; door: string; at: Point } | null {
    const door = room.doors.find((d) => d.id === doorId);
    const to = door?.to ? this.game.rooms.get(door.to.room) : undefined;
    const arrive = to?.doors.find((d) => d.id === door!.to!.door);
    if (!to || !arrive) return null;
    const { width, height } = gridSize(to.grid);
    const e = doorEntry(arrive, width, height, this.params, this.lift);
    return { room: to.id, door: arrive.id, at: { x: e.x, y: e.y } };
  }
}

// ------------------------------------------------------------------ the search

class Search {
  states: State[] = [];
  private index = new Map<string, number>();
  private parent: number[] = [];
  private via: string[] = [];
  /** Continue starts: the step that saved the run they resume (from, action). */
  private savedBy = new Map<number, [number, string]>();
  private fromSave: boolean[] = [];
  private edges: number[][] = [];
  private edgeActions: string[][] = [];
  private ends: (string | null)[] = [];
  private expanded: boolean[] = [];
  private snapshots = new Set<string>();
  private queue: number[] = [];
  truncated = false;
  private alive: boolean[] = [];
  private distToEnd: number[] = [];

  readonly model: WorldModel;
  readonly maxStates: number;

  constructor(model: WorldModel, maxStates: number) {
    this.model = model;
    this.maxStates = maxStates;
  }

  private key(s: State): string {
    return [
      s.room,
      s.node,
      s.flags.join(","),
      s.items.map(([i, n]) => `${i}=${n}`).join(","),
      s.abilities.join(","),
      s.checkpoint ? `${s.checkpoint.room}@${s.checkpoint.x},${s.checkpoint.y}` : "",
      s.visited.join(","),
      s.alive.join(","),
      s.hits.map(([i, n]) => `${i}=${n}`).join(","),
      s.destroyed.join(","),
      `${s.entry.x},${s.entry.y}`,
      s.settled ? 1 : 0,
      s.modals.map((m) => (m.end ? `!${m.id}` : m.id)).join(","),
      s.timers.join(","),
    ].join("|");
  }

  /** Add a state reached from `from` by `action` (from < 0: a start). */
  root(s: State, from: number, action: string, save: boolean): number {
    const k = this.key(s);
    const known = this.index.get(k);
    if (known !== undefined) return known;
    const i = this.states.length;
    this.states.push(s);
    this.index.set(k, i);
    this.parent.push(from);
    this.via.push(action);
    this.fromSave.push(save || (from >= 0 && this.fromSave[from]!));
    this.edges.push([]);
    this.edgeActions.push([]);
    this.ends.push(null);
    this.expanded.push(false);
    this.queue.push(i);
    return i;
  }

  /** A run saved on the way into state j (by `step`, when not j's own way in) is a start of its own: Continue. */
  resume(saved: RunSnapshot, j: number, step: [number, string] | null, startAbilities: readonly string[]): void {
    const m = this.model;
    const snapshot = m.canonical(saved);
    const k = JSON.stringify(snapshot);
    if (this.snapshots.has(k)) return;
    this.snapshots.add(k);
    const resumed = LogicRun.start(m.game, startAbilities, snapshot);
    const n = this.states.length;
    if (this.root(m.fromRun(resumed, m.startPos(resumed)), j, `quit, then Continue (saved in ${snapshot.room})`, true) !== n) return;
    if (step) this.savedBy.set(n, step);
    if (resumed.saved) this.resume(resumed.saved, n, null, startAbilities);
  }

  run(startAbilities: readonly string[]): void {
    const m = this.model;
    for (let q = 0; q < this.queue.length; q++) {
      if (this.states.length >= this.maxStates) {
        this.truncated = true;
        break;
      }
      const i = this.queue[q]!;
      this.expanded[i] = true;
      const succ = successors(m, this.states[i]!);
      for (const e of succ) {
        if (!e.to) {
          this.ends[i] ??= e.action;
          continue;
        }
        const j = this.root(e.to, i, e.action, false);
        if (!this.edges[i]!.includes(j)) {
          this.edges[i]!.push(j);
          this.edgeActions[i]!.push(e.action);
        }
        if (e.saved) this.resume(e.saved, j, [i, e.action], startAbilities);
      }
    }
    this.coreach();
  }

  /** Which states can still reach an ending (unexplored ones count as able: unknown). */
  private coreach(): void {
    const n = this.states.length;
    const back: number[][] = Array.from({ length: n }, () => []);
    this.edges.forEach((out, i) => out.forEach((j) => back[j]!.push(i)));
    this.alive = new Array(n).fill(false);
    this.distToEnd = new Array(n).fill(Infinity);
    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
      if (this.ends[i] !== null || !this.expanded[i]) (this.alive[i] = true), (this.distToEnd[i] = this.ends[i] !== null ? 0 : Infinity), queue.push(i);
    }
    for (let q = 0; q < queue.length; q++) {
      const j = queue[q]!;
      for (const i of back[j]!) {
        if (this.alive[i]) continue;
        this.alive[i] = true;
        this.distToEnd[i] = this.distToEnd[j]! + 1;
        queue.push(i);
      }
    }
  }

  memory(s: State): LogicMemory {
    return { items: Object.fromEntries(s.items), flags: [...s.flags], abilities: s.abilities as MovementAbility[], checkpoint: s.checkpoint && { ...s.checkpoint } };
  }

  step(i: number, action = this.via[i]!): LogicStep {
    const s = this.states[i]!;
    return { action, room: s.room, node: s.node, memory: this.memory(s) };
  }

  /** How a state was first reached: [state, the step into it] from a start (through the saving step, for a Continue). */
  private pathTo(i: number): [number, string][] {
    const path: [number, string][] = [];
    for (let k = i; k >= 0; ) {
      path.unshift([k, this.via[k]!]);
      const saved = this.savedBy.get(k);
      if (saved) path.unshift([this.parent[k]!, saved[1]]);
      k = saved ? saved[0] : this.parent[k]!;
    }
    return path;
  }

  /** A shortest route from the start to an ending, without quitting. */
  route(): LogicStep[] | null {
    const prev = new Map<number, [number, string]>([[0, [-1, "start"]]]);
    const queue = [0];
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]!;
      if (this.ends[i] !== null) {
        const steps: LogicStep[] = [];
        for (let k = i; k >= 0; k = prev.get(k)![0]) steps.unshift(this.step(k, prev.get(k)![1]));
        const last = this.states[i]!;
        steps.push({ action: this.ends[i]!, room: last.room, node: last.node, memory: this.memory(last) });
        return steps;
      }
      this.edges[i]!.forEach((j, n) => {
        if (!prev.has(j)) (prev.set(j, [i, this.edgeActions[i]![n]!]), queue.push(j));
      });
    }
    return null;
  }

  /** One counterexample per distinct place the player ends up stuck (bottom strongly connected components of the dead states). */
  deadStates(): DeadState[] {
    const n = this.states.length;
    const dead = (i: number) => !this.alive[i];
    const comp = new Array<number>(n).fill(-1);
    const low = new Array<number>(n).fill(0);
    const num = new Array<number>(n).fill(-1);
    const onStack = new Array<boolean>(n).fill(false);
    const stack: number[] = [];
    const comps: number[][] = [];
    let counter = 0;
    for (let r = 0; r < n; r++) {
      if (!dead(r) || num[r] !== -1) continue;
      const work: [number, number][] = [[r, 0]];
      num[r] = low[r] = counter++;
      stack.push(r);
      onStack[r] = true;
      while (work.length) {
        const top = work[work.length - 1]!;
        const [v, e] = top;
        const out = this.edges[v]!;
        if (e < out.length) {
          top[1]++;
          const w = out[e]!;
          if (num[w] === -1) {
            num[w] = low[w] = counter++;
            stack.push(w);
            onStack[w] = true;
            work.push([w, 0]);
          } else if (onStack[w]) low[v] = Math.min(low[v]!, num[w]!);
        } else {
          work.pop();
          if (work.length) low[work[work.length - 1]![0]] = Math.min(low[work[work.length - 1]![0]]!, low[v]!);
          if (low[v] === num[v]) {
            const c: number[] = [];
            let w: number;
            do {
              w = stack.pop()!;
              onStack[w] = false;
              comp[w] = comps.length;
              c.push(w);
            } while (w !== v);
            comps.push(c);
          }
        }
      }
    }
    const bottoms = comps.filter((c, id) => c.every((v) => this.edges[v]!.every((w) => comp[w] === id)));
    const found = new Map<string, DeadState & { length: number }>();
    for (const c of bottoms.map((c) => [...c].sort((a, b) => a - b)).sort((a, b) => this.pathTo(a[0]!).length - this.pathTo(b[0]!).length || a[0]! - b[0]!)) {
      const rep = c[0]!;
      const path = this.pathTo(rep);
      const why = explain(this, c, path.map(([k]) => k));
      const rooms = [...new Set(c.map((v) => this.states[v]!.room))].sort(cmp);
      const key = `${rooms.join(",")}|${why}`;
      if (found.has(key)) continue;
      found.set(key, { path: path.map(([k, action]) => this.step(k, action)), why, fromSave: this.fromSave[rep]!, length: path.length });
      if (found.size >= MAX_DEAD_REPORTS) break;
    }
    return [...found.values()].sort((a, b) => a.length - b.length).map(({ length: _, ...d }) => d);
  }

  // --- for explanations ---

  isAlive = (i: number) => this.alive[i]!;
  resumed = (i: number) => this.fromSave[i]!;
  /** States along a shortest way from i to an ending. */
  aliveRoute(i: number): number[] {
    const out = [i];
    while (this.distToEnd[i]! > 0 && Number.isFinite(this.distToEnd[i]!)) {
      const next = this.edges[i]!.find((j) => this.distToEnd[j] === this.distToEnd[i]! - 1);
      if (next === undefined) break;
      out.push((i = next));
    }
    return out;
  }
}

// ------------------------------------------------------------------ moves of the game

function successors(m: WorldModel, s: State): Edge[] {
  const out: Edge[] = [];
  const room = m.room(s.room);
  const base = m.toRun(s);
  const g = m.graphOf(s, base);
  const here: Pos = { room: s.room, node: s.node, x: s.x, y: s.y, graph: g, positional: false };

  if (s.modals.length) {
    const open = s.modals[0]!;
    const modal = m.game.modals.get(open.id)!;
    const labels = modal.buttons.length ? modal.buttons.map((b) => b.label) : ["Continue"];
    labels.forEach((label, i) => {
      const run = base.clone();
      run.press(i);
      out.push(...outcome(m, run, here, here, `press "${label}" (${modal.title || modal.id})`));
    });
    return out;
  }

  const entering = !isSurface(s.node);
  const moveGraph = entering ? m.waitingGraph(s, g, base) : g;
  for (const move of m.moves(moveGraph, s.node)) out.push(...moveEdges(m, s, base, moveGraph, move, room, here, moveGraph === g));
  if (entering) return out;

  const reach = m.reach(g, s.node, room, m.weaponsOf(s));
  const sf = g.surface(s.node)!;
  for (const p of room.props) {
    if (!base.present(p)) continue;
    const r = propRect(p);
    const at: Pos = { ...here, x: Math.min(sf.x1, Math.max(sf.x0, p.x + p.width / 2)), positional: true };
    const act = (label: string, op: (run: LogicRun) => void) => {
      const run = base.clone();
      run.feet = { x: at.x, y: at.y };
      op(run);
      out.push(...outcome(m, run, at, here, label));
    };
    const near = reach.touch.some((t) => overlaps(t, r));
    if (near && answers(p, "touch")) act(`touch ${propName(p)}`, (run) => run.touch(p.id));
    if (near && answers(p, "interact")) act(`use ${propName(p)}`, (run) => run.interact(p.id));
    if ((p.health != null || answers(p, "hit")) && reach.hit.some((t) => overlapsStrict(t, r))) act(`strike ${propName(p)}`, (run) => run.hit(p.id));
  }
  for (const id of s.alive) {
    const spawn = room.spawns.find((sp) => sp.id === id)!;
    const run = base.clone();
    run.kill(id);
    out.push(...outcome(m, run, here, here, `defeat ${spawn.healthBar?.title ?? spawn.id}`));
  }
  // Hazards kill through the damage their handlers do (touching one, below).
  if (s.alive.some((id) => m.dangerous.has(room.spawns.find((sp) => sp.id === id)!.characterId))) {
    const run = base.clone();
    run.die();
    out.push(...outcome(m, run, here, here, "die"));
  }
  if (reach.hazard) {
    const run = base.clone();
    run.touchHazard();
    out.push(...outcome(m, run, here, here, "touch a hazard"));
  }
  for (const t of s.timers) {
    const run = base.clone();
    run.timer(t);
    out.push(...outcome(m, run, here, here, `wait for timer ${t}`));
  }
  return out;
}

function moveEdges(m: WorldModel, s: State, base: LogicRun, g: RoomGraph, move: TraversalMove, room: WorldRoom, here: Pos, sameGraph: boolean): Edge[] {
  const trace = m.trace(g, room, move);
  const end = trace.states[trace.states.length - 1]!;
  const exit = move.to.startsWith("out:") ? move.to.slice(4) : null;
  const arrival = exit ? m.doorArrival(room, exit) : null;
  if (exit && !arrival) return [];
  const sf = exit ? null : g.surface(move.to)!;
  let label = sf ? `${move.kind === "enter" ? "land at" : `${move.kind} to`} (${round((sf.x0 + sf.x1) / 2)}, ${round(sf.y)})` : `${move.kind} through door ${exit} into ${arrival!.room}`;
  const present = trace.touches.filter(([id]) => base.present(room.props.find((p) => p.id === id)!));
  // Nothing happens on the way and the room is settled: only the position changes.
  if (!present.length && !exit && s.settled && sameGraph) {
    return [{ action: label, to: { ...s, node: move.to, x: round(end.x), y: round(end.y) }, saved: null }];
  }
  const run = base.clone();
  const touched: string[] = [];
  for (const [id, f] of present) {
    const p = room.props.find((q) => q.id === id)!;
    if (!run.present(p)) continue;
    run.feet = { x: trace.states[f]!.x, y: trace.states[f]!.y };
    run.touch(id);
    touched.push(propName(p));
    if (run.ended || run.lastEnter || run.toSafe) break;
  }
  if (touched.length) label += ` (touching ${touched.join(", ")})`;
  let pos: Pos = { room: s.room, node: move.to, x: round(end.x), y: round(end.y), graph: g, positional: true };
  if (!run.ended && !run.lastEnter && !run.toSafe) {
    if (arrival) run.goThrough(arrival.room, arrival.at, arrival.door);
    else if (!run.settled) {
      run.feet = { x: end.x, y: end.y };
      run.settle({ x: round(end.x), y: round(end.y) });
    }
  } else pos = here;
  return outcome(m, run, pos, here, label);
}

/** The states a step leads to (more than one when the floor splits under an event with no place, or when the damage it did can kill). */
function outcome(m: WorldModel, run: LogicRun, pos: Pos, safe: Pos, action: string): Edge[] {
  const out: Edge[] = [];
  const finish = (r: LogicRun, label: string) => {
    if (r.ended || r.modals.some((q) => q.end)) {
      out.push({ action: `${label}: the game ends`, to: null, saved: r.saved });
      return;
    }
    let p = pos;
    if (r.lastEnter) p = { room: r.room, node: r.lastEnter.door ? `in:${r.lastEnter.door}` : pointNode(r.lastEnter.at), x: round(r.lastEnter.at.x), y: round(r.lastEnter.at.y), graph: null, positional: true };
    else if (r.toSafe) p = safe;
    const base = m.fromRun(r, p);
    const g = p.graph ? m.graphOf(base, r) : null;
    for (const node of g ? m.remap(p, g) : [p.node]) {
      const at = node.startsWith("p:") ? node.slice(2).split(",").map(Number) : [p.x, p.y];
      out.push({ action: label, to: { ...base, node, x: at[0]!, y: at[1]! }, saved: r.saved });
    }
  };
  finish(run, action);
  if (run.damaged && !run.ended) {
    const r = run.clone();
    r.damaged = false;
    r.die();
    finish(r, `${action}, then die`);
  }
  return out;
}

// ------------------------------------------------------------------ why a state is dead

function atoms(m: WorldModel, s: State): string[] {
  const out: string[] = [];
  for (const [item, steps] of m.itemSteps) {
    const n = s.items.find(([i]) => i === item)?.[1] ?? 0;
    for (const t of steps) if (n >= t) out.push(`item:${item}:${t}`);
  }
  for (const f of m.flags) {
    const has = s.flags.includes(f) ? 1 : 0;
    out.push(f.startsWith(WEAPON_PREFIX) ? `weapon:${f.slice(WEAPON_PREFIX.length)}:${has}` : `flag:${f}:${has}`);
  }
  for (const a of s.abilities) out.push(`ability:${a}`);
  out.push(`room:${s.room}`);
  return out;
}

const KIND_ORDER = ["item", "weapon", "flag", "ability", "room"];

function explain(search: Search, comp: number[], path: number[]): string {
  const m = search.model;
  const states = search.states;
  const have = new Set(comp.flatMap((i) => atoms(m, states[i]!)));
  const stuckRooms = [...new Set(comp.map((i) => states[i]!.room))].sort(cmp);
  const rep = states[comp[0]!]!;
  const prefix = search.resumed(comp[0]!) ? "after Continue: " : "";
  const lastAlive = [...path].reverse().find((k) => search.isAlive(k));
  if (lastAlive !== undefined) {
    const ahead = search.aliveRoute(lastAlive).map((k) => states[k]!);
    for (const s of ahead) {
      const missing = atoms(m, s)
        .filter((a) => !have.has(a))
        .sort((a, b) => KIND_ORDER.indexOf(a.split(":")[0]!) - KIND_ORDER.indexOf(b.split(":")[0]!));
      if (!missing.length) continue;
      // What would provide it is right there but out of reach: the way to it is blocked.
      const out = outOfReach(m, comp.map((i) => states[i]!), missing[0]!);
      const way = out && blocked(m, out, stuckRooms);
      if (way && !way.endsWith("from there")) return prefix + way;
      return prefix + say(m, missing[0]!, stuckRooms, ahead.map((x) => x.room), rep);
    }
  }
  // Nothing on the way to an ending is in reach (or no way was ever there): conditions nothing can satisfy.
  for (const { c, ref, room } of preferRooms(m.conditions, stuckRooms)) {
    if (c.type === "flag" && c.is !== false && !m.flagsSet.has(c.flag)) return prefix + `${ref}${room ? ` (${room})` : ""} needs flag ${c.flag}, and nothing in the game sets it${nearMiss(m, c.flag)}`;
    if (c.type === "item" && !m.itemsGiven.has(c.item)) return prefix + `${ref}${room ? ` (${room})` : ""} needs item ${c.item}, and nothing in the game gives it`;
    if (c.type === "weapon" && !m.weaponsGiven.has(c.weapon)) return prefix + `${ref}${room ? ` (${room})` : ""} needs weapon ${c.weapon}, and nothing in the game gives it`;
  }
  return prefix + blocked(m, rep, stuckRooms);
}

/** A stuck state in a room with a present prop whose handlers would provide `atom`, which no stuck state can reach (else null). */
function outOfReach(m: WorldModel, stuck: State[], atom: string): State | null {
  const [kind, id, value] = atom.split(":");
  const provides = (e: Effect) =>
    (kind === "flag" && e.type === "setFlag" && e.flag === id && (e.value ?? true) === (value === "1")) ||
    (kind === "item" && e.type === "giveItem" && e.item === id) ||
    (kind === "weapon" && (e.type === "giveWeapon" || e.type === "takeWeapon") && e.type === (value === "1" ? "giveWeapon" : "takeWeapon") && e.weapon === id);
  for (const s of stuck) {
    if (!isSurface(s.node)) continue;
    const room = m.room(s.room);
    const run = m.toRun(s);
    const g = m.graphOf(s, run);
    const providers = room.props.filter((p) => run.present(p) && p.handlers.some((h) => h.do.some(provides)));
    if (!providers.length) continue;
    const reachable = stuck.some((t) => {
      if (t.room !== s.room || !isSurface(t.node)) return false;
      const r = m.reach(m.graphOf(t), t.node, room, m.weaponsOf(t));
      return providers.some((p) => [...r.touch, ...r.hit].some((x) => overlaps(x, propRect(p))));
    });
    if (!reachable) return s;
  }
  return null;
}

function preferRooms<T extends { room: string | null }>(list: T[], rooms: string[]): T[] {
  return [...list.filter((x) => x.room !== null && rooms.includes(x.room)), ...list.filter((x) => x.room === null || !rooms.includes(x.room))];
}

function say(m: WorldModel, atom: string, stuckRooms: string[], aheadRooms: string[], rep: State): string {
  const [kind, id, value] = atom.split(":") as [string, string, string];
  const refs = preferRooms(
    m.conditions.filter(
      ({ c }) =>
        (kind === "item" && c.type === "item" && c.item === id) ||
        (kind === "flag" && c.type === "flag" && c.flag === id) ||
        (kind === "weapon" && c.type === "weapon" && c.weapon === id) ||
        (kind === "ability" && c.type === "ability" && c.ability === id),
    ),
    aheadRooms,
  );
  const ref = refs[0];
  const who = ref ? `${ref.ref}${ref.room ? ` (${ref.room})` : ""}` : "the way on";
  if (kind === "item") {
    const n = Number(value);
    return `${who} needs ${n > 1 ? `${n} of ` : ""}item ${id}; ${m.itemsGiven.has(id) ? `no ${id} is left anywhere reachable from here` : "nothing in the game gives it"}`;
  }
  if (kind === "flag") {
    const solid = refs.find((r) => r.solid)?.solid;
    const lead = solid ? `${propName(solid)} stays solid (while ${describe(solid.solid)})` : `${who} needs flag ${id}${value === "1" ? "" : " unset"}`;
    if (value === "0") return `${lead}; nothing reachable from here clears flag ${id}`;
    return `${lead}; ${m.flagsSet.has(id) ? `nothing reachable from here sets flag ${id}` : `nothing in the game sets flag ${id}${nearMiss(m, id)}`}`;
  }
  if (kind === "weapon") {
    if (value === "0") return `${who} needs weapon ${id} gone; nothing reachable from here takes it`;
    return `${who} needs weapon ${id}; ${m.weaponsGiven.has(id) ? `nothing reachable from here gives it` : "nothing in the game gives it"}`;
  }
  if (kind === "ability") return `the way on needs ${id}, which is out of reach from here`;
  return blocked(m, rep, stuckRooms, id);
}

/** A flag that is set somewhere, named like `flag` that nothing sets (a likely typo). */
function nearMiss(m: WorldModel, flag: string): string {
  const best = [...m.flagsSet].map((f) => [f, distance(f, flag)] as const).sort((a, b) => a[1] - b[1] || cmp(a[0], b[0]))[0];
  if (!best || best[1] > Math.max(3, flag.length / 3)) return "";
  return m.flags.has(best[0]) ? ` (${best[0]} is set: a typo?)` : ` (${best[0]} is set but never checked)`;
}

/** Why a condition can't change: the flags in it nothing in the game sets. */
function frozen(m: WorldModel, c: GameCondition | PropSwitch): string {
  if (typeof c === "boolean") return "";
  const notes = flattenConditions([c])
    .filter((x): x is Extract<GameCondition, { type: "flag" }> => x.type === "flag" && !m.flagsSet.has(x.flag))
    .map((x) => `nothing in the game sets flag ${x.flag}${nearMiss(m, x.flag)}`);
  return notes.length ? `; ${[...new Set(notes)].join("; ")}` : "";
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** Why the player can't leave where they are stuck: a solid prop in the way, or an ability the way out needs. */
function blocked(m: WorldModel, s: State, stuckRooms: string[], wanted?: string): string {
  const room = m.room(s.room);
  const run = m.toRun(s);
  const solids = m.solidProps(s, run);
  const here = isSurface(s.node) ? m.graph(s.room, s.abilities, solids).surface(s.node) : undefined;
  const measure = (g: RoomGraph) => {
    let node = s.node;
    // Surface keys are per graph: in a graph with other solids, stand on the surface at the same place.
    if (here) {
      const i = g.surfaces.findIndex((f) => Math.abs(f.y - here.y) < 0.5 && f.x0 < here.x1 && f.x1 > here.x0);
      if (i < 0) return { exits: new Set<string>(), length: 0 };
      node = `s${i}`;
    }
    if (!isSurface(node)) m.moves(g, node);
    const reached = reachableFrom(g, node);
    const exits = new Set([...reached].filter((k) => k.startsWith("out:")));
    const length = [...reached].reduce((sum, k) => {
      const f = isSurface(k) ? g.surface(k) : undefined;
      return sum + (f ? f.x1 - f.x0 : 0);
    }, 0);
    return { exits, length };
  };
  const now = measure(m.graph(s.room, s.abilities, solids));
  const opens = (after: ReturnType<typeof measure>, slack: number) => [...after.exits].some((e) => !now.exits.has(e)) || after.length > now.length + slack;
  const reasons: string[] = [];
  for (const p of solids) {
    const after = measure(m.graph(s.room, s.abilities, solids.filter((q) => q !== p)));
    if (opens(after, p.width + m.params.width + 64)) reasons.push(`${propName(p)} blocks the way (solid ${typeof p.solid === "boolean" ? "always" : `while ${describe(p.solid)}`})${frozen(m, p.solid)}`);
  }
  if (!reasons.length) {
    for (const a of ALL_ABILITIES) {
      if (s.abilities.includes(a)) continue;
      const after = measure(m.graph(s.room, [...s.abilities, a].sort(cmp), solids));
      if ([...after.exits].some((e) => !now.exits.has(e))) reasons.push(`the way out of ${room.id} needs ${a}${m.game.without.has(a) ? " (left out of this check)" : ""}`);
    }
  }
  const where = `stuck in ${stuckRooms.join(", ")}`;
  if (reasons.length) return `${where}: ${reasons.join("; ")}`;
  return wanted ? `${where}: no way from there to ${wanted}` : `${where}: no ending is reachable from there`;
}
