import { ArtJobRequest, ArtStage } from "@anomaly/core";

/**
 * Art jobs the weapons target adds (W2: packages/core/src/api.ts). The studio checks the
 * request schema, so its buttons work as soon as the stage lands and say so until then:
 *  - weaponArt {weaponId}: draw a weapon's held sprite (its grip and tip come with it);
 *  - animate {clip, direction}: animate one clip, a standard slot or any name, from a direction.
 */

const fields = (ArtJobRequest as unknown as { shape?: Record<string, unknown> }).shape ?? {};

export const canDrawWeapons = (ArtStage.options as readonly string[]).includes("weaponArt") && "weaponId" in fields;
export const canAnimateOneClip = "clip" in fields;

export const weaponArtRequest = (weaponId: string) => ({ stage: "weaponArt", weaponId }) as unknown as ArtJobRequest;

/** Animate one clip (a slot or a named one) of a character's or an object's art from the creator's direction. */
export const animateClipRequest = (subject: { characterId: string } | { objectId: string }, clip: string, direction: string) =>
  ({ stage: "animate", ...subject, clip, ...(direction.trim() && { direction: direction.trim() }) }) as unknown as ArtJobRequest;
