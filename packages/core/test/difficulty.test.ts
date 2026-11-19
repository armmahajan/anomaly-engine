import { describe, expect, it } from "vitest";
import {
  applyOperation,
  checkGame,
  DIFFICULTY_CURVE,
  difficultyStage,
  exampleRig,
  fixtureReferenceProject,
  gameArtPlan,
  lintCombat,
  lintProject,
  ProjectSpec,
  regionDepths,
  scaleEnemy,
  type EnemyCharacter,
  type OperationResult,
} from "../src/index.ts";

function ok(result: OperationResult): ProjectSpec {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}
const enemy = (p: ProjectSpec, id: string) => p.characters.find((c): c is EnemyCharacter => c.id === id && c.kind === "enemy")!;
const spawnsOf = (p: ProjectSpec, room: string) => p.world.rooms.find((r) => r.id === room)!.spawns.map((s) => s.characterId);
const codes = (p: ProjectSpec) => lintProject(p).map((w) => `${w.code}@${w.path}`).sort();

/**
 * The reference game (undercroft -> spire -> summit: depths 0, 1, 2) with a crawler in a
 * room of every region, a mite caller in the spire, and handlers that name the crawler.
 */
function game(): ProjectSpec {
  let p = fixtureReferenceProject();
  const crawler = enemy(p, "crawler");
  const caller: EnemyCharacter = {
    ...structuredClone(crawler),
    id: "caller",
    name: "Caller",
    behavior: {
      initial: "call",
      states: {
        call: { action: { type: "summon", character: "mite", count: 1, max: 2, windup: 0.6, color: "#ffd27a" }, transitions: [{ when: { type: "actionDone" }, to: "rest" }] },
        rest: { action: { type: "wait" }, transitions: [{ when: { type: "after", seconds: 1 }, to: "call" }] },
      },
      interrupts: [],
    },
  };
  const mite: EnemyCharacter = { ...structuredClone(crawler), id: "mite", name: "Mite", stats: { knockback: 200, health: 1, contactDamage: 1 } };
  p = ProjectSpec.parse({ ...p, characters: [...p.characters, caller, mite] });
  const floor = (room: string) => {
    const r = p.world.rooms.find((x) => x.id === room)!;
    const rows = r.grid.rows;
    // The first standable cell from the left on the lowest row with ground.
    for (let y = rows.length - 1; y > 0; y--) {
      for (let x = 2; x < rows[y]!.length - 2; x++) if (rows[y]![x] !== "." && rows[y - 1]![x] === "." && rows[y - 2]?.[x] === ".") return { x: x * 32 + 16, y: y * 32 };
    }
    throw new Error(`no floor in ${room}`);
  };
  for (const [roomId, characterId, spawnId] of [
    ["entrance", "crawler", "c_entrance"],
    ["cistern", "crawler", "c_cistern"],
    ["bridge", "crawler", "c_bridge"],
    ["summit", "crawler", "c_summit"],
    ["bridge", "caller", "caller_1"],
  ] as const) {
    p = ok(applyOperation(p, "addRoomSpawn", { roomId, characterId, spawnId, ...floor(roomId) }));
  }
  return ProjectSpec.parse({
    ...p,
    world: {
      ...p.world,
      handlers: [...p.world.handlers, { on: { type: "enemyKilled", character: "crawler" }, do: [{ type: "giveItem", item: "shell" }] }],
      items: [...p.world.items, { id: "shell", name: "Shell" }],
      rooms: p.world.rooms.map((r) => (r.id === "cistern" ? { ...r, handlers: [...r.handlers, { on: { type: "enemyKilled", character: "crawler" }, do: [{ type: "setFlag", flag: "cistern_crawler" }] }] } : r)),
    },
  });
}

