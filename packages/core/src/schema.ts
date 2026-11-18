import { z } from "zod";
import { Behavior } from "./behavior.ts";
import { Color, Id } from "./common.ts";
import { defaultWiki, Wiki } from "./wiki/wiki.ts";
import { defaultProgression, Progression, progressionIssues } from "./progression/progression.ts";
import { AbilityTuning } from "./movement/params.ts";
import { ArtSection, defaultArtSection } from "./art/asset.ts";
import { Dressing } from "./art/world.ts";
import { World, worldIssues } from "./world/world.ts";
import { ArchitectPlan, architectIssues, defaultArchitectPlan } from "./architect/plan.ts";
import { Controls } from "./controls/controls.ts";
import { Weapons, weaponIssues } from "./combat/weapon.ts";

/**
 * The canonical project representation. Runtime-neutral: units are pixels,
 * y points down, rectangles are { x, y } top-left + size, and spawn points
 * are the character's feet (bottom-centre).
 */

export const SCHEMA_VERSION = 8;


const Size = z.strictObject({
  width: z.number().min(4).max(512),
  height: z.number().min(4).max(512),
});

export const PlayerStats = z.strictObject({
  runSpeed: z.number().min(0).max(1000).describe("px/s"),
  jumpVelocity: z.number().min(0).max(2000).describe("Initial upward speed in px/s; jump height = v^2 / (2 * gravity)."),
  health: z.number().int().min(1).max(20).default(5).describe("Hit points. At 0 the run restarts."),
  attackDamage: z.number().int().min(0).max(100).default(1).describe("Damage per sword hit."),
  attackReach: z.number().min(8).max(300).default(56).describe("How far the sword reaches from the body, px."),
  attackCooldown: z.number().min(0.05).max(2).default(0.35).describe("Seconds between swings."),
  pogoVelocity: z
    .number()
    .min(0)
    .max(2000)
    .default(620)
    .describe("Upward bounce in px/s when a downward strike (down + attack in the air) hits an enemy."),
  maxFallSpeed: z.number().min(100).max(4000).default(1100).describe("Fastest fall, px/s."),
  coyoteTime: z.number().min(0).max(0.3).default(0.1).describe("Seconds after running off a ledge when jump still works."),
  jumpBuffer: z.number().min(0).max(0.3).default(0.12).describe("Seconds a jump pressed too early (just before landing or reaching a wall) is remembered."),
});

export const EnemyStats = z.strictObject({
  /** How hard touching this enemy throws the player back (px/s). */
  knockback: z.number().min(0).max(2000).describe("How hard touching this enemy throws the player back, px/s."),
  health: z.number().int().min(1).max(999).default(3).describe("Hit points; the player's sword deals attackDamage per hit."),
  contactDamage: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(1)
    .describe("Damage to the player on touch. With knockback 0 too, touching it is harmless."),
  armor: z.number().min(0).max(1).optional().describe("0..1 (default 0): how much it resists being pushed back by sword hits; 1 = never budges."),
});

/** Seconds an enemy's body stays after it dies (game/scripts/enemy.gd uses the same defaults). */
export const DEATH_DEFAULTS = { linger: 0.6, fade: 0.4 } as const;

export const EnemyDeath = z.strictObject({
  linger: z.number().min(0).max(5).default(DEATH_DEFAULTS.linger).describe("Seconds the body stays still after its death clip (or the fallback pop) ends."),
  fade: z.number().min(0.05).max(3).default(DEATH_DEFAULTS.fade).describe("Seconds it takes to fade out and be gone."),
});

const characterBase = {
  id: Id.describe("Unique lowercase snake_case id, e.g. \"river_guard\"."),
  name: z.string().min(1).max(80).describe("Display name."),
  color: Color.describe("Body color, #rrggbb (placeholder art)."),
  size: Size.describe("Collision box in px."),
  appearance: Id.optional().describe("Id of the character art asset that draws it (art.assets); without one it is a colored box."),
};

export const PlayerCharacter = z.strictObject({
  ...characterBase,
  kind: z.literal("player"),
  stats: PlayerStats,
  /** Tuning of every movement ability (which ones the player has is decided by the game, or world.playtest when testing). */
  abilities: AbilityTuning.prefault({}),
});

export const EnemyCharacter = z.strictObject({
  ...characterBase,
  kind: z.literal("enemy"),
  movement: z
    .enum(["ground", "flying"])
    .default("ground")
    .describe("ground: falls with gravity and walks. flying: ignores gravity; chase, retreat, returnHome and charge(towardPlayer) move in 2D."),
  stats: EnemyStats,
  behavior: Behavior,
  death: EnemyDeath.optional().describe(
    `What is left when it dies: it stops hurting and acting at once, plays its death clip (or a pop, flash and shrink without one), stays \`linger\` s, then fades over \`fade\` s. Default linger ${DEATH_DEFAULTS.linger} s, fade ${DEATH_DEFAULTS.fade} s.`,
  ),
  variantOf: Id.optional().describe(
    "A tougher copy of another enemy for deeper regions (made by the difficulty stage): same look and behavior, scaled stats. Edit the original; the variants follow when difficulty runs again.",
  ),
});

/** A character *type*. Every spawn of it shares these values. */
export const Character = z.discriminatedUnion("kind", [PlayerCharacter, EnemyCharacter]);


