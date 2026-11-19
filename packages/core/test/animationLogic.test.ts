import { describe, expect, it } from "vitest";
import {
  applyOperation,
  ARENA_FLOOR,
  checkGame,
  clipMarkers,
  exampleRig,
  fixtureAnimatedProject,
  LogicRun,
  logicGame,
  matches,
  type CheckResult,
  type Clip,
  type OperationResult,
  ProjectSpec,
} from "../src/index.ts";

// Animation in the logic model (world/logic/interpret.ts, check.ts): playAnimation and spawnEffect
// fire their clip's markers at once, in order, to the same handler scopes as the runtime
// (game/scripts/events.gd); damage in a marker handler is a hazard wherever its trigger can happen.

const ok = (r: OperationResult): ProjectSpec => {
  if (!r.ok) throw new Error(`${r.error.message} ${JSON.stringify(r.error.issues)}`);
  return r.project;
};
const op = (p: ProjectSpec, name: string, input: unknown) => ok(applyOperation(p, name, input));
const oneShot = (duration: number, markers: { t: number; name: string }[]): Clip => ({ duration, loop: false, tracks: [], motions: [], visibility: [], markers });
const START = { room: "arena", at: { x: 160, y: ARENA_FLOOR } };
const actions = (r: CheckResult) => r.deadStates.flatMap((d) => d.path.map((s) => s.action));

/** The fixture without its enemies (no other way to get hurt), the player drawn with a `wave` clip. */
function quiet(): ProjectSpec {
  let p = fixtureAnimatedProject();
  p = op(p, "removeRoomSpawn", { roomId: "arena", spawnId: "crawler_1" });
  p = op(p, "createAsset", { asset: { id: "hero_look", name: "Hero", kind: "character", brief: "a hero" }, assignTo: "player" });
  p = op(p, "setRig", { assetId: "hero_look", rig: exampleRig() });
  p = op(p, "setClip", { assetId: "hero_look", clipId: "wave", clip: oneShot(0.5, [{ t: 0.8, name: "b" }, { t: 0.2, name: "a" }, { t: 0.8, name: "c" }]) });
  return p;
}

describe("markers in the logic model", () => {
  it("orders a clip's markers by time, then as listed (rig_view.gd)", () => {
    expect(clipMarkers(oneShot(1, [{ t: 0.8, name: "b" }, { t: 0.2, name: "a" }, { t: 0.8, name: "c" }]))).toEqual(["a", "b", "c"]);
    expect(clipMarkers(undefined)).toEqual([]);
  });

  it("playAnimation fires the clip's markers at once, in order, heard by the prop itself and by world handlers filtered by name and from", () => {
    const p = quiet();
    const hears = (on: object, flag: string) => ({ on: { type: "marker", ...on }, do: [{ type: "setFlag", flag }] });
    const world = { ...p.world, handlers: [hears({ from: { kind: "player" } }, "player_any"), hears({ name: "strike", from: { kind: "prop", prop: "trap" } }, "trap_strike"), hears({ name: "strike", from: { kind: "prop", prop: "lever" } }, "lever_strike"), hears({ from: { kind: "self" } }, "self_means_nothing")] };
    const run = LogicRun.start(logicGame(ProjectSpec.parse({ ...p, world }), START), []);
    run.touch("trap");
    expect(run.markers).toEqual([{ name: "strike", from: "prop:trap" }]);
    expect(run.damaged).toBe(true); // the trap's own marker handler
    expect([...run.flags]).toContain("trap_strike");
    expect([...run.flags]).not.toContain("lever_strike");
    run.interact("lever");
    expect(run.flags.has("lever_pulled")).toBe(true);
    run.run([{ type: "playAnimation", target: { kind: "player" }, clip: "wave", then: "idle" }]);
    run.flush();
    expect(run.markers.map((m) => `${m.from}/${m.name}`)).toEqual(["prop:trap/strike", "prop:lever/click", "player/a", "player/b", "player/c"]);
    expect(run.flags.has("player_any")).toBe(true);
    expect(run.flags.has("self_means_nothing")).toBe(false);
  });

  it("plays on spawns (alive only) and fires spawnEffect markers from the effect; a missing clip or place does nothing", () => {
    let p = quiet();
    p = op(p, "setClip", { assetId: "charger_look", clipId: "taunt", clip: oneShot(0.4, [{ t: 0.5, name: "roar" }]) });
    p = op(p, "setClip", { assetId: "shockwave", clipId: "burst", clip: oneShot(0.5, [{ t: 0.1, name: "boom" }]) });
    const run = LogicRun.start(logicGame(p, START), []);
    run.run([{ type: "playAnimation", target: { kind: "spawn", spawn: "charger_1" }, clip: "taunt", then: "idle" }]);
    run.flush();
    // The charger's own impact handler hears only its own markers: roar isn't impact, so nothing more.
    expect(run.markers).toEqual([{ name: "roar", from: "spawn:charger_1" }]);
    run.run([{ type: "playAnimation", target: { kind: "player" }, clip: "nope", then: "idle" }, { type: "playAnimation", target: { kind: "self" }, clip: "wave", then: "idle" }]);
    run.run([{ type: "spawnEffect", object: "shockwave", clip: "burst", at: { kind: "point", x: 1, y: 2 }, offset: [0, 0], scale: 1, layer: "front" }]);
    run.run([{ type: "spawnEffect", object: "shockwave", clip: "burst", at: { kind: "self" }, offset: [0, 0], scale: 1, layer: "front" }]);
    run.flush();
    expect(run.markers.slice(1)).toEqual([{ name: "boom", from: "effect:shockwave" }]);
    // The charger's impact (its attack clip) spawns a shockwave at itself: the effect's markers follow.
    run.marker({ name: "impact", source: "spawn:charger_1", spawn: "charger_1" });
    expect(run.markers.slice(2)).toEqual([{ name: "impact", from: "spawn:charger_1" }, { name: "boom", from: "effect:shockwave" }]);
    run.kill("charger_1");
    run.run([{ type: "playAnimation", target: { kind: "spawn", spawn: "charger_1" }, clip: "taunt", then: "idle" }]);
    run.flush();
    expect(run.markers).toHaveLength(4);
  });

  it("matches markers like events.gd: scoped handlers hear their own, world/room ones filter by name and from", () => {
    const ev = { type: "marker", name: "strike", source: "prop:trap", prop: "trap", room: "arena" };
    expect(matches({ type: "marker" }, ev, { room: "arena", prop: "trap" })).toBe(true);
    expect(matches({ type: "marker" }, ev, { room: "arena", prop: "lever" })).toBe(false);
    expect(matches({ type: "marker", from: { kind: "player" } }, ev, { room: "arena", prop: "trap" })).toBe(true); // from: for world/room handlers
    expect(matches({ type: "marker", name: "click" }, ev, {})).toBe(false);
    expect(matches({ type: "marker", from: { kind: "prop", prop: "trap" } }, ev, { room: "arena" })).toBe(true);
    expect(matches({ type: "marker", from: { kind: "spawn", spawn: "trap" } }, ev, {})).toBe(false);
    expect(matches({ type: "marker" }, ev, { room: "elsewhere" })).toBe(false);
  });
});

