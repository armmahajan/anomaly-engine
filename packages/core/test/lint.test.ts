import { describe, expect, it } from "vitest";
import { createDefaultProject, lintProject, newEnemyCharacter, type ProjectSpec } from "../src/index.ts";

const codes = (p: ProjectSpec) => lintProject(p).map((w) => w.code);

describe("lintProject", () => {
  it("finds nothing wrong with the default project", () => {
    expect(lintProject(createDefaultProject())).toEqual([]);
  });

  it("flags spawns outside their room or embedded in platforms", () => {
    const project = createDefaultProject();
    project.world.rooms[0]!.spawns.push({ id: "lost", characterId: "crawler", x: 5000, y: 660, when: null, healthBar: null, handlers: [] });
    project.world.rooms[0]!.spawns.push({ id: "stuck", characterId: "crawler", x: 800, y: 690, when: null, healthBar: null, handlers: [] }); // inside the floor
    project.world.rooms[0]!.spawns.push({ id: "on_ledge", characterId: "crawler", x: 450, y: 530, when: null, healthBar: null, handlers: [] }); // resting on a platform: fine
    const warnings = lintProject(project);
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ["spawn_out_of_bounds", "world.rooms.0.spawns.2"],
      ["spawn_inside_platform", "world.rooms.0.spawns.3"],
    ]);
    expect(warnings[1]?.message).toContain("y = 672");
    project.world.playtest = { room: "arena", x: 800, y: 690, abilities: [] };
    expect(lintProject(project).map((w) => w.path)).toContain("world.playtest");
  });

  it("flags enemies with no spawn", () => {
    const project = createDefaultProject();
    project.characters.push(newEnemyCharacter("ghost", "Ghost"));
    expect(codes(project)).toEqual(["unplaced_character"]);
  });

  it("flags unreachable and endless states", () => {
    const project = createDefaultProject();
    const charger = project.characters.find((c) => c.id === "charger");
    if (charger?.kind !== "enemy") throw new Error();
    charger.behavior.states.orphan = { action: { type: "wait" }, transitions: [] };
    charger.behavior.states.charge!.transitions = [];
    expect(lintProject(project).map((w) => [w.code, w.path])).toEqual([
      ["endless_state", "characters.2.behavior.states.charge"],
      // only `charge` led to `recover`, so it is cut off too
      ["unreachable_state", "characters.2.behavior.states.recover"],
      ["unreachable_state", "characters.2.behavior.states.orphan"],
    ]);
  });

  it("counts interrupts as ways in and out, and flags movement mismatches", () => {
    const project = createDefaultProject();
    const charger = project.characters.find((c) => c.id === "charger");
    if (charger?.kind !== "enemy") throw new Error();
    charger.behavior.states.charge!.transitions = [];
    charger.behavior.states.float = { action: { type: "hover", amplitude: 10, period: 2 }, transitions: [] };
    charger.behavior.interrupts = [{ when: { type: "playerBeyond", distance: 900 }, to: "float" }];
    expect(lintProject(project).map((w) => [w.code, w.path])).toEqual([
      ["unreachable_state", "characters.2.behavior.states.recover"],
      ["movement_mismatch", "characters.2.behavior.states.float"],
    ]);
  });
});
