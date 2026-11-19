import { describe, expect, it } from "vitest";
import { createDefaultProject, gameArtPlan, type ProjectSpec } from "@anomaly/core";
import { conflicts, EVERYTHING, jobKeys, lanesOf, runLanes } from "../src/art/scheduling.ts";
import { artConcurrencyFromEnv } from "../src/art/config.ts";

/** The default project, plus: a spear the player starts with and the charger swings, a variant of the
 * crawler, a bow nobody wields, a biome dressing the arena, a second room and a modal. Only the fields
 * jobKeys reads are filled in. */
function project(): ProjectSpec {
  const p = structuredClone(createDefaultProject()) as unknown as Record<string, any>;
  p.weapons.list = [
    { id: "spear", name: "Spear", attacks: [{ id: "thrust", clip: null }], art: {} },
    { id: "bow", name: "Bow", attacks: [{ id: "loose", clip: "shoot" }], art: {} },
  ];
  p.weapons.loadout.slots = [{ start: "spear" }];
  const charger = p.characters.find((c: { id: string }) => c.id === "charger");
  charger.behavior.states.attack = { action: { type: "useWeapon", weapon: "spear" }, transitions: [] };
  charger.appearance = "charger_look";
  p.characters.push({ ...structuredClone(p.characters.find((c: { id: string }) => c.id === "crawler")), id: "crawler_red", variantOf: "crawler" });
  p.art.assets = [{ id: "caves", kind: "biome", rooms: [] }];
  p.world.rooms[0].dressing = { biome: "caves", room: "r1" };
  p.world.rooms.push({ ...structuredClone(p.world.rooms[0]), id: "hall", dressing: undefined });
  return p as unknown as ProjectSpec;
}

describe("jobKeys: what an art job touches", () => {
  const p = project();
  const arena = p.world.rooms[0]!.id;

  it("the art direction and the game-art job touch everything", () => {
    expect(jobKeys({ stage: "artDirection" }, p)).toEqual([EVERYTHING]);
    expect(jobKeys({ stage: "gameArt" }, p)).toEqual([EVERYTHING]);
    expect(conflicts([EVERYTHING], ["modal:intro"])).toBe(true);
    expect(conflicts(["items"], [EVERYTHING])).toBe(true);
  });

  it("character jobs: the character's family and its asset; animating adds the weapons it wields or names", () => {
    expect(jobKeys({ stage: "concepts", characterId: "crawler" }, p)).toEqual(["character:crawler"]);
    // A variant shares its original's art.
    expect(jobKeys({ stage: "rig", characterId: "crawler_red" }, p)).toEqual(["character:crawler"]);
    expect(jobKeys({ stage: "rig", characterId: "charger" }, p).sort()).toEqual(["asset:charger_look", "character:charger"]);
    expect(jobKeys({ stage: "animate", characterId: "charger" }, p).sort()).toEqual(["asset:charger_look", "character:charger", "weapon:spear"]);
    expect(jobKeys({ stage: "auto", characterId: "player" }, p).sort()).toEqual(["character:player", "weapon:spear"]);
    // An attack clip asked for by name, or one weapon's clips.
    expect(jobKeys({ stage: "animate", characterId: "crawler", clips: ["shoot"] }, p)).toContain("weapon:bow");
    expect(jobKeys({ stage: "animate", characterId: "crawler", weaponId: "bow" }, p)).toContain("weapon:bow");
    expect(jobKeys({ stage: "weaponArt", weaponId: "spear" }, p)).toEqual(["weapon:spear"]);
  });

  it("character jobs conflict on the same character, its variants, a shared asset or a weapon both animate", () => {
    const k = (r: Parameters<typeof jobKeys>[0]) => jobKeys(r, p);
    expect(conflicts(k({ stage: "concepts", characterId: "crawler" }), k({ stage: "choose", characterId: "crawler" }))).toBe(true);
    expect(conflicts(k({ stage: "concepts", characterId: "crawler" }), k({ stage: "concepts", characterId: "crawler_red" }))).toBe(true);
    expect(conflicts(k({ stage: "concepts", characterId: "crawler" }), k({ stage: "concepts", characterId: "charger" }))).toBe(false);
    // The player and the charger both write the spear's attack clip.
    expect(conflicts(k({ stage: "animate", characterId: "player" }), k({ stage: "animate", characterId: "charger" }))).toBe(true);
    expect(conflicts(k({ stage: "rig", characterId: "player" }), k({ stage: "rig", characterId: "charger" }))).toBe(false);
    expect(conflicts(k({ stage: "weaponArt", weaponId: "spear" }), k({ stage: "auto", characterId: "player" }))).toBe(true);
    expect(conflicts(k({ stage: "weaponArt", weaponId: "bow" }), k({ stage: "auto", characterId: "player" }))).toBe(false);
  });

  it("world jobs: the biome and the rooms dressed with it; new biomes by name; props by room and its biome", () => {
    expect(jobKeys({ stage: "worldRepaint", biomeId: "caves" }, p).sort()).toEqual(["biome:caves", `room:${arena}`]);
    expect(jobKeys({ stage: "worldCompose", biomeId: "caves", dressRoom: "hall" }, p).sort()).toEqual(["biome:caves", "room:hall", `room:${arena}`].sort());
    expect(jobKeys({ stage: "worldKit", brief: "a fungal cathedral, damp" }, p)).toEqual(["biome-new:a_fungal_cathedral"]);
    expect(jobKeys({ stage: "worldKit", brief: "anything", name: "Fungal Cathedral" }, p)).toEqual(["biome-new:fungal_cathedral"]);
    expect(jobKeys({ stage: "worldKit", brief: "lava", dressRoom: "hall" }, p).sort()).toEqual(["biome-new:lava", "room:hall"]);
    expect(jobKeys({ stage: "propArt", worldRoomId: arena }, p).sort()).toEqual(["biome:caves", `room:${arena}`]);
    expect(jobKeys({ stage: "propArt", worldRoomId: "hall" }, p)).toEqual(["room:hall"]);
    const k = (r: Parameters<typeof jobKeys>[0]) => jobKeys(r, p);
    // Props painted into the kit vs a repaint of that kit; two props jobs in rooms of one biome.
    expect(conflicts(k({ stage: "propArt", worldRoomId: arena }), k({ stage: "worldRepaint", biomeId: "caves" }))).toBe(true);
    expect(conflicts(k({ stage: "propArt", worldRoomId: "hall" }), k({ stage: "worldKit", brief: "lava", dressRoom: "hall" }))).toBe(true);
    expect(conflicts(k({ stage: "worldKit", brief: "lava" }), k({ stage: "worldKit", brief: "ice" }))).toBe(false);
    expect(conflicts(k({ stage: "worldKit", brief: "lava" }), k({ stage: "worldKit", brief: "Lava, hot" }))).toBe(true);
  });

  it("modals and item icons", () => {
    expect(jobKeys({ stage: "modalArt", modalId: "intro" }, p)).toEqual(["modal:intro"]);
    expect(jobKeys({ stage: "itemArt" }, p)).toEqual(["items"]);
    expect(conflicts(jobKeys({ stage: "modalArt", modalId: "intro" }, p), jobKeys({ stage: "modalArt", modalId: "outro" }, p))).toBe(false);
    expect(conflicts(jobKeys({ stage: "itemArt" }, p), jobKeys({ stage: "concepts", characterId: "crawler" }, p))).toBe(false);
  });

  it("game-art plan steps: a biome's rooms follow it through biomeStep", () => {
    const fresh = createDefaultProject();
    const plan = gameArtPlan(fresh);
    const lanes = lanesOf(plan, (s) => [...jobKeys(s.request, fresh), ...(s.request.stage === "worldKit" ? [`biomeStep:${s.id}`] : [])]);
    expect(lanes.map((l) => l.map((s) => s.id))).toEqual([["character:player"], ["character:crawler"], ["character:charger"], ["biome:world", "room:arena"]]);
  });
});