describe("region depth", () => {
  it("follows the progression from the start: spheres first, then distance; the start is 0", () => {
    expect(regionDepths(fixtureReferenceProject())).toEqual({ undercroft: 0, spire: 1, summit: 2 });
  });

  it("puts regions met at the same point at the same depth, and gated ones deeper", () => {
    const base = fixtureReferenceProject();
    const p = ProjectSpec.parse({
      ...base,
      progression: {
        ...base.progression,
        regions: [...base.progression.regions, { id: "side", name: "Side", rooms: 1, enemies: [], status: "canon" }],
        connections: [...base.progression.connections, { id: "to_side", from: "undercroft", to: "side", oneWay: false, requires: [], status: "canon" }],
      },
    });
    // side: no gate, one step from the start (sphere 0, 1 hop); spire needs the key (sphere 1).
    expect(regionDepths(p)).toEqual({ undercroft: 0, side: 1, spire: 2, summit: 3 });
  });
});

describe("scaling an enemy", () => {
  const base: EnemyCharacter = {
    ...enemy(fixtureReferenceProject(), "crawler"),
    stats: { knockback: 300, health: 3, contactDamage: 1 },
    behavior: {
      initial: "walk",
      states: {
        walk: { action: { type: "chase", speed: 200, stopDistance: 0 }, transitions: [{ when: { type: "playerWithin", distance: 80 }, to: "hit" }] },
        hit: {
          action: { type: "strike", windup: 0.4, active: 0.2, recovery: 0.5, damage: 2, width: 64, height: 48, offsetX: 40, lunge: 100, color: "#ffd27a" },
          transitions: [{ when: { type: "actionDone" }, to: "walk" }],
        },
        shoot: {
          action: { type: "shoot", windup: 0.5, count: 1, spread: 30, speed: 400, gravity: 0, aim: "player", angle: 0, lifetime: 3, damage: 1, pogo: false, color: "#ffd27a" },
          transitions: [],
        },
      },
      interrupts: [],
    },
  };
  const at = (d: number) => {
    const s = scaleEnemy(base, d);
    const states = s.behavior.states as unknown as Record<string, { action: Record<string, number> }>;
    return { health: s.stats.health, contact: s.stats.contactDamage, strike: states.hit!.action.damage, shot: states.shoot!.action.damage, speed: states.walk!.action.speed, lunge: states.hit!.action.lunge, shotSpeed: states.shoot!.action.speed, windup: states.hit!.action.windup };
  };

  it("rises with depth: health, contact and attack damage, a little speed; timing, reach and projectiles stay", () => {
    expect(at(0)).toEqual({ health: 3, contact: 1, strike: 2, shot: 1, speed: 200, lunge: 100, shotSpeed: 400, windup: 0.4 });
    expect(at(1)).toEqual({ health: 4, contact: 1, strike: 3, shot: 1, speed: 210, lunge: 100, shotSpeed: 400, windup: 0.4 });
    expect(at(2)).toEqual({ health: 5, contact: 2, strike: 3, shot: 2, speed: 220, lunge: 100, shotSpeed: 400, windup: 0.4 });
    expect(at(3)).toEqual({ health: 6, contact: 2, strike: 4, shot: 2, speed: 230, lunge: 100, shotSpeed: 400, windup: 0.4 });
    // Capped: health x2.5, damage x2, speed x1.2.
    expect(at(10)).toMatchObject({ health: Math.round(3 * DIFFICULTY_CURVE.healthMax), contact: 2, strike: 4, shot: 2, speed: 240 });
    expect(scaleEnemy(base, 0)).toEqual({ stats: base.stats, behavior: base.behavior });
  });

  it("gives even the weakest enemy more health deeper, and leaves harmless ones harmless", () => {
    const weak = { ...base, stats: { knockback: 0, health: 1, contactDamage: 0 } };
    expect(scaleEnemy(weak, 1).stats).toEqual({ knockback: 0, health: 2, contactDamage: 0 });
  });
});

