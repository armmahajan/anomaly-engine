import { describe, expect, it } from "vitest";
import {
  addSpawn,
  applyBatch,
  createCharacter,
  createDefaultProject,
  deleteCharacter,
  duplicateCharacter,
  migrateProject,
  moveSpawn,
  newEnemyCharacter,
  removeSpawn,
  slugify,
  uniqueId,
  validateProject,
  type OperationResult,
  type ProjectSpec,
} from "../src/index.ts";

function ok(result: OperationResult): ProjectSpec {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.project;
}

const ids = (p: ProjectSpec) => p.characters.map((c) => c.id);
const spawnIds = (p: ProjectSpec) => p.sandbox.spawns.map((s) => s.id);

describe("createCharacter", () => {
  it("adds an enemy type without placing it", () => {
    const project = ok(createCharacter(createDefaultProject(), { character: newEnemyCharacter("bat", "Bat") }));
    expect(ids(project)).toContain("bat");
    expect(project.sandbox.spawns.some((s) => s.characterId === "bat")).toBe(false);
    expect(project.revision).toBe(1);
  });

  it("rejects duplicate ids, players, and invalid characters", () => {
    const base = createDefaultProject();
    expect(createCharacter(base, { character: newEnemyCharacter("charger", "Again") })).toMatchObject({ ok: false });
    expect(createCharacter(base, { character: { ...base.characters[0], id: "player_two" } })).toMatchObject({ ok: false });
    const noBehavior = { ...newEnemyCharacter("blob", "Blob"), behavior: undefined };
    const result = createCharacter(base, { character: noBehavior });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    if (!result.ok) expect(result.error.issues[0]?.path).toBe("character.behavior");
  });
});

