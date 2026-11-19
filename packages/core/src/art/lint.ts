import type { ProjectSpec } from "../schema.ts";
import { rigBounds } from "./rig.ts";
import { ikProblem } from "./motion.ts";
import { dressingOutOfDate } from "../world/world.ts";

/** Art checks the schema can't express (see ../lint.ts). */

export type ArtWarningCode = "clip_unknown_bone" | "clip_unknown_part" | "clip_bad_ik" | "rig_size_mismatch" | "clips_without_idle" | "dressing_out_of_date";

export interface ArtWarning {
  code: ArtWarningCode;
  message: string;
  path: string;
}

/** Rig bounds may exceed the collision box (horns, antennae), but not wildly. */
const SIZE_TOLERANCE = 1.8;

export function lintArt(project: ProjectSpec): ArtWarning[] {
  const warnings: ArtWarning[] = [];
  project.world.rooms.forEach((room, i) => {
    if (dressingOutOfDate(room)) {
      warnings.push({
        code: "dressing_out_of_date",
        path: `world.rooms.${i}.dressing`,
        message: `room "${room.id}" changed since its art was composed; recompose it (worldCompose) so pieces sit on its new tiles`,
      });
    }
  });
  project.art.assets.forEach((asset, i) => {
    if (asset.kind !== "character") return;
    const path = `art.assets.${i}`;
    const { rig, clips } = asset;

    if (rig) {
      const bones = new Set(rig.bones.map((b) => b.id));
      const parts = new Set(rig.parts.map((p) => p.id));
      for (const [clipId, clip] of Object.entries(clips)) {
        const missingBones = new Set(
          [...clip.tracks.map((t) => t.bone), ...clip.motions.map((m) => m.bone)].filter((b) => !bones.has(b)),
        );
        if (missingBones.size > 0) {
          warnings.push({
            code: "clip_unknown_bone",
            path: `${path}.clips.${clipId}`,
            message: `clip "${clipId}" of "${asset.id}" animates missing bone(s) ${[...missingBones].join(", ")} (ignored)`,
          });
        }
        const missingParts = [...new Set([...clip.visibility.map((v) => v.part), ...(clip.looks ?? []).flatMap((l) => (l.part === undefined ? [] : [l.part]))])].filter((p) => !parts.has(p));
        if (missingParts.length > 0) {
          warnings.push({
            code: "clip_unknown_part",
            path: `${path}.clips.${clipId}`,
            message: `clip "${clipId}" of "${asset.id}" shows, hides or tints missing part(s) ${missingParts.join(", ")} (ignored)`,
          });
        }
        (clip.ik ?? []).forEach((track, k) => {
          const problem = ikProblem(rig, track);
          if (problem) {
            warnings.push({ code: "clip_bad_ik", path: `${path}.clips.${clipId}.ik.${k}`, message: `clip "${clipId}" of "${asset.id}": IK ${problem} (ignored)` });
          }
        });
      }

      const b = rigBounds(rig);
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      for (const c of project.characters) {
        if (c.appearance !== asset.id) continue;
        const off = (art: number, box: number) => art > box * SIZE_TOLERANCE || art < box / SIZE_TOLERANCE;
        if (off(w, c.size.width) || off(h, c.size.height)) {
          warnings.push({
            code: "rig_size_mismatch",
            path,
            message: `rig "${asset.id}" is ${Math.round(w)}x${Math.round(h)}px but "${c.id}" collides as ${c.size.width}x${c.size.height}px`,
          });
        }
      }
    }

    if (Object.keys(clips).length > 0 && !clips.idle) {
      warnings.push({
        code: "clips_without_idle",
        path: `${path}.clips`,
        message: `"${asset.id}" has clips but no "idle"; states without a clip will hold the rest pose`,
      });
    }
  });
  return warnings;
}
