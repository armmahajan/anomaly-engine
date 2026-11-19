import { lookKeys, type EnemyCharacter, type Look, type ProjectSpec, type Stage } from "@anomaly/core";

/**
 * Previewing a behavior state's look (BehaviorState.look) on the character stage: the enemy's rig,
 * playing the clip that state plays (its stateClips entry, else idle), with the look on it. Null
 * when the enemy isn't drawn yet (nothing to show the look on).
 */
export function stateLookStage(project: ProjectSpec, character: EnemyCharacter, stateId: string, look: Look | null): Stage | null {
  const asset = project.art.assets.find((a) => a.id === character.appearance);
  if (asset?.kind !== "character" || !asset.rig) return null;
  const clip = asset.stateClips[stateId] ?? (asset.clips.idle ? "idle" : null);
  return { mode: "character", characterId: character.id, clip, time: null, speed: 1, flip: false, bones: false, onion: { image: null, alpha: 0 }, look };
}

/** A look's one-line summary ("tint, aura", or "none"). */
export const lookSummary = (look: Look | undefined): string => (look && lookKeys(look).length ? lookKeys(look).join(", ") : "none");
