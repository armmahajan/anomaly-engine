import { z } from "zod";
import { Behavior } from "./behavior.ts";
import { Color, Id } from "./common.ts";
import { defaultWiki, Wiki } from "./wiki/wiki.ts";

/**
 * The canonical project representation. Runtime-neutral: units are pixels,
 * y points down, rectangles are { x, y } top-left + size, and spawn points
 * are the character's feet (bottom-centre).
 */

export const SCHEMA_VERSION = 3;


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
});

const characterBase = {
  id: Id.describe("Unique lowercase snake_case id, e.g. \"stone_beetle\"."),
  name: z.string().min(1).max(80).describe("Display name."),
  color: Color.describe("Body color, #rrggbb (placeholder art)."),
  size: Size.describe("Collision box in px."),
};

export const PlayerCharacter = z.strictObject({
  ...characterBase,
  kind: z.literal("player"),
  stats: PlayerStats,
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
});

/** A character *type*. Every spawn of it shares these values. */
export const Character = z.discriminatedUnion("kind", [PlayerCharacter, EnemyCharacter]);

const Coord = z.number().min(-10_000).max(10_000);

const Rect = z.strictObject({
  x: Coord,
  y: Coord,
  width: z.number().min(1).max(10_000),
  height: z.number().min(1).max(10_000),
});

/** One placed instance of a character type. `id` is stable across edits. */
export const Spawn = z.strictObject({
  id: Id,
  characterId: Id,
  x: Coord.describe("Feet x in px (0 = left edge of the arena)."),
  y: Coord.describe("Feet y in px; y grows downward (the floor's top is usually the spawn y)."),
});

/** The empty test room where creators try out character interactions. */
export const Sandbox = z.strictObject({
  width: z.number().min(100).max(10_000),
  height: z.number().min(100).max(10_000),
  gravity: z.number().min(0).max(10_000),
  backgroundColor: Color,
  platformColor: Color,
  platforms: z.array(Rect).max(500),
  spawns: z.array(Spawn).max(200),
});

export const ProjectSpec = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: Id,
    name: z.string().min(1).max(120),
    /** Incremented by every successful operation. */
    revision: z.number().int().min(0),
    characters: z.array(Character).max(500),
    sandbox: Sandbox,
    /** The game wiki (narrative, characters, lore). Older projects get an empty one. */
    wiki: Wiki.default(defaultWiki),
  })
  .superRefine((project, ctx) => {
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

    let playerSpawns = 0;
    const spawnIds = new Set<string>();
    project.sandbox.spawns.forEach((s, i) => {
      if (spawnIds.has(s.id)) {
        ctx.addIssue({ code: "custom", path: ["sandbox", "spawns", i, "id"], message: `duplicate spawn id "${s.id}"` });
      }
      spawnIds.add(s.id);
      const character = project.characters.find((c) => c.id === s.characterId);
      if (!character) {
        ctx.addIssue({
          code: "custom",
          path: ["sandbox", "spawns", i, "characterId"],
          message: `unknown character "${s.characterId}"`,
        });
      } else if (character.kind === "player") {
        playerSpawns++;
      }
    });
    if (playerSpawns !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["sandbox", "spawns"],
        message: `sandbox needs exactly one player spawn (found ${playerSpawns})`,
      });
    }
  });

export type ProjectSpec = z.infer<typeof ProjectSpec>;
export type Character = z.infer<typeof Character>;
export type PlayerCharacter = z.infer<typeof PlayerCharacter>;
export type EnemyCharacter = z.infer<typeof EnemyCharacter>;
export type Sandbox = z.infer<typeof Sandbox>;
export type Spawn = z.infer<typeof Spawn>;
