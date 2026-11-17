import { describe, expect, it } from "vitest";
import { Action, applyOperation, createDefaultProject, lintCombat, lintProject, MIN_WARNING, primitiveParams, ProjectSpec, validateProject } from "../src/index.ts";

/** The starter project with one more enemy (`stats` and `behavior` over a plain one), spawned in the arena. */
function withEnemy(behavior: { initial: string; states: Record<string, unknown> }, stats: Record<string, number> = {}, extra: Record<string, unknown> = {}): ProjectSpec {
  const base = createDefaultProject();
  const room = base.world.rooms[0]!;
  return ProjectSpec.parse({
    ...base,
    characters: [
      ...base.characters,
      { id: "foe", kind: "enemy", name: "Foe", color: "#888888", size: { width: 40, height: 40 }, stats: { knockback: 300, health: 3, contactDamage: 1, ...stats }, behavior: { interrupts: [], ...behavior }, ...extra },
    ],
    world: { ...base.world, rooms: [{ ...room, spawns: [...room.spawns, { id: "foe_1", characterId: "foe", x: 800, y: 672 }] }] },
  });
}
const codes = (project: ProjectSpec) => lintCombat(project).map((w) => w.code);
const st = (action: object, transitions: object[] = []) => ({ action, transitions });
const go = (to: string, when: object = { type: "actionDone" }) => ({ when, to });

describe("attack primitives", () => {
  it("fill sensible defaults and reject a warning shorter than MIN_WARNING", () => {
    expect(MIN_WARNING).toBe(0.25);
    for (const type of ["strike", "shoot", "leap", "slam", "teleport"]) {
      const parsed = Action.parse({ type });
      expect((parsed as { windup: number }).windup).toBeGreaterThanOrEqual(MIN_WARNING);
      expect(Action.safeParse({ type, windup: 0.2 }).success).toBe(false);
      expect(Action.safeParse({ type, windup: MIN_WARNING }).success).toBe(true);
    }
    expect(Action.safeParse({ type: "summon", character: "mite", max: 3, windup: 0.1 }).success).toBe(false);
  });

  it("a summon needs a cap", () => {
    expect(Action.safeParse({ type: "summon", character: "mite" }).success).toBe(false);
    expect(Action.safeParse({ type: "summon", character: "mite", max: 0 }).success).toBe(false);
    expect(Action.parse({ type: "summon", character: "mite", max: 2 })).toMatchObject({ count: 1, max: 2 });
  });

  it("expose their params to editors (summon names a character as text)", () => {
    expect(primitiveParams("action", "strike").map((p) => p.name)).toEqual(["windup", "active", "recovery", "damage", "width", "height", "offsetX", "lunge", "color"]);
    expect(primitiveParams("action", "summon").find((p) => p.name === "character")?.kind).toBe("text");
    expect(primitiveParams("action", "shoot").find((p) => p.name === "color")?.kind).toBe("color");
    expect(primitiveParams("action", "teleport").find((p) => p.name === "to")).toEqual({ name: "to", kind: "enum", options: ["home", "random", "behindPlayer"] });
  });

  it("armor is an optional 0..1 enemy stat", () => {
    expect(validateProject(withEnemy({ initial: "a", states: { a: st({ type: "wait" }) } }, { armor: 0.5 })).ok).toBe(true);
    expect(() => withEnemy({ initial: "a", states: { a: st({ type: "wait" }) } }, { armor: 1.5 })).toThrow("<=1");
  });
});

