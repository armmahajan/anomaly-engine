import { StageError, type ArtContext, type StageResult } from "./stages.ts";

/**
 * Game stages (agent H): art for the parts of a game that aren't characters
 * or room dressings. Each returns operations like every stage (one undoable
 * AI change), validated by the whole-project check when saved.
 */

export interface PropArtInput {
  /** The world room whose props to draw, with its biome's kit. */
  worldRoomId: string;
}

/** Draw a room's props: pick the best kit piece for each (or paint new pieces into the kit). */
export async function propArtStage(_ctx: ArtContext, input: PropArtInput): Promise<StageResult> {
  throw new StageError(`propArt is not implemented yet (room ${input.worldRoomId})`);
}

export interface ModalArtInput {
  modalId: string;
}

/** Illustrate a modal from its title and text, in the game's art direction. */
export async function modalArtStage(_ctx: ArtContext, input: ModalArtInput): Promise<StageResult> {
  throw new StageError(`modalArt is not implemented yet (modal ${input.modalId})`);
}

/** Draw icons for every item that has none. */
export async function itemArtStage(_ctx: ArtContext): Promise<StageResult> {
  throw new StageError("itemArt is not implemented yet");
}
