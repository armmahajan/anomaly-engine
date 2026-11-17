import type { ProjectSpec } from "../schema.ts";
import { dressingOutOfDate } from "../world/world.ts";
import { ACTION_CLIP_SLOTS, ACTION_PHASE_SLOTS, ENEMY_CLIP_SLOTS, PLAYER_CLIP_SLOTS, type ClipSlot } from "./clip.ts";

/**
 * What a game still needs to be fully drawn, as ordered steps the game-art
 * job runs one at a time (each saved on its own, so a stopped or failed run
 * resumes by planning again). A step's `request` is an ordinary art job
 * request, except `biomeStep`: the biome made by an earlier step of this plan.
 *
 * Rooms are grouped by progression region (rooms without one form a group of
 * their own); each group shares one biome. Nothing here knows what a room or
 * prop is for: props are drawn from their names, sizes and handlers.
 */

export type ArtStepKind = "character" | "biome" | "room" | "props" | "modal" | "items";

export interface ArtStepRequest {
  stage: "auto" | "animate" | "worldKit" | "worldCompose" | "propArt" | "modalArt" | "itemArt";
  characterId?: string;
  biomeId?: string;
  /** The biome made by this earlier step (worldKit) of the plan. */
  biomeStep?: string;
  /** worldCompose: the biome room to recompose (an out-of-date dressing). */
  roomId?: string;
  name?: string;
  brief?: string;
  dressRoom?: string;
  worldRoomId?: string;
  modalId?: string;
  /** animate: only these clips (the ones still missing; the rest are kept). */
  slots?: ClipSlot[];
}

export interface ArtStep {
  /** Stable within a plan, e.g. "character:crawler", "biome:caves", "room:hall". */
  id: string;
  kind: ArtStepKind;
  reason: "missing" | "out_of_date" | "incomplete";
  description: string;
  request: ArtStepRequest;
  /** USD, a rough estimate with today's default models. */
  estimatedCost: number;
}

/** Rough USD per step with the default models (Haiku 5.5 + gpt-image-1-mini). */
export const ART_COST_ESTIMATES = {
  character: 0.03,
  animate: 0.01,
  biome: 0.02,
  room: 0.005,
  props: 0.004,
  modal: 0.01,
  items: 0.01,
} as const;

export interface GameArtOptions {
  /** Themes for room groups (region id, or "world" for rooms without a region); default from the region and the art direction. */
  themes?: Record<string, string>;
  /** Also illustrate modals (default true). */
  modals?: boolean;
}

/** The clip slots a character asset needs, from the behaviors of the characters drawn with it. */
export function wantedClipSlots(project: ProjectSpec, assetId: string): ClipSlot[] {
  const slots = new Set<ClipSlot>(["idle"]);
  for (const c of project.characters) {
    if (c.appearance !== assetId) continue;
    if (c.kind === "player") {
      PLAYER_CLIP_SLOTS.forEach((s) => slots.add(s));
      continue;
    }
    ENEMY_CLIP_SLOTS.forEach((s) => slots.add(s)); // every enemy is struck (hurt) and can be killed (death)
    const flying = c.movement === "flying";
    for (const state of Object.values(c.behavior.states)) {
      const type = state.action.type;
      // Attacks get a clip per phase (windup, the hit itself, the recovery).
      const phased = ACTION_PHASE_SLOTS[type];
      const wanted = phased ? Object.values(phased).map((list) => list[0]) : [ACTION_CLIP_SLOTS[type]?.[0]];
      for (const slot of wanted) if (slot) slots.add(flying && (slot === "walk" || slot === "run") ? "fly" : slot);
    }
  }
  return [...slots];
}

/** The room groups that share a biome: by progression region, else one "world" group. */
export function roomGroups(project: ProjectSpec): { group: string; rooms: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const room of project.world.rooms) {
    const group = room.regionId ?? "world";
    groups.set(group, [...(groups.get(group) ?? []), room.id]);
  }
  return [...groups].map(([group, rooms]) => ({ group, rooms }));
}

function themeFor(project: ProjectSpec, group: string, options: GameArtOptions): string {
  if (options.themes?.[group]) return options.themes[group];
  const region = project.progression.regions.find((r) => r.id === group);
  const page = region?.wikiPageId ? project.wiki.pages.find((p) => p.id === region.wikiPageId) : undefined;
  const place = region ? `${region.name}${page?.summary ? `: ${page.summary}` : ""}` : project.name;
  return `${place}. ${project.art.direction.style}`.slice(0, 2000);
}