describe("setSpawnHealthBar", () => {
  it("shows and hides a spawn's titled health bar", () => {
    const base = createDefaultProject();
    const on = applyOperation(base, "setSpawnHealthBar", { roomId: "arena", spawnId: "charger_1", healthBar: { title: "The Charger" } });
    if (!on.ok) throw new Error(on.error.message);
    expect(on.project.world.rooms[0]!.spawns.find((sp) => sp.id === "charger_1")!.healthBar).toEqual({ title: "The Charger" });
    expect(on.project.revision).toBe(base.revision + 1);
    const off = applyOperation(on.project, "setSpawnHealthBar", { roomId: "arena", spawnId: "charger_1", healthBar: null });
    expect(off.ok && off.project.world.rooms[0]!.spawns.find((sp) => sp.id === "charger_1")!.healthBar).toBeNull();
  });

  it("rejects unknown rooms and spawns and an empty title", () => {
    const base = createDefaultProject();
    expect(applyOperation(base, "setSpawnHealthBar", { roomId: "nowhere", spawnId: "charger_1", healthBar: null })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(applyOperation(base, "setSpawnHealthBar", { roomId: "arena", spawnId: "ghost", healthBar: null })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(applyOperation(base, "setSpawnHealthBar", { roomId: "arena", spawnId: "charger_1", healthBar: { title: "" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("lintCombat (fairness)", () => {
  it("the starter project is fair", () => {
    expect(lintCombat(createDefaultProject())).toEqual([]);
  });

  it("flags a charge entered without a telegraph of at least MIN_WARNING", () => {
    const rush = st({ type: "charge", speed: 500 }, [go("rest", { type: "hitWall" })]);
    const rest = st({ type: "wait" }, [go("watch", { type: "after", seconds: 1 })]);
    const direct = withEnemy({ initial: "watch", states: { watch: st({ type: "wait" }, [go("rush", { type: "playerWithin", distance: 200 })]), rush, rest } });
    expect(codes(direct)).toEqual(["unwarned_attack"]);
    const short = withEnemy({ initial: "watch", states: { watch: st({ type: "telegraph", color: "#ffffff" }, [go("rush", { type: "after", seconds: 0.1 })]), rush, rest } });
    expect(codes(short)).toEqual(["unwarned_attack"]);
    const fair = withEnemy({ initial: "watch", states: { watch: st({ type: "telegraph", color: "#ffffff" }, [go("rush", { type: "after", seconds: 0.5 })]), rush, rest } });
    expect(codes(fair)).toEqual([]);
    expect(codes(withEnemy({ initial: "rush", states: { rush, rest: st({ type: "wait" }) } }))).toEqual(["unwarned_attack"]);
  });

  it("flags a behavior with no state the player can hit back in", () => {
    const relentless = withEnemy({
      initial: "fire",
      states: { fire: st({ type: "shoot" }, [go("blink")]), blink: st({ type: "teleport" }, [go("swing")]), swing: st({ type: "strike", recovery: 0.1 }, [go("fire")]) },
    });
    expect(codes(relentless)).toEqual(["no_opening"]);
    const opening = withEnemy({ initial: "fire", states: { fire: st({ type: "shoot" }, [go("blink")]), blink: st({ type: "teleport" }, [go("swing")]), swing: st({ type: "strike", recovery: 0.5 }, [go("fire")]) } });
    expect(codes(opening)).toEqual([]);
  });

  it("flags a leap or teleport reaching further than a room it spawns in is wide (the arena: 1600 px)", () => {
    const wait = st({ type: "wait" }, [go("move", { type: "after", seconds: 1 })]);
    const far = (action: object) => codes(withEnemy({ initial: "idle", states: { idle: wait, move: st(action, [go("idle")]) } }));
    expect(far({ type: "leap", maxDistance: 1590 })).toEqual(["range_exceeds_room"]);
    expect(far({ type: "teleport", to: "random", range: 900 })).toEqual(["range_exceeds_room"]);
    expect(far({ type: "teleport", to: "behindPlayer", range: 300 })).toEqual([]);
    expect(far({ type: "leap", maxDistance: 400 })).toEqual([]);
  });

  it("flags summons of a non-enemy, chains of summoners, contact damage without knockback and a flyer that leaps", () => {
    const calls = (character: string) => withEnemy({ initial: "call", states: { call: st({ type: "summon", character, max: 2 }, [go("rest")]), rest: st({ type: "wait" }, [go("call", { type: "after", seconds: 2 })]) } });
    expect(codes(calls("player"))).toEqual(["summon_unknown"]);
    expect(codes(calls("crawler"))).toEqual([]);
    expect(codes(calls("foe"))).toEqual(["summon_chain"]);
    expect(codes(withEnemy({ initial: "a", states: { a: st({ type: "wait" }) } }, { knockback: 0, contactDamage: 1 }))).toEqual(["contact_no_knockback"]);
    expect(codes(withEnemy({ initial: "a", states: { a: st({ type: "leap" }, [go("b")]), b: st({ type: "wait" }, [go("a", { type: "after", seconds: 1 })]) } }, {}, { movement: "flying" }))).toEqual(["movement_mismatch"]);
  });

  it("a character it summons needs no spawn of its own", () => {
    const base = withEnemy({ initial: "call", states: { call: st({ type: "summon", character: "mite", max: 2 }, [go("rest")]), rest: st({ type: "wait" }, [go("call", { type: "after", seconds: 2 })]) } });
    const mite = { ...base.characters.find((c) => c.id === "crawler")!, id: "mite" };
    const unplaced = lintProject(ProjectSpec.parse({ ...base, characters: [...base.characters, mite] })).filter((w) => w.code === "unplaced_character");
    expect(unplaced).toEqual([]);
  });

  it("reports through lintProject with paths", () => {
    const warnings = lintProject(withEnemy({ initial: "a", states: { a: st({ type: "wait" }) } }, { knockback: 0 }));
    expect(warnings).toContainEqual(expect.objectContaining({ code: "contact_no_knockback", path: "characters.3.stats" }));
  });
});
