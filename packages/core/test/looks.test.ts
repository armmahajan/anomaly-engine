import { describe, expect, it } from "vitest";
import {
  applyOperation,
  ARENA_FLOOR,
  BehaviorState,
  checkGame,
  createDefaultProject,
  Effect,
  Emitter,
  fixtureAnimatedProject,
  fixtureReferenceProject,
  GameEvent,
  lintProject,
  Look,
  lookKeys,
  LogicRun,
  logicGame,
  matches,
  ProjectSpec,
  RuntimeToStudio,
  type CheckResult,
  type OperationResult,
} from "../src/index.ts";

// Looks and effects tooling (core art/animation.ts): emitters, looks, setLook / clearLook / emit /
// dissolve / cameraZoom, the stateEntered event and BehaviorState.look. All visual: the logic model
// reads none of it, and an enemy's stateEntered may fire whenever it is alive.

const ok = (r: OperationResult): ProjectSpec => {
  if (!r.ok) throw new Error(`${r.error.message} ${JSON.stringify(r.error.issues)}`);
  return r.project;
};
const op = (p: ProjectSpec, name: string, input: unknown) => ok(applyOperation(p, name, input));
const codes = (p: ProjectSpec) => lintProject(p).map((w) => w.code);
const START = { room: "arena", at: { x: 160, y: ARENA_FLOOR } };
const actions = (r: CheckResult) => r.deadStates.flatMap((d) => d.path.map((s) => s.action));

describe("look contracts", () => {
  it("emitters and looks parse with their defaults; every look field is optional", () => {
    expect(Emitter.parse({})).toEqual({ shape: "dot", color: "#ffffff", rate: 20, burst: 0, lifetime: 0.6, speed: 80, spread: 360, direction: -90, gravity: 0, size: 4, additive: true });
    expect(Look.parse({})).toEqual({});
    const look = Look.parse({ tint: { color: "#ff0000" }, aura: { color: "#ff4400" }, afterimages: {}, emitter: { shape: "spark" } });
    expect(look.tint).toEqual({ color: "#ff0000", amount: 0.5 });
    expect(look.aura).toEqual({ color: "#ff4400", size: 12, pulse: 0.3 });
    expect(look.afterimages).toEqual({ count: 4, interval: 0.06, fade: 0.3 });
    expect(lookKeys(look).sort()).toEqual(["afterimages", "aura", "emitter", "tint"]);
    expect(Look.safeParse({ opacity: 2 }).success).toBe(false);
    expect(Look.safeParse({ glow: 1 }).success).toBe(false);
    expect(Emitter.safeParse({ rate: 500 }).success).toBe(false);
  });

  it("the new effects and stateEntered parse with their defaults", () => {
    expect(Effect.parse({ type: "setLook", look: { brightness: 2 } })).toEqual({ type: "setLook", target: { kind: "self" }, look: { brightness: 2 }, seconds: null, fade: 0.2 });
    expect(Effect.parse({ type: "clearLook" })).toEqual({ type: "clearLook", target: { kind: "self" }, fade: 0.2 });
    expect(Effect.parse({ type: "emit", emitter: { burst: 12, rate: 0 } })).toMatchObject({ at: { kind: "self" }, offset: [0, 0], seconds: 0.5, layer: "front", emitter: { burst: 12, rate: 0, shape: "dot" } });
    expect(Effect.parse({ type: "dissolve" })).toEqual({ type: "dissolve", target: { kind: "self" }, to: "out", seconds: 0.4, color: "#ffffff" });
    expect(Effect.parse({ type: "cameraZoom" })).toEqual({ type: "cameraZoom", amount: 1.15, seconds: 0.3 });
    expect(GameEvent.parse({ type: "stateEntered", state: "rage", from: { kind: "spawn", spawn: "x" } })).toMatchObject({ type: "stateEntered", state: "rage" });
    expect(Effect.safeParse({ type: "setLook", look: {}, seconds: 90 }).success).toBe(false);
    expect(Effect.safeParse({ type: "dissolve", seconds: 0 }).success).toBe(false);
  });

  it("old projects parse unchanged (no state gets a look) and a state's look round-trips", () => {
    const ref = fixtureReferenceProject();
    expect(ProjectSpec.parse(ref)).toEqual(ref);
    const p = createDefaultProject();
    expect(ProjectSpec.parse(p)).toEqual(p);
    for (const c of p.characters) if (c.kind === "enemy") for (const s of Object.values(c.behavior.states)) expect("look" in s).toBe(false);
    const state = BehaviorState.parse({ action: { type: "wait" }, transitions: [], look: { aura: { color: "#ff0000" } } });
    expect(state.look?.aura?.size).toBe(12);
  });

  it("the runtime state's new fields default for a runtime on the previous protocol", () => {
    const parsed = RuntimeToStudio.parse({ type: "state", requestId: "r", mode: "play", revision: 1, seed: 1, deaths: 0, entities: [{ spawnId: "a", characterId: "b", x: 0, y: 0, velocityX: 0, velocityY: 0, behaviorState: null, health: 1 }], props: [{ id: "p", visible: true, solid: false }] });
    expect(parsed.type === "state" && [parsed.entities[0]!.look, parsed.entities[0]!.dissolved, parsed.props[0]!.look, parsed.playerLook, parsed.emitters]).toEqual([null, false, null, null, 0]);
  });
});