describe("the difficulty stage", () => {
  it("makes a tougher variant per deeper depth, sharing the look, and repoints those spawns", () => {
    const before = game();
    const { project: p, issues, summary } = difficultyStage(before);
    expect(issues).toEqual([]);
    expect(ProjectSpec.safeParse(p).success).toBe(true);

    // The crawler as written stays at depth 0 (the entrance); the spire and summit get variants.
    expect(spawnsOf(p, "entrance")).toEqual(["crawler"]);
    expect(spawnsOf(p, "cistern")).toEqual(["crawler_d1", "crawler_d1"]); // the fixture's own and ours
    expect(spawnsOf(p, "bridge")).toEqual(["crawler_d1", "caller_d1"]);
    expect(spawnsOf(p, "summit")).toEqual(["crawler_d2"]);
    expect(spawnsOf(p, "sanctum")).toEqual(["guardian_d1"]);
    const crawler = enemy(p, "crawler");
    const d1 = enemy(p, "crawler_d1");
    const d2 = enemy(p, "crawler_d2");
    expect(crawler).toEqual(enemy(before, "crawler"));
    expect(d1).toMatchObject({ variantOf: "crawler", name: "Crawler (The Spire)", behavior: scaleEnemy(crawler, 1).behavior, stats: scaleEnemy(crawler, 1).stats });
    expect(d2).toMatchObject({ variantOf: "crawler", name: "Crawler (The Summit)", stats: scaleEnemy(crawler, 2).stats });
    expect(d1.stats.health).toBeGreaterThan(crawler.stats.health);
    expect(d2.stats.health).toBeGreaterThan(d1.stats.health);
    // Right after its original, in depth order.
    const ids = p.characters.map((c) => c.id);
    expect(ids.slice(ids.indexOf("crawler"), ids.indexOf("crawler") + 3)).toEqual(["crawler", "crawler_d1", "crawler_d2"]);

    // The caller (only in the spire) calls the spire's mites.
    const caller = enemy(p, "caller_d1");
    expect(caller.behavior.states.call!.action).toMatchObject({ type: "summon", character: "mite_d1" });
    expect(enemy(p, "mite_d1")).toMatchObject({ variantOf: "mite", name: "Mite (depth 1)" });
    expect(summary).toMatch(/5 tougher variants of 4 enemies/);
    expect(summary).toMatch(/crawler_d2: health/);
  });

  it("never scales health past what the player's weakest weapon beats in MAX_HITS hits, nor below what the creator wrote", () => {
    const base = game();
    const blade = { id: "blade", name: "Blade", attacks: [{ id: "cut", name: "Cut", shape: { type: "arc", radius: 60 }, damage: 1 }] };
    const armed = (health: number) =>
      ProjectSpec.parse({
        ...base,
        characters: base.characters.map((c) => (c.id === "crawler" && c.kind === "enemy" ? { ...c, stats: { ...c.stats, health } } : c)),
        weapons: { ...base.weapons, list: [blade], loadout: { slots: [{ id: "main", label: "Main", action: "attack", start: "blade" }], cycle: false } },
      });
    // 38 health deeper would be 50 (x1.3) and 61 (x1.6): capped at 40 hits of 1 damage.
    const capped = difficultyStage(armed(38)).project;
    expect(enemy(capped, "crawler_d1").stats.health).toBe(40);
    expect(enemy(capped, "crawler_d2").stats.health).toBe(40);
    expect(lintProject(capped).map((w) => w.code)).not.toContain("weapon_too_weak");
    // Written tougher than the cap: the variants keep the creator's number (and the lint says so).
    const tough = difficultyStage(armed(50)).project;
    expect(enemy(tough, "crawler_d2").stats.health).toBe(50);
    // Without weapons nothing changes.
    expect(enemy(difficultyStage(base).project, "crawler_d2").stats.health).toBe(scaleEnemy(enemy(base, "crawler"), 2).stats.health);
  });

  it("keeps game logic: handlers that name a character follow its variants, and the game is still beatable", () => {
    const before = game();
    const { project: p } = difficultyStage(before);
    // A world handler on the crawler's death answers every crawler's death: one copy per variant.
    const shell = p.world.handlers.filter((h) => h.do.some((e) => e.type === "giveItem"));
    expect(shell.map((h) => (h.on.type === "enemyKilled" ? h.on.character : ""))).toEqual(["crawler", "crawler_d1", "crawler_d2"]);
    // A room's handler names the variant that lives there.
    const cistern = p.world.rooms.find((r) => r.id === "cistern")!;
    expect(cistern.handlers.find((h) => h.on.type === "enemyKilled")?.on).toEqual({ type: "enemyKilled", character: "crawler_d1" });

    const was = checkGame(before);
    const now = checkGame(p);
    expect(now.beatable).toBe(was.beatable);
    expect(now.beatable).toBe(true);
    expect(now.deadStates.length).toBe(was.deadStates.length);
  });

  it("raises no lint or fairness warning the game didn't have", () => {
    const before = game();
    const { project: p } = difficultyStage(before);
    const rename = (w: string) => w.replace(/characters\.\d+/, "characters.#");
    expect(lintCombat(p).map((w) => w.code)).toEqual(lintCombat(before).map((w) => w.code));
    const added = codes(p).map(rename).filter((w) => !codes(before).map(rename).includes(w));
    expect(added).toEqual([]);
    expect(lintProject(p).some((w) => w.code === "unplaced_character" && w.message.includes('"guardian"'))).toBe(false);
  });

  it("is idempotent: a second run changes nothing, and editing the original carries over", () => {
    const once = difficultyStage(game()).project;
    const twice = difficultyStage(once).project;
    expect(twice).toEqual(once);
    expect(enemy(twice, "crawler_d2").stats.health).toBe(scaleEnemy(enemy(once, "crawler"), 2).stats.health);

    const edited = ok(applyOperation(once, "updateCharacter", { characterId: "crawler", changes: { stats: { health: 10 } } }));
    const again = difficultyStage(edited).project;
    expect(enemy(again, "crawler_d1").stats.health).toBe(13);
    expect(enemy(again, "crawler_d2").stats.health).toBe(16);
  });

  it("leaves a game without depth alone", () => {
    const flat = ProjectSpec.parse({ ...game(), world: { ...game().world, rooms: game().world.rooms.map(({ regionId: _r, ...r }) => r) } });
    const out = difficultyStage(flat);
    expect(out.project).toEqual(flat);
    expect(out.summary).toMatch(/nothing to scale/);
  });

  it("leaves pinned rooms as they are", () => {
    const p = game();
    const pinned = ProjectSpec.parse({
      ...p,
      architect: { ...p.architect, rooms: [{ id: "summit", name: "Summit", regionId: "summit", pinned: true }] },
    });
    const out = difficultyStage(pinned).project;
    expect(spawnsOf(out, "summit")).toEqual(["crawler"]);
    expect(out.characters.some((c) => c.id === "crawler_d2")).toBe(false);
    expect(difficultyStage(out).project).toEqual(out);
  });

  it("variants are drawn with their original: one art step, and the asset goes to both", () => {
    const p = difficultyStage(game()).project;
    const steps = gameArtPlan(p).filter((s) => s.kind === "character").map((s) => s.id);
    expect(steps).toContain("character:crawler");
    expect(steps.some((s) => s.startsWith("character:crawler_d"))).toBe(false);

    const drawn = ok(applyOperation(p, "createAsset", { asset: { id: "shell_look", name: "Shell", kind: "character", brief: "a beetle" }, assignTo: "crawler" }));
    expect(["crawler", "crawler_d1", "crawler_d2"].map((id) => enemy(drawn, id).appearance)).toEqual(["shell_look", "shell_look", "shell_look"]);
    const rigged = ProjectSpec.parse({ ...drawn, art: { ...drawn.art, assets: drawn.art.assets.map((a) => (a.id === "shell_look" ? { ...a, rig: exampleRig() } : a)) } });
    // Rerun after art: variants keep sharing the look.
    expect(enemy(difficultyStage(rigged).project, "crawler_d2").appearance).toBe("shell_look");
  });

  it("deleting the original deletes its variants and their spawns", () => {
    const p = difficultyStage(game()).project;
    const out = ok(applyOperation(p, "deleteCharacter", { characterId: "caller" }));
    expect(out.characters.some((c) => c.id.startsWith("caller"))).toBe(false);
    expect(spawnsOf(out, "bridge")).toEqual(["crawler_d1"]);
  });
});
