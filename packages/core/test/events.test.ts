import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createDefaultProject,
  EFFECT_TYPES,
  GAME_EVENT_TYPES,
  lintProject,
  migrateProject,
  ruleHandlers,
  SCHEMA_VERSION,
  toRuntimeProject,
  validateProject,
  type OperationResult,
  type ProjectSpec,
} from "../src/index.ts";
import { legacy } from "./legacy.ts";

function ok(result: OperationResult): ProjectSpec {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}
const op = (p: ProjectSpec, name: string, input: unknown) => applyOperation(p, name, input);
const withWorld = (p: ProjectSpec, world: Partial<ProjectSpec["world"]>) => ({ ...p, world: { ...p.world, ...world } });

/** The default project with an item, a modal and a prop in the arena. */
function stocked(): ProjectSpec {
  const p = createDefaultProject();
  const arena = p.world.rooms[0]!;
  return ProjectSpecOf({
    ...p,
    world: {
      ...p.world,
      items: [{ id: "key", name: "Key" }],
      modals: [{ id: "hello", title: "Hello" }],
      rooms: [{ ...arena, props: [{ id: "gate", x: 900, y: 576, width: 32, height: 96, solid: { type: "flag", flag: "open", is: false } }] }],
    },
  });
}
function ProjectSpecOf(raw: unknown): ProjectSpec {
  const result = validateProject(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.project;
}

describe("handlers", () => {
  it("live on the world, rooms, props and spawns", () => {
    let p = stocked();
    const handler = { on: { type: "roomEntered" }, do: [{ type: "setFlag", flag: "seen" }] };
    p = ok(op(p, "addHandler", { handler }));
    p = ok(op(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomCleared" }, do: [{ type: "setFlag", flag: "open" }] } }));
    p = ok(op(p, "addHandler", { roomId: "arena", propId: "gate", handler: { on: { type: "interact" }, when: [{ type: "item", item: "key" }], do: [{ type: "takeItem", item: "key" }, { type: "setFlag", flag: "open" }] } }));
    p = ok(op(p, "addHandler", { roomId: "arena", spawnId: "charger_1", handler: { on: { type: "enemyKilled" }, do: [{ type: "giveItem", item: "key" }, { type: "shake" }] } }));
    const arena = p.world.rooms[0]!;
    expect(p.world.handlers).toEqual([{ on: { type: "roomEntered" }, when: [], do: [{ type: "setFlag", flag: "seen", value: true }] }]);
    expect(arena.handlers[0]!.on.type).toBe("roomCleared");
    expect(arena.props[0]!.handlers[0]!.when).toEqual([{ type: "item", item: "key", atLeast: 1 }]);
    expect(arena.spawns.find((s) => s.id === "charger_1")!.handlers[0]!.do[1]).toEqual({ type: "shake", strength: 8, seconds: 0.3 });
    p = ok(op(p, "removeHandler", { index: 0 }));
    expect(p.world.handlers).toEqual([]);
    p = ok(op(p, "setHandlers", { roomId: "arena", handlers: [] }));
    expect(p.world.rooms[0]!.handlers).toEqual([]);
  });

  it("name things that exist, and keep prop events on props", () => {
    const p = stocked();
    const fails = (input: unknown) => {
      const result = op(p, "addHandler", input);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.error.message + JSON.stringify(result.error.issues);
    };
    expect(fails({ handler: { on: { type: "roomEntered" }, do: [{ type: "giveItem", item: "gem" }] } })).toContain('unknown item "gem"');
    expect(fails({ handler: { on: { type: "roomEntered" }, do: [{ type: "showModal", modal: "nope" }] } })).toContain('unknown modal "nope"');
    expect(fails({ handler: { on: { type: "roomEntered", room: "attic" }, do: [{ type: "saveRun" }] } })).toContain('unknown room "attic"');
    expect(fails({ handler: { on: { type: "touch" }, do: [{ type: "saveRun" }] } })).toContain("prop event");
    expect(fails({ handler: { on: { type: "roomEntered" }, when: [{ type: "not", of: { type: "item", item: "gem" } }], do: [{ type: "saveRun" }] } })).toContain('unknown item "gem"');
    expect(fails({ roomId: "arena", handler: { on: { type: "enemyKilled", spawn: "ghost_1" }, do: [{ type: "saveRun" }] } })).toContain('unknown spawn "ghost_1"');
    expect(fails({ roomId: "arena", propId: "nope", handler: { on: { type: "touch" }, do: [{ type: "saveRun" }] } })).toContain('no prop "nope"');
    expect(fails({ handler: { on: { type: "roomEntered" }, do: [] } })).toBeTruthy();
    expect(fails({ handler: { on: { type: "explode" }, do: [{ type: "saveRun" }] } })).toBeTruthy();
  });

  it("are linted for flags never set and timers never started", () => {
    let p = stocked(); // the gate's solid reads flag "open"
    const lint = (project: ProjectSpec) => lintProject(project).filter((w) => w.code !== "modal_unused"); // stocked()'s modal is shown by nothing
    expect(lint(p).map((w) => w.code)).toEqual(["flag_never_set"]);
    p = ok(op(p, "addHandler", { handler: { on: { type: "timer", timer: "t" }, do: [{ type: "setFlag", flag: "open" }] } }));
    expect(lint(p).map((w) => w.code)).toEqual(["timer_never_started"]);
    p = ok(op(p, "addHandler", { handler: { on: { type: "gameStarted" }, do: [{ type: "startTimer", timer: "t", seconds: 2 }] } }));
    expect(lint(p)).toEqual([]);
  });

  it("list every event and effect type the runtime must implement", () => {
    expect(GAME_EVENT_TYPES).toContain("enemyKilled");
    expect(EFFECT_TYPES).toEqual(expect.arrayContaining(["setFlag", "showModal", "shake", "respawn"]));
  });
});

describe("conditional spawns", () => {
  it("spawn only while their condition holds, naming real things", () => {
    let p = ok(op(stocked(), "setSpawnCondition", { roomId: "arena", spawnId: "charger_1", when: { type: "flag", flag: "charger_beaten", is: false } }));
    expect(p.world.rooms[0]!.spawns.find((s) => s.id === "charger_1")!.when).toEqual({ type: "flag", flag: "charger_beaten", is: false });
    expect(lintProject(p).map((w) => w.message).join()).toContain('flag "charger_beaten" is checked but nothing sets it');
    expect(op(p, "setSpawnCondition", { roomId: "arena", spawnId: "charger_1", when: { type: "item", item: "gem" } }).ok).toBe(false);
    p = ok(op(p, "setSpawnCondition", { roomId: "arena", spawnId: "charger_1", when: null }));
    expect(p.world.rooms[0]!.spawns.find((s) => s.id === "charger_1")!.when).toBeNull();
  });
});

describe("game rules are presets", () => {
  it("compile to handlers sent before the world's own", () => {
    const p = withWorld(createDefaultProject(), { handlers: [{ on: { type: "gameStarted" }, when: [], do: [{ type: "saveRun" }] }] });
    const sent = toRuntimeProject(p).world.handlers;
    expect(sent.at(-1)!.on.type).toBe("gameStarted");
    expect(sent.slice(0, -1)).toEqual(ruleHandlers(p.world.rules));
    expect(ruleHandlers({ onDeath: "checkpoint", save: "never", hazardDamage: 0 })).toEqual([
      { on: { type: "playerDied" }, when: [], do: [{ type: "respawn", at: "checkpoint" }, { type: "heal", amount: null }] },
      { on: { type: "hazardTouched" }, when: [], do: [{ type: "returnToSafeGround" }] },
    ]);
    expect(ruleHandlers({ onDeath: "room", save: "room", hazardDamage: 2 }).map((h) => h.on.type)).toEqual(["playerDied", "hazardTouched", "roomEntered", "roomSettled"]);
  });
});

describe("schema v7", () => {
  it("older projects load with no props, items, modals or handlers", () => {
    const old = legacy(createDefaultProject(), 5);
    const result = validateProject(migrateProject(old));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const { world } = result.project;
    expect(result.project.schemaVersion).toBe(SCHEMA_VERSION);
    expect([world.handlers, world.items, world.modals, world.map]).toEqual([[], [], [], { enabled: false }]);
    expect(world.rooms[0]).toMatchObject({ props: [], handlers: [] });
    expect(world.rooms[0]!.spawns[0]).toMatchObject({ healthBar: null, handlers: [] });
  });

  it("checks props: unique ids, conditions that name real things, art that exists", () => {
    const p = stocked();
    const arena = p.world.rooms[0]!;
    const gate = arena.props[0]!;
    const bad = (prop: object) => validateProject(withWorld(p, { rooms: [{ ...arena, props: [gate, { ...gate, ...prop }] }] })).ok;
    expect(bad({ id: "gate_2" })).toBe(true);
    expect(bad({})).toBe(false); // duplicate id
    expect(bad({ id: "gate_2", visible: { type: "item", item: "gem" } })).toBe(false);
    expect(bad({ id: "gate_2", art: { biome: "cave", piece: "rock" } })).toBe(false);
  });
});
