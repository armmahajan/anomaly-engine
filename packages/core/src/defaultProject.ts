import { SCHEMA_VERSION, type EnemyCharacter, type ProjectSpec } from "./schema.ts";

/** Starter project: a sandbox arena with a player, a patroller and a charger. */
export function createDefaultProject(): ProjectSpec {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "untitled",
    name: "Untitled Game",
    revision: 0,
    characters: [
      {
        id: "player",
        kind: "player",
        name: "Wanderer",
        color: "#e8e3d3",
        size: { width: 28, height: 44 },
        stats: { runSpeed: 320, jumpVelocity: 760 },
      },
      {
        id: "crawler",
        kind: "enemy",
        name: "Crawler",
        color: "#c0504d",
        size: { width: 40, height: 28 },
        stats: { knockback: 350 },
        behavior: {
          initial: "patrol",
          states: {
            patrol: { action: { type: "patrol", speed: 120, distance: 420 }, transitions: [] },
          },
        },
      },
      {
        id: "charger",
        kind: "enemy",
        name: "Charger",
        color: "#8e6cc2",
        size: { width: 44, height: 36 },
        stats: { knockback: 650 },
        behavior: {
          initial: "patrol",
          states: {
            patrol: {
              action: { type: "patrol", speed: 60, distance: 200 },
              transitions: [{ when: { type: "playerWithin", distance: 260 }, to: "windup" }],
            },
            windup: {
              action: { type: "telegraph", color: "#ffd27a" },
              transitions: [{ when: { type: "after", seconds: 0.6 }, to: "charge" }],
            },
            charge: {
              action: { type: "charge", speed: 520 },
              transitions: [
                { when: { type: "hitWall" }, to: "recover" },
                { when: { type: "after", seconds: 0.9 }, to: "recover" },
              ],
            },
            recover: {
              action: { type: "wait" },
              transitions: [{ when: { type: "after", seconds: 0.8 }, to: "patrol" }],
            },
          },
        },
      },
    ],
    sandbox: {
      width: 1600,
      height: 720,
      gravity: 1800,
      backgroundColor: "#1b2030",
      platformColor: "#4a5470",
      platforms: [
        { x: 0, y: 660, width: 1600, height: 60 }, // floor
        { x: -40, y: 0, width: 40, height: 720 }, // left wall
        { x: 1600, y: 0, width: 40, height: 720 }, // right wall
        { x: 380, y: 530, width: 220, height: 20 },
        { x: 720, y: 420, width: 220, height: 20 },
      ],
      spawns: [
        { id: "player_1", characterId: "player", x: 160, y: 660 },
        { id: "crawler_1", characterId: "crawler", x: 1150, y: 660 },
        { id: "charger_1", characterId: "charger", x: 640, y: 660 },
      ],
    },
  };
}

/** A plain patrolling enemy: the starting point for "+ Enemy" in the studio. */
export function newEnemyCharacter(id: string, name: string, color = "#5f9e6e"): EnemyCharacter {
  return {
    id,
    kind: "enemy",
    name,
    color,
    size: { width: 36, height: 32 },
    stats: { knockback: 350 },
    behavior: {
      initial: "patrol",
      states: { patrol: { action: { type: "patrol", speed: 100, distance: 300 }, transitions: [] } },
    },
  };
}
