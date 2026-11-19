import { isObjectAsset, wantedClipSlots, wantedObjectClips, type Character, type CharacterAsset, type ProjectSpec, type Stage } from "@anomaly/core";

/**
 * What the Characters tab's workbench draws and animates: a game character (its appearance asset)
 * or an object (an asset with subject "object": a lever, a trap, an effect, a projectile). The same
 * art panel, workbench, animation list and bone editor serve both; only the art job's subject
 * (characterId or objectId) and the stage message differ.
 */
export interface ArtSubject {
  kind: "character" | "object";
  /** The character id, or the object asset's id. */
  id: string;
  name: string;
  /** The art drawn for it (a character without art yet has none). */
  asset: CharacterAsset | null;
}

/** The art job field naming the subject. */
export type SubjectRef = { characterId: string } | { objectId: string };

export function characterAsset(project: ProjectSpec, character: Character): CharacterAsset | null {
  const asset = project.art.assets.find((a) => a.id === character.appearance);
  return asset && asset.kind === "character" ? asset : null;
}

export const characterSubject = (project: ProjectSpec, character: Character): ArtSubject => ({ kind: "character", id: character.id, name: character.name, asset: characterAsset(project, character) });

export const objectSubject = (asset: CharacterAsset): ArtSubject => ({ kind: "object", id: asset.id, name: asset.name, asset });

/** The object asset `id` as a subject, if the project has it. */
export function findObjectSubject(project: ProjectSpec, id: string | null): ArtSubject | null {
  const asset = id ? project.art.assets.find((a) => a.id === id) : undefined;
  return isObjectAsset(asset) ? objectSubject(asset) : null;
}

export const subjectRef = (subject: ArtSubject): SubjectRef => (subject.kind === "character" ? { characterId: subject.id } : { objectId: subject.id });

/** A running, queued or finished art job is about this subject. */
export const isSubjectJob = (job: { characterId?: string; objectId?: string }, subject: ArtSubject): boolean =>
  subject.kind === "character" ? job.characterId === subject.id : job.objectId === subject.id;

/** Clip names the game asks of this art that it doesn't have yet. */
export function missingClips(project: ProjectSpec, subject: ArtSubject): string[] {
  const asset = subject.asset;
  if (!asset?.rig) return [];
  const wanted = subject.kind === "object" ? wantedObjectClips(project, asset.id) : wantedClipSlots(project, asset.id);
  return wanted.filter((c) => !asset.clips[c]);
}

export interface StageView {
  clip: string | null;
  time: number | null;
  speed: number;
  flip: boolean;
  bones: boolean;
  onion: { image: string | null; alpha: number };
}

/** The runtime stage showing this subject: the character stage, or the object stage (no facing: objects are drawn as made). */
export function subjectStage(subject: ArtSubject, view: StageView): Stage {
  if (subject.kind === "character") return { mode: "character", characterId: subject.id, ...view };
  const { flip: _flip, ...rest } = view;
  return { mode: "object", assetId: subject.id, ...rest };
}