describe("deleteCharacter", () => {
  it("removes the character and all its spawns", () => {
    let project = ok(addSpawn(createDefaultProject(), { characterId: "charger", x: 900, y: 660 }));
    expect(project.sandbox.spawns.filter((s) => s.characterId === "charger")).toHaveLength(2);
    project = ok(deleteCharacter(project, { characterId: "charger" }));
    expect(ids(project)).not.toContain("charger");
    expect(project.sandbox.spawns.some((s) => s.characterId === "charger")).toBe(false);
  });

  it("refuses to delete the player or unknown characters", () => {
    expect(deleteCharacter(createDefaultProject(), { characterId: "player" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(deleteCharacter(createDefaultProject(), { characterId: "ghost" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("duplicateCharacter", () => {
  it("copies everything under a new id, independent of the original", () => {
    const base = createDefaultProject();
    const project = ok(duplicateCharacter(base, { characterId: "charger", newId: "fast_charger", name: "Fast Charger" }));
    const original = project.characters.find((c) => c.id === "charger")!;
    const copy = project.characters.find((c) => c.id === "fast_charger")!;
    expect(copy).toEqual({ ...original, id: "fast_charger", name: "Fast Charger" });
    expect(copy).not.toBe(original);
    if (copy.kind !== "enemy") throw new Error("expected enemy");
    (copy.behavior.states.charge!.action as { speed: number }).speed = 1; // deep copy: original unaffected
    expect(base.characters.find((c) => c.id === "charger")).toEqual(original);
  });

  it("defaults the name and rejects taken ids and the player", () => {
    const project = ok(duplicateCharacter(createDefaultProject(), { characterId: "crawler", newId: "crawler_b" }));
    expect(project.characters.at(-1)?.name).toBe("Crawler copy");
    expect(duplicateCharacter(project, { characterId: "crawler", newId: "crawler_b" })).toMatchObject({ ok: false });
    expect(duplicateCharacter(project, { characterId: "player", newId: "p2" })).toMatchObject({ ok: false });
  });
});

describe("spawns", () => {
  it("adds with generated or explicit ids", () => {
    let project = ok(addSpawn(createDefaultProject(), { characterId: "charger", x: 900, y: 660 }));
    expect(spawnIds(project)).toContain("charger_2");
    project = ok(addSpawn(project, { characterId: "charger", x: 1000, y: 660, spawnId: "ambush" }));
    expect(spawnIds(project)).toContain("ambush");
    expect(addSpawn(project, { characterId: "charger", x: 0, y: 0, spawnId: "ambush" })).toMatchObject({ ok: false });
    expect(addSpawn(project, { characterId: "ghost", x: 0, y: 0 })).toMatchObject({ error: { code: "not_found" } });
  });

  it("rejects a second player spawn and out-of-range positions", () => {
    expect(addSpawn(createDefaultProject(), { characterId: "player", x: 300, y: 660 })).toMatchObject({
      ok: false,
      error: { code: "invalid_result" },
    });
    expect(addSpawn(createDefaultProject(), { characterId: "charger", x: 99_999, y: 0 })).toMatchObject({ ok: false });
  });

  it("moves one axis at a time", () => {
    const project = ok(moveSpawn(createDefaultProject(), { spawnId: "charger_1", x: 700 }));
    expect(project.sandbox.spawns.find((s) => s.id === "charger_1")).toMatchObject({ x: 700, y: 672 });
    expect(moveSpawn(project, { spawnId: "nope", x: 1 })).toMatchObject({ error: { code: "not_found" } });
  });

  it("removes enemy spawns but not the only player spawn", () => {
    const project = ok(removeSpawn(createDefaultProject(), { spawnId: "charger_1" }));
    expect(spawnIds(project)).not.toContain("charger_1");
    expect(ids(project)).toContain("charger"); // the type still exists
    expect(removeSpawn(project, { spawnId: "player_1" })).toMatchObject({ ok: false, error: { code: "invalid_result" } });
  });
});

describe("applyBatch", () => {
  const createAndPlace = [
    { name: "createCharacter", input: { character: newEnemyCharacter("lurker", "Lurker") } },
    {
      name: "setBehavior",
      input: {
        characterId: "lurker",
        behavior: {
          initial: "idle",
          states: {
            idle: { action: { type: "wait" }, transitions: [{ when: { type: "playerWithin", distance: 200 }, to: "chase" }] },
            chase: { action: { type: "chase", speed: 150 }, transitions: [] },
          },
        },
      },
    },
    { name: "addSpawn", input: { characterId: "lurker", x: 1000, y: 660, spawnId: "lurker_1" } },
  ];

  it("applies every step, later steps seeing earlier ones, as one revision", () => {
    const project = ok(applyBatch(createDefaultProject(), createAndPlace));
    expect(project.revision).toBe(1);
    expect(spawnIds(project)).toContain("lurker_1");
    const lurker = project.characters.find((c) => c.id === "lurker");
    expect(lurker?.kind === "enemy" && lurker.behavior.initial).toBe("idle");
  });

  it("is all-or-nothing and reports which step failed", () => {
    const base = createDefaultProject();
    const broken = [...createAndPlace.slice(0, 2), { name: "addSpawn", input: { characterId: "lurker", x: "left", y: 660 } }];
    const result = applyBatch(base, broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("batch step 3 (addSpawn) failed");
    expect(result.error.issues[0]?.path).toBe("ops.2.input.x");
    expect(base).toEqual(createDefaultProject());
  });

  it("rejects empty, oversized, and malformed batches, and unknown operations", () => {
    const base = createDefaultProject();
    expect(applyBatch(base, [])).toMatchObject({ ok: false });
    expect(applyBatch(base, "createCharacter")).toMatchObject({ ok: false });
    const move = { name: "moveSpawn", input: { spawnId: "charger_1", x: 600 } };
    expect(applyBatch(base, Array.from({ length: 51 }, () => move))).toMatchObject({ ok: false });
    expect(applyBatch(base, [{ name: "applyBatch", input: [] }])).toMatchObject({ ok: false });
  });
});

describe("spawn ids (schema v3)", () => {
  it("rejects duplicate spawn ids", () => {
    const project = createDefaultProject();
    project.sandbox.spawns.push({ ...project.sandbox.spawns[2]!, x: 900 });
    expect(validateProject(project).ok).toBe(false);
  });

  it("migrates v2 spawns to stable ids", () => {
    const base = createDefaultProject();
    const v2 = {
      ...base,
      schemaVersion: 2,
      sandbox: {
        ...base.sandbox,
        spawns: [
          { characterId: "player", x: 1, y: 2 },
          { characterId: "charger", x: 3, y: 4 },
          { characterId: "charger", x: 5, y: 6 },
        ],
      },
    };
    const result = validateProject(migrateProject(v2));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(spawnIds(result.project)).toEqual(["player_1", "charger_1", "charger_2"]);
  });
});

describe("id helpers", () => {
  it("slugifies names into valid ids", () => {
    expect(slugify("Fast Crawler!")).toBe("fast_crawler");
    expect(slugify("42 Bats")).toBe("bats");
    expect(slugify("!!!", "enemy")).toBe("enemy");
  });

  it("finds the first free id", () => {
    expect(uniqueId("enemy", [])).toBe("enemy");
    expect(uniqueId("enemy", ["enemy", "enemy_2"])).toBe("enemy_3");
  });
});
