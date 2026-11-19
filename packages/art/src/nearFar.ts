import { z } from "zod";
import { swapRigBones, type Rig } from "@anomaly/core";
import { toCanvasSpace, type Frame } from "./frame.ts";
import { decodePng, encodePng, type Pixels } from "./match.ts";
import { NEAR_FAR_MARK, PICK_SYSTEM } from "./prompts.ts";
import { askJson, BudgetExceeded, type ArtContext } from "./stages.ts";

/**
 * Near/far check: a rig planned with two limbs labelled the wrong way round (the arm drawn in front
 * of the body named the far one) draws the wrong one in front and animates each with the other's
 * clips. Each near/far pair of limbs (bones named alike but for near/far, at the top of their
 * branch) is shown on the design, one tinted orange and one cyan, and the vision model says which is
 * in front of the body; asked twice with the colours swapped, and only when both answers agree that
 * the limb named far is the near one are the two swapped (core swapRigBones: names and draw order
 * trade places, nothing moves). Free on Claude Code; never fails the rig.
 */


const ORANGE: [number, number, number] = [255, 140, 0];
const CYAN: [number, number, number] = [0, 200, 255];

const twinOf = (id: string) => (/(^|_)near(_|$)/.test(id) ? id.replace(/(^|_)near(_|$)/, "$1far$2") : null);

/** Near/far limb pairs at the top of their branches: [near-named, far-named]. */
export function nearFarPairs(rig: Rig): [string, string][] {
  const ids = new Set(rig.bones.map((b) => b.id));
  const parentOf = new Map(rig.bones.map((b) => [b.id, b.parent]));
  const pairs: [string, string][] = [];
  for (const bone of rig.bones) {
    const twin = twinOf(bone.id);
    if (!twin || !ids.has(twin)) continue;
    // Only the top of a branch: a forearm comes along with its upper arm.
    const parent = parentOf.get(bone.id);
    if (parent && twinOf(parent) && ids.has(twinOf(parent)!)) continue;
    pairs.push([bone.id, twin]);
  }
  return pairs;
}

/** The bones of a branch (the bone and everything under it). */
function branch(rig: Rig, top: string): Set<string> {
  const out = new Set([top]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const b of rig.bones) if (b.parent !== null && out.has(b.parent) && !out.has(b.id)) (out.add(b.id), (grew = true));
  }
  return out;
}

/** The design with the parts of two branches tinted (canvas px, the rig's frame). */
export function tintBranches(design: Pixels, rig: Rig, frame: Frame, first: string, second: string, colors: [[number, number, number], [number, number, number]]): Pixels {
  const canvas = toCanvasSpace(rig, frame);
  const out: Pixels = { width: design.width, height: design.height, data: Uint8Array.from(design.data) };
  [first, second].forEach((top, k) => {
    const bones = branch(canvas, top);
    for (const part of canvas.parts) {
      if (!bones.has(part.bone)) continue;
      const s = part.shape;
      const polygon: [number, number][] =
        s.type === "ellipse"
          ? Array.from({ length: 24 }, (_, i) => [s.center[0] + s.rx * Math.cos((i / 24) * Math.PI * 2), s.center[1] + s.ry * Math.sin((i / 24) * Math.PI * 2)])
          : (s.points as [number, number][]);
      if (s.type === "stroke") {
        for (const [x, y] of s.points) fillPolygon(out, Array.from({ length: 12 }, (_, i) => [x + (s.width / 2) * Math.cos((i / 12) * Math.PI * 2), y + (s.width / 2) * Math.sin((i / 12) * Math.PI * 2)]), colors[k]!);
      } else fillPolygon(out, polygon, colors[k]!);
    }
  });
  return out;
}

/** Tint the opaque design pixels inside a polygon (half the colour, so the drawing still shows). */
function fillPolygon(image: Pixels, polygon: [number, number][], color: [number, number, number]) {
  if (polygon.length < 3) return;
  const ys = polygon.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(image.height, Math.ceil(Math.max(...ys))); y++) {
    const cuts: number[] = [];
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i]!;
      const [xj, yj] = polygon[j]!;
      if (yi > y + 0.5 !== yj > y + 0.5) cuts.push(xi + ((y + 0.5 - yi) / (yj - yi)) * (xj - xi));
    }
    cuts.sort((a, b) => a - b);
    for (let c = 0; c + 1 < cuts.length; c += 2) {
      for (let x = Math.max(0, Math.ceil(cuts[c]! - 0.5)); x < Math.min(image.width, Math.floor(cuts[c + 1]! + 0.5)); x++) {
        const i = (y * image.width + x) * 4;
        if (image.data[i + 3]! < 16) continue;
        for (let ch = 0; ch < 3; ch++) image.data[i + ch] = Math.round(image.data[i + ch]! * 0.45 + color[ch]! * 0.55);
      }
    }
  }
}

const Answer = z.object({ near: z.enum(["orange", "cyan", "unsure"]) });

const nearFarPrompt = (name: string) =>
  `This is ${name}, drawn from the side facing right. Two limbs are tinted: one ORANGE, one CYAN. ${NEAR_FAR_MARK}: drawn in front of the body where they overlap (nearer the viewer), with the other on the FAR side, partly hidden behind the body? Look at which one covers the body and which one the body covers. Reply as JSON {"near": "orange" | "cyan" | "unsure"}.`;

/**
 * Check every near/far pair of `rig` against the design (PNG, canvas px) and swap the pairs the
 * model says are labelled the wrong way round. Returns the rig (swapped or not) and the pairs swapped.
 */
export async function fixNearFar(ctx: ArtContext, input: { rig: Rig; frame: Frame; design: Buffer; name: string }): Promise<{ rig: Rig; swapped: [string, string][] }> {
  let rig = input.rig;
  const swapped: [string, string][] = [];
  const pairs = nearFarPairs(rig);
  if (pairs.length === 0) return { rig, swapped };
  let design: Pixels;
  try {
    design = decodePng(input.design);
  } catch {
    return { rig, swapped };
  }
  for (const [near, far] of pairs) {
    try {
      // Twice, the colours swapped: a colour or position bias can't swap a limb on its own.
      const asked = [];
      for (const colors of [
        [ORANGE, CYAN],
        [CYAN, ORANGE],
      ] as const) {
        const png = encodePng(tintBranches(design, rig, input.frame, near, far, [colors[0], colors[1]]));
        const { near: said } = await askJson(ctx, Answer, { system: PICK_SYSTEM, content: [{ type: "image", image: png }, { type: "text", text: nearFarPrompt(input.name) }], maxTokens: 400 }, `checking which of ${near} / ${far} is in front`);
        const nearColor = colors[0] === ORANGE ? "orange" : "cyan";
        asked.push(said === "unsure" ? "unsure" : said === nearColor ? "as named" : "swapped");
      }
      if (asked.every((a) => a === "swapped")) {
        const next = swapRigBones(rig, near, far);
        if (typeof next !== "string") {
          rig = next;
          swapped.push([near, far]);
          ctx.log({ text: `${near} and ${far} were labelled the wrong way round (the far one is drawn in front): swapped their names and draw order` });
        }
      }
    } catch (error) {
      if (error instanceof BudgetExceeded || ctx.signal?.aborted) throw error;
      ctx.log({ text: `could not check ${near} / ${far} (${error instanceof Error ? error.message : String(error)})` });
    }
  }
  return { rig, swapped };
}