export function gameArtPlan(project: ProjectSpec, options: GameArtOptions = {}): ArtStep[] {
  const steps: ArtStep[] = [];
  const assets = new Map(project.art.assets.map((a) => [a.id, a]));

  // Characters: drawn and animated for every behavior they have.
  const drawnAssets = new Set<string>();
  for (const c of project.characters) {
    const asset = c.appearance ? assets.get(c.appearance) : undefined;
    if (!asset || asset.kind !== "character" || !asset.rig) {
      // A variant (variantOf) is drawn with its undrawn original: that step's asset is assigned to both.
      const original = c.kind === "enemy" && c.variantOf ? project.characters.find((o) => o.id === c.variantOf) : undefined;
      const originalAsset = original?.appearance ? assets.get(original.appearance) : undefined;
      if (original && !(originalAsset?.kind === "character" && originalAsset.rig)) continue;
      steps.push({
        id: `character:${c.id}`,
        kind: "character",
        reason: "missing",
        description: `draw and animate ${c.name}`,
        request: { stage: "auto", characterId: c.id },
        estimatedCost: ART_COST_ESTIMATES.character,
      });
      continue;
    }
    if (drawnAssets.has(asset.id)) continue;
    drawnAssets.add(asset.id);
    const missing = wantedClipSlots(project, asset.id).filter((slot) => !asset.clips[slot]);
    if (missing.length > 0) {
      steps.push({
        id: `character:${c.id}`,
        kind: "character",
        reason: "incomplete",
        description: `animate ${c.name}: ${missing.join(", ")}`,
        request: { stage: "animate", characterId: c.id, slots: missing },
        estimatedCost: ART_COST_ESTIMATES.animate,
      });
    }
  }

  // Rooms: one biome per group, every room dressed around its current tiles.
  for (const { group, rooms } of roomGroups(project)) {
    const inGroup = project.world.rooms.filter((r) => rooms.includes(r.id));
    const existing = inGroup
      .map((r) => (r.dressing ? assets.get(r.dressing.biome) : undefined))
      .find((a) => a?.kind === "biome" && a.kit);
    const biomeStep = `biome:${group}`;
    if (!existing) {
      steps.push({
        id: biomeStep,
        kind: "biome",
        reason: "missing",
        description: `paint a biome kit for ${group === "world" ? "the world" : `region ${group}`}`,
        request: { stage: "worldKit", brief: themeFor(project, group, options), name: project.progression.regions.find((r) => r.id === group)?.name },
        estimatedCost: ART_COST_ESTIMATES.biome,
      });
    }
    const biome = existing ? { biomeId: existing.id } : { biomeStep };
    for (const room of inGroup) {
      if (!room.dressing) {
        steps.push({
          id: `room:${room.id}`,
          kind: "room",
          reason: "missing",
          description: `compose and dress ${room.name}`,
          request: { stage: "worldCompose", ...biome, dressRoom: room.id },
          estimatedCost: ART_COST_ESTIMATES.room,
        });
      } else if (dressingOutOfDate(room)) {
        steps.push({
          id: `room:${room.id}`,
          kind: "room",
          reason: "out_of_date",
          description: `recompose ${room.name} around its new tiles`,
          request: { stage: "worldCompose", biomeId: room.dressing.biome, roomId: room.dressing.room },
          estimatedCost: ART_COST_ESTIMATES.room,
        });
      }
      // Props are drawn with their room's kit, so they come after it.
      if (room.props.some((p) => !p.art)) {
        steps.push({
          id: `props:${room.id}`,
          kind: "props",
          reason: "missing",
          description: `draw the props in ${room.name}`,
          request: { stage: "propArt", worldRoomId: room.id },
          estimatedCost: ART_COST_ESTIMATES.props,
        });
      }
    }
  }

  // Screens and items.
  if (options.modals !== false) {
    for (const modal of project.world.modals) {
      if (modal.image) continue;
      steps.push({
        id: `modal:${modal.id}`,
        kind: "modal",
        reason: "missing",
        description: `illustrate the "${modal.title || modal.id}" screen`,
        request: { stage: "modalArt", modalId: modal.id },
        estimatedCost: ART_COST_ESTIMATES.modal,
      });
    }
  }
  if (project.world.items.some((i) => !i.icon)) {
    steps.push({
      id: "items",
      kind: "items",
      reason: "missing",
      description: `draw icons for ${project.world.items.filter((i) => !i.icon).map((i) => i.name).join(", ")}`,
      request: { stage: "itemArt" },
      estimatedCost: ART_COST_ESTIMATES.items,
    });
  }
  return steps;
}