describe("settings", () => {
  it("STUDIO_ART_CONCURRENCY (default 3) and STUDIO_ART_RENDER_PAGES (default = concurrency, at most 3)", () => {
    expect(artConcurrencyFromEnv({})).toEqual({ concurrency: 3, pages: 3 });
    expect(artConcurrencyFromEnv({ STUDIO_ART_CONCURRENCY: "1" })).toEqual({ concurrency: 1, pages: 1 });
    expect(artConcurrencyFromEnv({ STUDIO_ART_CONCURRENCY: "6" })).toEqual({ concurrency: 6, pages: 3 });
    expect(artConcurrencyFromEnv({ STUDIO_ART_CONCURRENCY: "lots", STUDIO_ART_RENDER_PAGES: "0" })).toEqual({ concurrency: 3, pages: 3 });
    expect(artConcurrencyFromEnv({ STUDIO_ART_CONCURRENCY: "2", STUDIO_ART_RENDER_PAGES: "9" })).toEqual({ concurrency: 2, pages: 3 });
    expect(artConcurrencyFromEnv({ STUDIO_ART_CONCURRENCY: "99" }).concurrency).toBe(8);
  });
});

describe("lanes", () => {
  it("lanesOf groups items that share keys (also through others), keeping order", () => {
    const items = [
      { id: "a", keys: ["x"] },
      { id: "b", keys: ["y"] },
      { id: "c", keys: ["z"] },
      { id: "d", keys: ["x", "z"] },
      { id: "e", keys: [] },
    ];
    expect(lanesOf(items, (i) => i.keys).map((l) => l.map((i) => i.id))).toEqual([["a", "c", "d"], ["b"], ["e"]]);
  });

  it("runLanes runs lanes side by side up to the limit, each lane in order, and stops starting more after a failure", async () => {
    const log: string[] = [];
    let running = 0;
    let most = 0;
    const each = async (item: string) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(item);
      running--;
      if (item === "boom") throw new Error("boom");
    };
    await runLanes([["a1", "a2"], ["b1"], ["c1"], ["d1"]], 2, each);
    expect(most).toBe(2);
    expect(log.indexOf("a1")).toBeLessThan(log.indexOf("a2"));
    expect(log.sort()).toEqual(["a1", "a2", "b1", "c1", "d1"]);

    log.length = 0;
    await expect(runLanes([["boom", "after"], ["slow1", "slow2", "slow3"]], 2, each)).rejects.toThrow("boom");
    expect(log).not.toContain("after");
    expect(log).not.toContain("slow3");
  });
});
