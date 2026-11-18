import { describe, expect, it } from "vitest";
import { applyOperation, createDefaultProject, updateCharacter, validateProject, type ProjectSpec } from "../src/index.ts";

function runSpeed(project: ProjectSpec): number {
  const c = project.characters.find((c) => c.id === "player");
  if (c?.kind !== "player") throw new Error("expected player");
  return c.stats.runSpeed;
}

describe("validateProject", () => {
  it("accepts the default project", () => {
    expect(validateProject(createDefaultProject()).ok).toBe(true);
  });

  it("rejects spawns of unknown characters", () => {
    const project = createDefaultProject();
    project.world.rooms[0]!.spawns.push({ id: "ghost_1", characterId: "ghost", x: 0, y: 0, when: null, healthBar: null, handlers: [] });
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe("world.rooms.0.spawns.2.characterId");
  });

  it("rejects duplicate character ids", () => {
    const project = createDefaultProject();
    project.characters.push({ ...project.characters[1]! });
    expect(validateProject(project).ok).toBe(false);
  });

  it("requires exactly one player character, never spawned in a room", () => {
    const project = createDefaultProject();
    expect(validateProject({ ...project, characters: project.characters.slice(1) }).ok).toBe(false);
    project.world.rooms[0]!.spawns.push({ id: "player_1", characterId: "player", x: 100, y: 672, when: null, healthBar: null, handlers: [] });
    expect(validateProject(project).ok).toBe(false);
  });

  it("needs the playtest room to exist", () => {
    const project = createDefaultProject();
    expect(validateProject({ ...project, world: { ...project.world, playtest: { room: "nowhere", x: 0, y: 0, abilities: [] } } }).ok).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(validateProject({ ...createDefaultProject(), extra: true }).ok).toBe(false);
  });
});

describe("updateCharacter", () => {
  it("updates a stat and bumps the revision", () => {
    const before = createDefaultProject();
    const result = updateCharacter(before, { characterId: "player", changes: { stats: { runSpeed: 150 } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(runSpeed(result.project)).toBe(150);
    expect(result.project.revision).toBe(before.revision + 1);
  });

  it("updates enemy stats without touching the behavior", () => {
    const before = createDefaultProject();
    const result = updateCharacter(before, { characterId: "charger", changes: { stats: { knockback: 900 } } });
    if (!result.ok) throw new Error(result.error.message);
    const charger = result.project.characters.find((c) => c.id === "charger");
    const original = before.characters.find((c) => c.id === "charger")!;
    expect(charger).toEqual({ ...original, stats: { ...original.stats, knockback: 900 } });
  });

  it("keeps unchanged stats and does not mutate the input project", () => {
    const before = createDefaultProject();
    const snapshot = structuredClone(before);
    const result = updateCharacter(before, { characterId: "player", changes: { stats: { runSpeed: 150 } } });
    expect(before).toEqual(snapshot);
    if (!result.ok) throw new Error("expected success");
    const player = result.project.characters.find((c) => c.id === "player");
    expect(player?.stats).toMatchObject({ runSpeed: 150, jumpVelocity: 760, health: 5 });
  });

  it.each([
    ["negative", -5],
    ["too large", 5000],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "fast"],
  ])("rejects a %s speed and leaves the project untouched", (_label, value) => {
    const before = createDefaultProject();
    const result = updateCharacter(before, { characterId: "player", changes: { stats: { runSpeed: value } } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_input");
    expect(result.error.issues[0]?.path).toBe("changes.stats.runSpeed");
    expect(runSpeed(before)).toBe(320);
  });

  it("rejects stats that belong to a different kind of character", () => {
    const result = updateCharacter(createDefaultProject(), {
      characterId: "player",
      changes: { stats: { knockback: 100 } },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown characters", () => {
    const result = updateCharacter(createDefaultProject(), { characterId: "ghost", changes: { name: "Boo" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("rejects malformed input", () => {
    for (const input of [null, "crawler", {}, { characterId: "crawler" }, { characterId: "crawler", changes: { hp: 3 } }]) {
      const result = updateCharacter(createDefaultProject(), input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_input");
    }
  });

  it("validates non-stat fields too", () => {
    const result = updateCharacter(createDefaultProject(), { characterId: "crawler", changes: { color: "red" } });
    expect(result.ok).toBe(false);
  });

  it("applies successive edits", () => {
    let project = createDefaultProject();
    for (const speed of [150, 90, 300]) {
      const result = updateCharacter(project, { characterId: "player", changes: { stats: { runSpeed: speed } } });
      if (!result.ok) throw new Error(result.error.message);
      project = result.project;
    }
    expect(runSpeed(project)).toBe(300);
    expect(project.revision).toBe(3);
  });
});

describe("large batches", () => {
  it("an AI turn that builds several rooms (hundreds of operations) saves as one batch; an oversized one says why", async () => {
    const { applyBatch, createDefaultProject, MAX_BATCH_SIZE } = await import("../src/index.ts");
    const project = createDefaultProject();
    const rooms = Array.from({ length: 40 }, (_, i) => ({ name: "createWorldRoom", input: { name: `Room ${i}`, id: `room_${i}`, cols: 30, rows: 14 } }));
    const tiles = rooms.flatMap((_, i) => Array.from({ length: 4 }, (_, j) => ({ name: "paintTiles", input: { roomId: `room_${i}`, kind: "ledge", area: { col: 4 + j * 5, row: 9, cols: 3, rows: 1 } } })));
    const result = applyBatch(project, [...rooms, ...tiles]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.project.revision).toBe(project.revision + 1);
    const tooMany = applyBatch(project, Array.from({ length: MAX_BATCH_SIZE + 1 }, () => rooms[0]));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.message).toContain(`at most ${MAX_BATCH_SIZE} operations (this one has ${MAX_BATCH_SIZE + 1})`);
  });
});

describe("renameProject", () => {
  it("renames the game (trimmed) and rejects an empty or overlong name", () => {
    const project = createDefaultProject();
    const renamed = applyOperation(project, "renameProject", { name: "  Neon Echoes " });
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(renamed.project.name).toBe("Neon Echoes");
      expect(renamed.project.revision).toBe(project.revision + 1);
    }
    expect(applyOperation(project, "renameProject", { name: "   " }).ok).toBe(false);
    expect(applyOperation(project, "renameProject", { name: "x".repeat(121) }).ok).toBe(false);
    expect(applyOperation(project, "renameProject", { title: "X" }).ok).toBe(false);
  });
});