describe("look lint", () => {
  it("flags setLook / clearLook / dissolve / emit targets that aren't in the room and self outside a prop or spawn", () => {
    let p = fixtureAnimatedProject();
    p = op(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomEntered" }, do: [{ type: "setLook", target: { kind: "spawn", spawn: "ghost" }, look: { brightness: 2 } }] } });
    p = op(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomEntered" }, do: [{ type: "dissolve", target: { kind: "prop", prop: "nowhere" } }] } });
    p = op(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomEntered" }, do: [{ type: "clearLook" }] } });
    p = op(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomEntered" }, do: [{ type: "emit", at: { kind: "spawn", spawn: "ghost" }, emitter: {} }] } });
    const warnings = lintProject(p).filter((w) => w.code.startsWith("anim_"));
    expect(warnings.filter((w) => w.code === "anim_target_unknown").length).toBe(3);
    expect(warnings.filter((w) => w.code === "anim_self_outside").length).toBe(1);
  });

  it("valid targets are quiet", () => {
    let p = fixtureAnimatedProject();
    p = op(p, "addHandler", { roomId: "arena", spawnId: "charger_1", handler: { on: { type: "stateEntered", state: "charge" }, do: [{ type: "setLook", look: { aura: { color: "#ff0000" } } }, { type: "dissolve", target: { kind: "player" } }, { type: "emit", emitter: {} }, { type: "cameraZoom" }] } });
    p = op(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomEntered" }, do: [{ type: "setLook", target: { kind: "prop", prop: "trap" }, look: { opacity: 0.5 } }] } });
    expect(codes(p).filter((c) => c.startsWith("anim_"))).toEqual([]);
  });

  it("flags stateEntered waiting for a state the spawn's enemy doesn't have (its own, or a world/room handler's from)", () => {
    let p = fixtureAnimatedProject();
    p = op(p, "addHandler", { roomId: "arena", spawnId: "charger_1", handler: { on: { type: "stateEntered", state: "enraged" }, do: [{ type: "shake" }] } });
    p = op(p, "addHandler", { roomId: "arena", handler: { on: { type: "stateEntered", state: "nope", from: { kind: "spawn", spawn: "charger_1" } }, do: [{ type: "shake" }] } });
    p = op(p, "addHandler", { roomId: "arena", handler: { on: { type: "stateEntered", state: "windup" }, do: [{ type: "shake" }] } });
    const found = lintProject(p).filter((w) => w.code === "anim_state_unknown");
    expect(found).toHaveLength(2);
    expect(found.every((w) => w.path.endsWith(".on"))).toBe(true);
    expect(found.some((w) => w.message.includes('"enraged"'))).toBe(true);
  });
});

describe("looks in the logic model", () => {
  it("setLook, clearLook, emit, dissolve and cameraZoom change nothing the logic reads", () => {
    const run = LogicRun.start(logicGame(fixtureAnimatedProject(), START), []);
    const before = JSON.stringify(run.snapshot());
    run.run([
      Effect.parse({ type: "setLook", target: { kind: "player" }, look: { aura: { color: "#ff0000" }, opacity: 0 } }),
      Effect.parse({ type: "clearLook", target: { kind: "player" } }),
      Effect.parse({ type: "emit", at: { kind: "point", x: 1, y: 2 }, emitter: { burst: 10 } }),
      Effect.parse({ type: "dissolve", target: { kind: "spawn", spawn: "charger_1" } }),
      Effect.parse({ type: "cameraZoom" }),
    ]);
    run.flush();
    expect(JSON.stringify(run.snapshot())).toBe(before);
    expect(run.damaged).toBe(false);
    expect(run.alive.has("charger_1")).toBe(true);
  });

  it("matches stateEntered like events.gd: a spawn hears its own, world/room handlers filter by state and from, props never", () => {
    const ev = { type: "stateEntered", spawn: "charger_1", character: "charger", state: "charge", room: "arena" };
    expect(matches({ type: "stateEntered" }, ev, { room: "arena", spawn: "charger_1" })).toBe(true);
    expect(matches({ type: "stateEntered" }, ev, { room: "arena", spawn: "crawler_1" })).toBe(false);
    expect(matches({ type: "stateEntered", state: "windup" }, ev, { room: "arena", spawn: "charger_1" })).toBe(false);
    expect(matches({ type: "stateEntered", state: "charge" }, ev, {})).toBe(true);
    expect(matches({ type: "stateEntered", from: { kind: "spawn", spawn: "charger_1" } }, ev, { room: "arena" })).toBe(true);
    expect(matches({ type: "stateEntered", from: { kind: "spawn", spawn: "crawler_1" } }, ev, {})).toBe(false);
    expect(matches({ type: "stateEntered", from: { kind: "player" } }, ev, {})).toBe(false);
    expect(matches({ type: "stateEntered" }, ev, { room: "arena", prop: "trap" })).toBe(false);
    expect(matches({ type: "stateEntered" }, ev, { room: "elsewhere" })).toBe(false);
  });

  it("each living spawn can enter any of its states; the driver fires them to the right handlers", () => {
    let p = fixtureAnimatedProject();
    p = op(p, "addHandler", { roomId: "arena", spawnId: "charger_1", handler: { on: { type: "stateEntered", state: "charge" }, do: [{ type: "setFlag", flag: "charging" }] } });
    p = op(p, "addHandler", { roomId: "arena", handler: { on: { type: "stateEntered", from: { kind: "spawn", spawn: "crawler_1" } }, do: [{ type: "setFlag", flag: "crawler_moved" }] } });
    const run = LogicRun.start(logicGame(p, START), []);
    const states = run.ambientStates();
    expect(states.filter((s) => s.spawn === "charger_1").map((s) => s.state)).toEqual(["patrol", "windup", "charge", "recover"]);
    expect(states.filter((s) => s.spawn === "crawler_1").map((s) => s.state)).toEqual(["rest", "fire"]);
    run.stateEntered({ spawn: "charger_1", character: "charger", state: "windup" });
    expect(run.flags.size).toBe(0);
    run.stateEntered({ spawn: "charger_1", character: "charger", state: "charge" });
    expect([...run.flags]).toEqual(["charging"]);
    run.stateEntered({ spawn: "crawler_1", character: "crawler", state: "fire" });
    expect([...run.flags].sort()).toEqual(["charging", "crawler_moved"]);
    run.kill("charger_1");
    expect(run.ambientStates().some((s) => s.spawn === "charger_1")).toBe(false);
  });
});

describe("the checker and stateEntered", () => {
  /** The lever's click ends the game unless the player died; only the charger can be fought (crawler and trap gone, its contact harmless). */
  function game(handler: object | null): ProjectSpec {
    let p = fixtureAnimatedProject();
    p = op(p, "removeRoomSpawn", { roomId: "arena", spawnId: "crawler_1" });
    p = op(p, "updateProp", { roomId: "arena", propId: "trap", changes: { handlers: [] } });
    p = op(p, "updateCharacter", { characterId: "charger", changes: { stats: { knockback: 650, health: 4, contactDamage: 0 } } });
    p = op(p, "setBehavior", { characterId: "charger", behavior: { initial: "rest", states: { rest: { action: { type: "wait" }, transitions: [{ when: { type: "after", seconds: 1 }, to: "glow" }] }, glow: { action: { type: "wait" }, transitions: [{ when: { type: "after", seconds: 1 }, to: "rest" }], look: { aura: { color: "#ff0000" } } } }, interrupts: [] } });
    if (handler) p = op(p, "addHandler", { roomId: "arena", spawnId: "charger_1", handler });
    return ProjectSpec.parse({
      ...p,
      world: {
        ...p.world,
        handlers: [
          ...p.world.handlers,
          { on: { type: "playerDied" }, do: [{ type: "setFlag", flag: "doomed" }] },
          { on: { type: "marker", name: "click", from: { kind: "prop", prop: "lever" } }, when: [{ type: "flag", flag: "doomed", is: false }], do: [{ type: "endGame" }] },
        ],
      },
    });
  }

  it("a harmless enemy with a state look is no hazard; damage in its stateEntered handler is one while it lives", () => {
    const calm = checkGame(game({ on: { type: "stateEntered", state: "glow" }, do: [{ type: "setLook", look: { brightness: 2 } }, { type: "shake" }] }));
    expect(calm.beatable).toBe(true);
    expect(calm.deadStates).toEqual([]);
    const harmful = checkGame(game({ on: { type: "stateEntered", state: "glow" }, do: [{ type: "damage", amount: 1 }] }));
    expect(harmful.beatable).toBe(true);
    expect(actions(harmful).some((a) => a === `spawn charger_1 enters its state "glow", then die`)).toBe(true);
  });
});
