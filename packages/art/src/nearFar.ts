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
 * branch) is shown on the design, one tinted orange and one cyan where it sticks out past the body, and the vision model says which is
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

/** A part's outline as a polygon (canvas px); a stroke as a chain of discs. */
function polygonsOf(part: Rig["parts"][number]): [number, number][][] {
  const s = part.shape;
  const circle = (x: number, y: number, rx: number, ry: number, n: number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [x + rx * Math.cos((i / n) * Math.PI * 2), y + ry * Math.sin((i / n) * Math.PI * 2)]);
  if (s.type === "ellipse") return [circle(s.center[0], s.center[1], s.rx, s.ry, 24)];
  if (s.type === "stroke") return s.points.map(([x, y]) => circle(x, y, s.width / 2, s.width / 2, 12));
  return [s.points as [number, number][]];
}

/**
 * The design with two branches tinted (canvas px, the rig's frame): only where a limb sticks out past
 * the body it hangs from (the parts of its ancestor bones), so its joint disk and painted-in hidden
 * stretch never sit on the body, and the overlap keeps the design's own drawing for the model to read.
 */
export function tintBranches(design: Pixels, rig: Rig, frame: Frame, first: string, second: string, colors: [[number, number, number], [number, number, number]]): Pixels {
  const canvas = toCanvasSpace(rig, frame);
  const out: Pixels = { width: design.width, height: design.height, data: Uint8Array.from(design.data) };
  const parentOf = new Map(canvas.bones.map((b) => [b.id, b.parent]));
  const ancestors = new Set<string>();
  for (const top of [first, second]) for (let at = parentOf.get(top) ?? null; at !== null; at = parentOf.get(at) ?? null) ancestors.add(at);
  const body = new Uint8Array(design.width * design.height);
  for (const part of canvas.parts) if (ancestors.has(part.bone)) for (const polygon of polygonsOf(part)) scan(design.width, design.height, polygon, (i) => (body[i] = 1));
  [first, second].forEach((top, k) => {
    const bones = branch(canvas, top);
    const color = colors[k]!;
    for (const part of canvas.parts) {
      if (!bones.has(part.bone)) continue;
      for (const polygon of polygonsOf(part)) {
        scan(design.width, design.height, polygon, (i) => {
          if (body[i] || out.data[i * 4 + 3]! < 16) return;
          for (let ch = 0; ch < 3; ch++) out.data[i * 4 + ch] = Math.round(design.data[i * 4 + ch]! * 0.45 + color[ch]! * 0.55);
        });
      }
    }
  });
  return out;
}

/** Visit the pixel indexes inside a polygon (scanline, pixel centres). */
function scan(width: number, height: number, polygon: [number, number][], visit: (i: number) => void) {
  if (polygon.length < 3) return;
  const ys = polygon.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(height, Math.ceil(Math.max(...ys))); y++) {
    const cuts: number[] = [];
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i]!;
      const [xj, yj] = polygon[j]!;
      if (yi > y + 0.5 !== yj > y + 0.5) cuts.push(xi + ((y + 0.5 - yi) / (yj - yi)) * (xj - xi));
    }
    cuts.sort((a, b) => a - b);
    for (let c = 0; c + 1 < cuts.length; c += 2) {
      for (let x = Math.max(0, Math.ceil(cuts[c]! - 0.5)); x < Math.min(width, Math.floor(cuts[c + 1]! + 0.5)); x++) visit(y * width + x);
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