describe("the checker and marker handlers", () => {
  /** The lever's click ends the game, unless the player has died: dying is the only way to lose. */
  function game(edit: (p: ProjectSpec) => ProjectSpec = (p) => p): ProjectSpec {
    let p = quiet();
    p = op(p, "removeRoomSpawn", { roomId: "arena", spawnId: "charger_1" });
    p = edit(p);
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

  it("a marker handler's effects happen with the event that played the clip (the lever's click ends the game)", () => {
    const r = checkGame(game((p) => op(p, "updateProp", { roomId: "arena", propId: "trap", changes: { handlers: [] } })));
    expect(r.beatable).toBe(true);
    expect(r.deadStates).toEqual([]);
    expect(r.route!.map((s) => s.action).at(-1)).toMatch(/use Lever: the game ends/);
  });

  it("damage in a marker handler is a hazard where its trigger happens (touching the trap can kill)", () => {
    const r = checkGame(game());
    expect(r.beatable).toBe(true);
    expect(r.deadStates.length).toBeGreaterThan(0);
    expect(actions(r).some((a) => /touching Trap.*then die|touch Trap, then die/.test(a))).toBe(true);
  });

  it("markers of clips that play with no cue (an idle) may fire at any time", () => {
    const ticking = (p: ProjectSpec) => {
      p = op(p, "setClip", { assetId: "trap", clipId: "idle", clip: { ...oneShot(1, [{ t: 0.5, name: "tick" }]), loop: true } });
      return op(p, "updateProp", { roomId: "arena", propId: "trap", changes: { handlers: [{ on: { type: "marker", name: "tick" }, do: [{ type: "damage", amount: 1 }] }] } });
    };
    const r = checkGame(game(ticking));
    expect(actions(r).some((a) => a === `prop trap's animation reaches its marker "tick", then die`)).toBe(true);
    // Nobody listening: no such moves.
    const quietIdle = checkGame(game((p) => op(p, "setClip", { assetId: "trap", clipId: "idle", clip: { ...oneShot(1, [{ t: 0.5, name: "tick" }]), loop: true } })));
    expect(quietIdle.route!.some((s) => s.action.includes("reaches its marker"))).toBe(false);
  });
});
