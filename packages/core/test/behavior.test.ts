import { legacy } from "./legacy.ts";
import { describe, expect, it } from "vitest";
import {
  ACTION_TYPES,
  CONDITION_TYPES,
  createDefaultProject,
  migrateProject,
  SCHEMA_VERSION,
  setBehavior,
  updateBehavior,
  validateProject,
  type Behavior,
  type ProjectSpec,
} from "../src/index.ts";

function behaviorOf(project: ProjectSpec, id: string): Behavior {
  const c = project.characters.find((c) => c.id === id);
  if (c?.kind !== "enemy") throw new Error(`${id} is not an enemy`);
  return c.behavior;
}

/** Mutate a copy of the charger's behavior and validate the whole project. */
function validateWithChargerBehavior(edit: (b: Behavior & Record<string, unknown>) => void) {
  const project = createDefaultProject();
  edit(behaviorOf(project, "charger") as Behavior & Record<string, unknown>);
  return validateProject(project);
}

describe("behavior schema", () => {
  it("lists the primitive types the runtime must implement", () => {
    expect(ACTION_TYPES).toEqual(["patrol", "wait", "chase", "charge", "telegraph", "retreat", "returnHome", "jump", "hover"]);
    expect(CONDITION_TYPES).toEqual([
      "playerWithin",
      "playerBeyond",
      "after",
      "hitWall",
      "actionDone",
      "atLedge",
      "onGround",
      "airborne",
      "playerAbove",
      "playerBelow",
      "playerLevel",
      "playerInFront",
      "playerBehind",
      "canSeePlayer",
      "wasHit",
      "healthBelow",
      "chance",
    ]);
  });

  it("rejects transitions to unknown states", () => {
    const result = validateWithChargerBehavior((b) => {
      b.states.windup!.transitions[0]!.to = "pounce";
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('unknown state "pounce"');
  });

  it("rejects a missing initial state", () => {
    expect(validateWithChargerBehavior((b) => void (b.initial = "sleep")).ok).toBe(false);
  });

  it("rejects an empty state machine", () => {
    expect(
      validateWithChargerBehavior((b) => {
        b.initial = "x";
        b.states = {};
      }).ok,
    ).toBe(false);
  });

  it("rejects unknown primitives, bad params, and extra params", () => {
    const cases: ((b: Behavior) => void)[] = [
      (b) => void ((b.states.charge!.action as { type: string }).type = "teleport"),
      (b) => void ((b.states.charge!.action as { speed: number }).speed = -10),
      (b) => void ((b.states.charge!.action as Record<string, unknown>).damage = 5),
      (b) => void ((b.states.windup!.action as { color: string }).color = "yellow"),
      (b) => void ((b.states.patrol!.transitions[0]!.when as { type: string }).type = "playerNear"),
    ];
    for (const edit of cases) expect(validateWithChargerBehavior(edit).ok).toBe(false);
  });
});

describe("updateBehavior", () => {
  it("changes one action param, leaving everything else alone", () => {
    const before = createDefaultProject();
    const result = updateBehavior(before, { characterId: "charger", stateId: "charge", action: { speed: 400 } });
    if (!result.ok) throw new Error(result.error.message);
    const after = behaviorOf(result.project, "charger");
    expect(after.states.charge!.action).toEqual({ type: "charge", speed: 400, direction: "horizontal" });
    expect({ ...after, states: { ...after.states, charge: undefined } }).toEqual({
      ...behaviorOf(before, "charger"),
      states: { ...behaviorOf(before, "charger").states, charge: undefined },
    });
    expect(result.project.revision).toBe(1);
  });

  it("changes a transition's condition param by index", () => {
    const result = updateBehavior(createDefaultProject(), {
      characterId: "charger",
      stateId: "windup",
      transitions: [{ index: 0, when: { seconds: 1.5 } }],
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(behaviorOf(result.project, "charger").states.windup!.transitions[0]).toEqual({
      when: { type: "after", seconds: 1.5 },
      to: "charge",
    });
  });

  it("edits and appends a transition's extra `and` conditions by position", () => {
    const result = updateBehavior(createDefaultProject(), {
      characterId: "charger",
      stateId: "patrol",
      transitions: [{ index: 0, and: [{ margin: 80 }, { type: "canSeePlayer" }] }],
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(behaviorOf(result.project, "charger").states.patrol!.transitions[0]).toEqual({
      when: { type: "playerWithin", distance: 260 },
      and: [{ type: "playerLevel", margin: 80 }, { type: "canSeePlayer" }],
      to: "windup",
    });
  });

  it("replaces the action when the type changes", () => {
    const result = updateBehavior(createDefaultProject(), {
      characterId: "charger",
      stateId: "recover",
      action: { type: "chase", speed: 90 },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(behaviorOf(result.project, "charger").states.recover!.action).toEqual({ type: "chase", speed: 90, stopDistance: 0 });
  });

  it("rejects a type change with missing params", () => {
    const result = updateBehavior(createDefaultProject(), {
      characterId: "charger",
      stateId: "recover",
      action: { type: "chase" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it.each([
    ["unknown character", { characterId: "ghost", stateId: "patrol", action: { speed: 1 } }, "not_found"],
    ["player character", { characterId: "player", stateId: "patrol", action: { speed: 1 } }, "invalid_input"],
    ["unknown state", { characterId: "charger", stateId: "dance", action: { speed: 1 } }, "not_found"],
    ["bad transition index", { characterId: "charger", stateId: "windup", transitions: [{ index: 3, when: {} }] }, "not_found"],
    ["dangling target", { characterId: "charger", stateId: "windup", transitions: [{ index: 0, to: "nowhere" }] }, "invalid_input"],
    ["invalid value", { characterId: "charger", stateId: "charge", action: { speed: -1 } }, "invalid_input"],
    ["malformed input", { characterId: "charger" }, "invalid_input"],
  ])("rejects %s", (_label, input, code) => {
    expect(updateBehavior(createDefaultProject(), input)).toMatchObject({ ok: false, error: { code } });
  });
});

describe("interrupts", () => {
  const withInterrupt = () => {
    const project = createDefaultProject();
    const charger = project.characters.find((c) => c.id === "charger");
    if (charger?.kind !== "enemy") throw new Error();
    charger.behavior.interrupts = [{ when: { type: "playerBeyond", distance: 900 }, to: "recover" }];
    return project;
  };

  it("are validated and editable by index", () => {
    const result = updateBehavior(withInterrupt(), { characterId: "charger", interrupts: [{ index: 0, when: { distance: 700 } }] });
    expect(result.ok && behaviorOf(result.project, "charger").interrupts).toEqual([
      { when: { type: "playerBeyond", distance: 700 }, to: "recover" },
    ]);
    expect(updateBehavior(withInterrupt(), { characterId: "charger", interrupts: [{ index: 0, to: "nowhere" }] })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });
});

describe("setBehavior", () => {
  const chaser: Behavior = {
    initial: "idle",
    states: {
      idle: { action: { type: "wait" }, transitions: [{ when: { type: "playerWithin", distance: 300 }, to: "chase" }] },
      chase: {
        action: { type: "chase", speed: 200, stopDistance: 0 },
        transitions: [{ when: { type: "playerBeyond", distance: 400 }, to: "idle" }],
      },
    },
    interrupts: [],
  };

  it("replaces a whole behavior", () => {
    const result = setBehavior(createDefaultProject(), { characterId: "crawler", behavior: chaser });
    if (!result.ok) throw new Error(result.error.message);
    expect(behaviorOf(result.project, "crawler")).toEqual(chaser);
  });

  it("rejects an invalid behavior without changing anything", () => {
    const broken = { ...chaser, initial: "missing" };
    expect(setBehavior(createDefaultProject(), { characterId: "crawler", behavior: broken })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });
});

describe("migrateProject", () => {
  it("upgrades a v1 project's patrol stats into a behavior", () => {
    const v1 = {
      ...legacy(createDefaultProject(), 1),
      characters: [
        createDefaultProject().characters[0],
        {
          id: "crawler",
          kind: "enemy",
          name: "Crawler",
          color: "#c0504d",
          size: { width: 40, height: 28 },
          stats: { patrolSpeed: 150, patrolDistance: 300 },
        },
      ],
    };
    // v1 spawns had no ids.
    v1.sandbox.spawns = v1.sandbox.spawns
      .filter((s: { characterId: string }) => s.characterId !== "charger")
      .map(({ id: _id, ...rest }: { id: string }) => rest);

    const result = validateProject(migrateProject(v1));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.project.world.rooms[0]!.spawns.map((s) => s.id)).toEqual(["crawler_1"]);
    expect(result.project.characters[1]).toMatchObject({
      stats: { knockback: 350 },
      behavior: { initial: "patrol", states: { patrol: { action: { type: "patrol", speed: 150, distance: 300 } } } },
    });
  });

  it("leaves current projects alone", () => {
    expect(migrateProject(createDefaultProject())).toEqual(createDefaultProject());
  });
});