export const ProjectSpec = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: Id,
    name: z.string().min(1).max(120),
    /** Incremented by every successful operation. */
    revision: z.number().int().min(0),
    characters: z.array(Character).max(500),
    /** The game wiki (narrative, characters, lore). Older projects get an empty one. */
    wiki: Wiki.default(defaultWiki),
    /** Regions, abilities and gates. Older projects get an empty one. */
    progression: Progression.default(defaultProgression),
    /** Art direction and generated assets. Older projects get the defaults. */
    art: ArtSection.default(defaultArtSection),
    /** The game's rooms, doors and rules. Older projects get an empty world. */
    world: World.prefault({}),
    /** The Architect's plan for building the world from the progression. Older projects get an empty one. */
    architect: ArchitectPlan.default(defaultArchitectPlan),
    /** The game's keys per action (players may override them in their browser). Older projects get today's keys. */
    controls: Controls.prefault({}),
    /** Weapons and the loadout (combat/weapon.ts). Older projects get none: the built-in attack. */
    weapons: Weapons.prefault({}),
  })
  .superRefine((project, ctx) => {
    for (const issue of progressionIssues(project.progression, project.characters)) ctx.addIssue({ code: "custom", ...issue });
    for (const issue of architectIssues(project.architect, project.progression)) ctx.addIssue({ code: "custom", ...issue });
    const enemies = new Set(project.characters.filter((c) => c.kind === "enemy").map((c) => c.id));
    for (const issue of worldIssues(project.world, enemies)) ctx.addIssue({ code: "custom", ...issue });
    for (const issue of weaponIssues(project.weapons, new Set(project.world.items.map((i) => i.id)))) ctx.addIssue({ code: "custom", ...issue });
    const regions = new Set(project.progression.regions.map((r) => r.id));
    project.world.rooms.forEach((room, i) => {
      if (room.regionId !== undefined && !regions.has(room.regionId)) {
        ctx.addIssue({ code: "custom", path: ["world", "rooms", i, "regionId"], message: `unknown progression region "${room.regionId}"` });
      }
    });

    const assetIds = new Set<string>();
    project.art.assets.forEach((a, i) => {
      if (assetIds.has(a.id)) {
        ctx.addIssue({ code: "custom", path: ["art", "assets", i, "id"], message: `duplicate asset id "${a.id}"` });
      }
      assetIds.add(a.id);
    });
    const checkDressing = (dressing: { biome: string; room: string } | null, path: (string | number)[]) => {
      if (!dressing) return;
      const biome = project.art.assets.find((a) => a.id === dressing.biome);
      if (!biome || biome.kind !== "biome") {
        ctx.addIssue({ code: "custom", path: [...path, "biome"], message: `unknown biome "${dressing.biome}"` });
      } else if (!biome.kit || !biome.rooms.some((r) => r.id === dressing.room)) {
        ctx.addIssue({ code: "custom", path: [...path, "room"], message: `biome "${dressing.biome}" has no room "${dressing.room}"` });
      }
    };
    project.world.rooms.forEach((room, i) => {
      checkDressing(room.dressing, ["world", "rooms", i, "dressing"]);
      room.props.forEach((prop, j) => {
        if (!prop.art) return;
        const biome = project.art.assets.find((a) => a.id === prop.art!.biome);
        const piece = biome?.kind === "biome" ? biome.kit?.pieces.find((p) => p.id === prop.art!.piece) : undefined;
        if (!piece) ctx.addIssue({ code: "custom", path: ["world", "rooms", i, "props", j, "art"], message: `no kit piece "${prop.art.piece}" in biome "${prop.art.biome}"` });
      });
    });
    project.characters.forEach((c, i) => {
      if (c.appearance !== undefined && !project.art.assets.some((a) => a.id === c.appearance && a.kind === "character")) {
        ctx.addIssue({
          code: "custom",
          path: ["characters", i, "appearance"],
          message: `unknown character asset "${c.appearance}"`,
        });
      }
    });
    const pageIds = new Set<string>();
    project.wiki.pages.forEach((p, i) => {
      if (pageIds.has(p.id)) {
        ctx.addIssue({ code: "custom", path: ["wiki", "pages", i, "id"], message: `duplicate wiki page id "${p.id}"` });
      }
      pageIds.add(p.id);
    });

    const ids = new Set<string>();
    project.characters.forEach((c, i) => {
      if (ids.has(c.id)) {
        ctx.addIssue({ code: "custom", path: ["characters", i, "id"], message: `duplicate character id "${c.id}"` });
      }
      ids.add(c.id);
    });

    project.characters.forEach((c, i) => {
      if (c.kind !== "enemy" || c.variantOf === undefined) return;
      const base = project.characters.find((o) => o.id === c.variantOf);
      if (!base || base.kind !== "enemy" || base.variantOf !== undefined || base.id === c.id) {
        ctx.addIssue({ code: "custom", path: ["characters", i, "variantOf"], message: `"${c.variantOf}" is not an enemy character that isn't itself a variant` });
      }
    });

    const players = project.characters.filter((c) => c.kind === "player").length;
    if (players !== 1) {
      ctx.addIssue({ code: "custom", path: ["characters"], message: `a project needs exactly one player character (found ${players})` });
    }
  });

export type ProjectSpec = z.infer<typeof ProjectSpec>;
export type Character = z.infer<typeof Character>;
export type PlayerCharacter = z.infer<typeof PlayerCharacter>;
export type EnemyCharacter = z.infer<typeof EnemyCharacter>;
