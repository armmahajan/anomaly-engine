import { legacy } from "./legacy.ts";
import { describe, expect, it } from "vitest";
import {
  migrateProject,
  applyOperation,
  createDefaultProject,
  movementModel,
  movementParams,
  validateProject,
  type MovementAbility,
  type PlayerCharacter,
  type ProjectSpec,
} from "../src/index.ts";

const project = createDefaultProject();
const player = project.characters[0] as PlayerCharacter;
const params = movementParams(player, project.world.gravity);
const model = (...abilities: MovementAbility[]) => movementModel(params, abilities);
const heights = [-280, -150, 0, 100, 300];

describe("movement model", () => {
  it("knows the exact jump height and how abilities extend it", () => {
    // 60 fps: the first frame moves at full speed, then gravity takes 30 px/s a frame.
    const frames = Math.floor(params.jumpVelocity / (params.gravity / 60));
    const exact = (params.jumpVelocity * (frames + 1) - (params.gravity / 60) * ((frames * (frames + 1)) / 2)) / 60;
    expect(model().maxHeight).toBeCloseTo(exact, 6);
    expect(model("double_jump").maxHeight).toBeGreaterThan(model().maxHeight + 120);
    expect(model("dash", "glide").maxHeight).toBe(model().maxHeight);
  });

  it("only ever widens reach: lower landings, and more abilities", () => {
    for (const abilities of [[], ["dash"], ["double_jump", "glide"]] as MovementAbility[][]) {
      const gaps = heights.map((dy) => model(...abilities).maxGap(dy));
      expect(gaps).toEqual([...gaps].sort((a, b) => a - b));
    }
    for (const dy of heights) {
      expect(model("dash").maxGap(dy)).toBeGreaterThanOrEqual(model().maxGap(dy));
      expect(model("dash", "double_jump", "glide").maxGap(dy)).toBeGreaterThanOrEqual(model("dash", "double_jump").maxGap(dy));
    }
    expect(model().maxGap(-model().maxHeight - 10)).toBe(-Infinity);
    expect(model().canCross(model().maxGap(0), 0)).toBe(true);
    expect(model().canCross(model().maxGap(0) + 1, 0)).toBe(false);
  });

  it("gates are real: each ability crosses something the others can't", () => {
    const gap = model().maxGap(0) + 40;
    expect([model().canCross(gap, 0), model("dash").canCross(gap, 0), model("glide").canCross(gap, 0)]).toEqual([false, true, true]);
    const ledge = -(model().maxHeight + 40);
    expect([model().canCross(60, ledge), model("double_jump").canCross(60, ledge), model("dash").canCross(60, ledge)]).toEqual([false, true, false]);
    expect([model().climbsWalls, model("wall_jump").climbsWalls, model("wall_jump").wallJumpGain > 50]).toEqual([false, true, true]);
    expect([model().breaksFloors, model("ground_pound").breaksFloors]).toEqual([false, true]);
  });

  it("follows the tuning", () => {
    const longDash = movementParams({ ...player, abilities: { ...player.abilities, dash: { ...player.abilities.dash, distance: 400 } } }, project.world.gravity);
    expect(movementModel(longDash, ["dash"]).maxGap(0)).toBeGreaterThan(model("dash").maxGap(0) + 150);
    expect(model("dash").dashDistance).toBe(220);
    expect(model("dash", "glide")).toBe(model("glide", "dash"));
  });
});

const apply = (p: ProjectSpec, name: string, input: unknown) => {
  const result = applyOperation(p, name, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.project;
};

describe("ability operations", () => {
  it("choose the playtest's abilities", () => {
    expect(apply(project, "setPlaytest", { abilities: ["dash", "glide", "dash"] }).world.playtest?.abilities).toEqual(["dash", "glide"]);
    const bad = applyOperation(project, "setPlaytest", { abilities: ["swim"] });
    expect(bad.ok).toBe(false);
  });

  it("tune the player's abilities, keeping everything not named", () => {
    const tuned = apply(project, "updateCharacter", { characterId: "player", changes: { abilities: { dash: { distance: 300 } }, stats: { coyoteTime: 0.15 } } });
    const after = tuned.characters[0] as PlayerCharacter;
    expect(after.abilities.dash).toEqual({ distance: 300, duration: 0.2, cooldown: 0.45 });
    expect(after.abilities.glide).toEqual(player.abilities.glide);
    expect(after.stats.coyoteTime).toBe(0.15);
    expect(applyOperation(project, "updateCharacter", { characterId: "crawler", changes: { abilities: { dash: { distance: 300 } } } }).ok).toBe(false);
    expect(applyOperation(project, "updateCharacter", { characterId: "player", changes: { abilities: { dash: { distance: 9999 } } } }).ok).toBe(false);
  });

  it("projects saved before abilities load with the defaults", () => {
    const { abilities: _a, ...oldPlayer } = player;
    const { maxFallSpeed: _m, coyoteTime: _c, jumpBuffer: _j, ...oldStats } = player.stats;
    const old = legacy({ ...project, characters: [{ ...oldPlayer, stats: oldStats } as PlayerCharacter, ...project.characters.slice(1)] });
    delete old.sandbox.playerAbilities;
    const result = validateProject(migrateProject(old));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.characters[0]).toEqual(player);
    expect(result.project.world.playtest?.abilities).toEqual([]);
  });
});
