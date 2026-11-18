import {
  ACTION_PHASE_SLOTS,
  CLIP_SLOTS,
  ONE_SHOT_CLIP_SLOTS,
  exampleClips,
  exampleRig,
  type ArtDirection,
  type Character,
  type ClipSlot,
  type Rig,
} from "@anomaly/core";
import { toCanvasSpace } from "./frame.ts";

/**
 * Every prompt the art pipeline sends. Kept in one place so they can be
 * tuned (and compared across models) without touching pipeline logic.
 */

function directionText(direction: ArtDirection): string {
  return `${direction.style}\nPreferred palette: ${direction.palette.join(", ")}.`;
}

function roleOf(character: Character): string {
  if (character.kind === "player") return "player character (the hero)";
  // `movement` arrives with flying enemies; older schemas have ground enemies only.
  const movement = (character as { movement?: string }).movement;
  return movement === "flying" ? "flying enemy" : "ground enemy";
}

/** Width:height in words, so concepts come out with roughly the right build. */
function proportions(character: Character): string {
  const { width, height } = character.size;
  const ratio = width / height;
  if (ratio > 1.3) return `wider than tall (about ${ratio.toFixed(1)}:1)`;
  if (ratio < 0.77) return `taller than wide (about 1:${(1 / ratio).toFixed(1)})`;
  return "about as wide as tall";
}

// --- concepts ----------------------------------------------------------------

export function conceptPrompt(input: {
  character: Character;
  brief: string;
  direction: ArtDirection;
  feedback?: string;
  /** True when a reference image (the current design) is attached. */
  refining: boolean;
}): string {
  const { character, brief, direction, feedback, refining } = input;
  const lines = [
    refining
      ? `Concept art sheet: four variations on the attached character design for a 2D side-view action platformer ${roleOf(character)}: ${brief}.`
      : `Concept art sheet for a 2D side-view action platformer ${roleOf(character)}: ${brief}.`,
    "2x2 grid of four distinct design variations. Each is one full-body side view facing RIGHT (head toward the right edge), whole body visible and centered in its quadrant, separated by clear gaps, on a plain flat light-grey background.",
    `Body proportions: ${proportions(character)}.`,
    "Designed to be rebuilt from simple flat shapes: a bold readable silhouette, a few large parts, clearly separated limbs, no tiny details, no texture.",
    `Style: ${directionText(direction)}`,
    "No text, no labels, no frames, no ground scenery.",
  ];
  if (feedback?.trim()) lines.push(`Creator's direction for this round: ${feedback.trim()}`);
  return lines.join("\n");
}

export const FACING_PROMPT =
  'Which way is this character facing: toward the left or the right edge of the image (where its head/face is)? Reply with JSON only: {"facing": "left" | "right"}';

export const PICK_SYSTEM =
  "You are an art director for a 2D platformer. You judge concept sheets for readability at small size, " +
  "fit to the brief and style, and how easily the design can be rebuilt from simple flat shapes and animated.";

export function pickPrompt(brief: string, direction: ArtDirection, feedback?: string): string {
  return [
    "The image is a 2x2 concept sheet: cells 0 (top-left), 1 (top-right), 2 (bottom-left), 3 (bottom-right).",
    `Brief: ${brief}`,
    feedback ? `Creator's direction: ${feedback}` : "",
    `Style: ${directionText(direction)}`,
    'Pick the single best design. Reply with JSON only: {"cell": 0-3, "reason": "<one short sentence>"}',
  ]
    .filter(Boolean)
    .join("\n");
}

// --- rig -------------------------------------------------------------------

const RIG_SPEC = `A rig is JSON: {"bones": Bone[], "parts": Part[]}.

Coordinates: PIXELS OF THE CONCEPT IMAGE. Origin (0,0) at the image's top-left, x to the right, y DOWN. Trace the character where it is in the image (the pink grid lines are labelled in pixels to help you place points). The character faces right. Everything is drawn in the rest pose in this one shared frame (not relative to bones). The game scales and positions the result itself.

Bone: {"id": "snake_case", "parent": "<bone id>" | null, "pivot": [x, y]}
  Exactly one root bone (parent null), placed at the feet/ground contact under the body. The pivot is the joint the bone rotates about (hip, shoulder, neck, base of a tail).
  Typical: root at the feet; body near the torso centre; head at the neck; one bone per leg/arm/wing/antenna/tail at its base.

Part: {"id", "bone", "z", "shape", "fill", "shade"?, "ink"?, "glow"?, "opacity"?, "bendTo"?}
  bone: which bone moves it. z: draw order (higher = in front; far-side limbs lowest, near-side limbs above the body).
  shape is one of:
    {"type": "blob", "points": [[x,y], ...3-48], "smooth": 0..1, "sharp": [indices]}  closed shape; points go around the outline in order and must not cross. smooth 1 = curvy through every point, 0 = straight segments; "sharp" keeps chosen points as corners (horn tips, claws, cloak hems).
    {"type": "ellipse", "center": [x,y], "rx", "ry", "rotation": degrees}
    {"type": "stroke", "points": [[x,y], ...2-32], "width", "widthEnd", "smooth"}  open tapered line in image pixels (thin legs, antennae, tails, whiskers, detail lines).
  fill: "#rrggbb" (line color for strokes); pick it from the concept. shade: {"color": "#rrggbb", "angle": degrees (90 = darker toward the bottom)} for simple form shading.
  ink: outline thickness multiplier (default 1; 0 for glows/highlights/detail lines). Outlines are drawn automatically.
  glow: true for glowing eyes, lanterns, souls. bendTo: a second bone the part bends toward (cloaks, tails, soft bodies).`;

/** The example rig moved into a 512px canvas, so the example matches the coordinates we ask for. */
function exampleCanvasRig(): string {
  return JSON.stringify(toCanvasSpace(exampleRig(), { scale: 1 / 8, anchor: [256, 430] }));
}

export function rigSystemPrompt(direction: ArtDirection, canvas: { width: number; height: number }): string {
  return [
    "You are a 2D game character rigger. You rebuild a character from a concept image as a vector rig: flat shapes on bones, which the game draws and animates.",
    RIG_SPEC,
    `The concept image is ${canvas.width}x${canvas.height} pixels.`,
    "Guidelines:",
    "- Trace the concept's silhouette and proportions closely, then its colors; simplify details into a few clean shapes. 8-30 parts is typical.",
    "- Put everything that should move separately (head, each limb, wings, tail, antennae, cloak) on its own bone with a sensible pivot.",
    "- Draw limbs as whole shapes that start AT their bone's pivot, so rotating the bone swings them naturally.",
    "- Blobs need enough points (8-20) to follow curves; never let an outline cross itself. Big curved features (horns, shells, cloaks) need many points along the curve.",
    `Art direction: ${directionText(direction)}`,
    `Example of a valid rig (a small beetle in a 512x512 image), for format only:\n${exampleCanvasRig()}`,
  ].join("\n\n");
}

export function rigAuthorPrompt(character: Character, brief: string, canvas: { width: number; height: number }): string {
  return [
    `Build the rig for the character in the image (${canvas.width}x${canvas.height}px): ${brief}.`,
    `It is a ${roleOf(character)}; in the game its body is about ${character.size.width}x${character.size.height}px, so keep the overall proportions.`,
    "Trace it in image pixel coordinates. Ignore the background and the grid. Face right.",
    'Reply with JSON only: {"rig": {"bones": [...], "parts": [...]}, "notes": "<one sentence>"}',
  ].join("\n");
}

export function rigCritiquePrompt(input: {
  character: Character;
  brief: string;
  rig: Rig;
  warnings: string[];
  canvas: { width: number; height: number };
}): string {
  return [
    "Image 1 is the concept (with a pixel grid). Image 2 is the game's render of the current rig in the same framing. Image 3 is the render laid semi-transparently over the concept: wherever they don't line up, the rig is wrong.",
    `Brief: ${input.brief}. Coordinates are pixels of the ${input.canvas.width}x${input.canvas.height} concept image.`,
    input.warnings.length > 0 ? `Renderer warnings: ${input.warnings.join("; ")}` : "",
    `Current rig:\n${JSON.stringify(input.rig)}`,
    "Score how well the render matches the concept (0 = unrecognizable, 10 = clearly the same character, clean and appealing). Then fix the biggest problems: silhouette and proportions first (move points to where the concept's outline is), then missing features, colors, draw order, outlines crossing.",
    'Reply with JSON only: {"score": 0-10, "issues": ["<short>", ...], "rig": <the full improved rig, same coordinates>}',
  ]
    .filter(Boolean)
    .join("\n");
}

// --- cutout rig ----------------------------------------------------------------

const CUTOUT_SPEC = `A cutout rig animates the concept image itself: it is cut into pieces (parts), each moved by a bone. The pipeline cuts the character out of the background and traces every part's exact outline itself; you only decide the skeleton and roughly where each part is.

Coordinates: PIXELS OF THE IMAGE. Origin (0,0) at the top-left, x to the right, y DOWN (the pink grid lines are labelled in pixels). The character faces right.

Reply: {"bones": Bone[], "parts": Part[], "notes": "<one sentence>"}
Bone: {"id": "snake_case", "parent": "<bone id>" | null, "pivot": [x, y]}
  Exactly one root bone (parent null), at the feet/ground contact under the body. Every other bone's pivot is its JOINT: where the piece attaches to its parent (hip, shoulder, neck, base of a tail or wing), placed on the seam between the two pieces.
Part: {"id": "snake_case", "bone": "<bone id>", "z": int, "region": [[x,y], ...3-48]}
  region: a ROUGH polygon around the piece (a few points is enough; it may spill onto the background). Every pixel of the character goes to the part whose region holds it (the smallest region where they overlap), else to the nearest part, so regions only need to separate the pieces.
  z: draw order where pieces overlap when they move (higher = in front): far-side limbs lowest, body, head, near-side limbs highest.`;

export function cutoutSystemPrompt(canvas: { width: number; height: number }): string {
  return [
    "You are a 2D game character rigger. You split a character drawing into pieces on bones so the game can animate the drawing itself (like a paper cutout puppet).",
    CUTOUT_SPEC,
    `The image is ${canvas.width}x${canvas.height} pixels.`,
    "Guidelines:",
    "- One part per piece that should move on its own: head, torso, each leg / arm / wing, tail, antennae, a weapon. A body that should flex may be split into two parts on two bones. 4-16 parts is typical.",
    "- Pieces that move together (eyes on a head, a mask on a face) belong to the same part: do not cut them out separately.",
    "- Pivots decide how the pieces swing: put each one at the joint, never in the middle of a limb.",
  ].join("\n\n");
}

export function cutoutAuthorPrompt(character: Character, brief: string, canvas: { width: number; height: number }): string {
  return [
    `Plan the cutout rig for the character in the image (${canvas.width}x${canvas.height}px): ${brief}.`,
    `It is a ${roleOf(character)}, about ${character.size.width}x${character.size.height}px in the game.`,
    'Reply with JSON only: {"bones": [...], "parts": [...], "notes": "<one sentence>"}',
  ].join("\n");
}

export function cutoutCritiquePrompt(input: { plan: unknown; warnings: string[]; canvas: { width: number; height: number } }): string {
  return [
    "Review the cutout rig. Image 1 is the character (with a pixel grid). Image 2 shows how the pixels were split: each part tinted its own color, bone pivots as white squares (same grid). Image 3 shows the rig with every bone bent one way, then the other: pieces should swing at their joints like a puppet's, nothing should tear, float off or reveal holes.",
    `Coordinates are pixels of the ${input.canvas.width}x${input.canvas.height} image.`,
    input.warnings.length > 0 ? `Pipeline warnings: ${input.warnings.join("; ")}` : "",
    `Current plan:\n${JSON.stringify(input.plan)}`,
    "Score how well it will animate (0-10): pieces split where the character bends, joints where the pieces meet, sensible draw order. Then fix the biggest problems: split or merge parts, adjust regions, fix z. The pipeline puts each pivot in the middle of the seam between a piece and its parent's piece (the white squares), so to move a joint, move that seam by adjusting the regions. The drawing itself never changes.",
    'Reply with JSON only: {"score": 0-10, "issues": ["<short>", ...], "plan": <the full improved plan, same format> | null (null = keep it)}',
  ]
    .filter(Boolean)
    .join("\n");
}

// --- animation ----------------------------------------------------------------

const CLIP_SPEC = `A clip is JSON: {"duration": seconds, "loop": bool, "tracks": Track[], "motions": Motion[], "visibility": PartVisibility[]}.
Time t inside a clip is normalized 0..1. Values are offsets from the rest pose: rotate in degrees (positive = clockwise; the character faces right, so positive tips the front DOWN), x/y in px (y down), scaleX/scaleY multipliers (1 = rest).

Track: {"bone", "property": "rotate"|"x"|"y"|"scaleX"|"scaleY", "keys": [[t, value], ...], "ease": "smooth"|"linear"|"step"}  (for loops, make the last value equal the first)
Motion (animation primitives, added on top of tracks; whole-number cycles loop seamlessly):
  {"type": "sway", "bone", "degrees", "cycles", "phase"}   rotate ±degrees (legs, tails, wings, antennae)
  {"type": "bob", "bone", "amount", "cycles", "phase"}     move up/down ±amount px (body bounce, hovering)
  {"type": "shift", "bone", "amount", "cycles", "phase"}   move forward/back ±amount px
  {"type": "pulse", "bone", "amount", "cycles", "phase"}   scale ±amount (breathing)
  {"type": "squash", "bone", "amount", "at", "width"}      one squash (+) / stretch (-) pulse peaking at t=at
  {"type": "shake", "bone", "amount"}                      fast jitter in px (tension, rage)
  phase 0..1 offsets a cycle (use 0.5 for opposite legs).
PartVisibility: {"part", "keys": [[t, true|false], ...]}  show/hide a part (blinks).`;

export function animSystemPrompt(): string {
  return [
    "You are a 2D game animator. You write animation clips for a rig as JSON (flat vector shapes or cut-out pieces of a drawing; both move only by their bones). Clips must read clearly at small size: strong poses, clear timing, anticipation before attacks.",
    CLIP_SPEC,
    `Example clips for the example beetle rig (bones root, body, head, horn, leg_front, leg_mid, leg_back):\n${JSON.stringify(exampleClips())}`,
  ].join("\n\n");
}

/** Bones and parts in a compact form: enough to animate without the full geometry. */
export function rigSummary(rig: Rig): string {
  const parts = new Map<string, string[]>();
  for (const p of rig.parts) parts.set(p.bone, [...(parts.get(p.bone) ?? []), p.id]);
  const bones = rig.bones.map(
    (b) => `- ${b.id} (parent ${b.parent ?? "none"}, pivot [${b.pivot.join(", ")}]): ${(parts.get(b.id) ?? []).join(", ") || "no parts"}`,
  );
  return `Bones (pivot in rest pose; parts each bone moves):\n${bones.join("\n")}`;
}

/** The slots of an attack's hit and recovery (core ACTION_PHASE_SLOTS). */
const PHASE_SLOTS = new Set<string>(Object.values(ACTION_PHASE_SLOTS).flatMap((phases) => [phases.active[0]!, phases.recovery[0]!]));

/** Rigs cut from the drawing (cutout, traced): how to move them, and each joint's limits (the pipeline scales bigger moves down). */
function piecesText(limits: string): string {
  return `This rig is cut from a drawing: its pieces overlap only a little where they meet, so a joint turned or pulled too far opens a gap. Animate it like a cut-out puppet: body bob, breathing (pulse), squash and stretch, small limb swings, head tilts; carry big moves (leaps, recoils, falls, toppling over in death) on the root bone or a bone whose parent has no parts, which move freely. Joint limits (bigger moves are scaled down to these): ${limits}.`;
}

export function animPrompt(input: { character: Character; brief: string; rig: Rig; slots: ClipSlot[]; feedback?: string; limits?: string }): string {
  const { character, rig, slots } = input;
  const behavior =
    character.kind === "enemy"
      ? `Its behavior states: ${Object.entries(character.behavior.states)
          .map(([id, s]) => `${id} (${s.action.type})`)
          .join(", ")}.`
      : "It is controlled by the player: idle, run, jump, fall, hurt.";
  return [
    `The image shows the rig at rest. Character: ${input.brief}. A ${roleOf(character)}, ${character.size.width}x${character.size.height}px.`,
    behavior,
    rigSummary(rig),
    `Write exactly these clips, named by slot: ${slots.map((s) => `"${s}" (${CLIP_SLOTS[s]})`).join("; ")}.`,
    slots.some((s) => PHASE_SLOTS.has(s))
      ? "An attack plays its clips in a row: windup (anticipation, held as it loops), then the hit itself (strike / shoot / leap / slam / cast: short, fast, loop false, ending in the extended pose), then recover (loop false, from that pose back to rest). Make each clip start where the one before it ends."
      : "",
    slots.includes("death")
      ? 'death plays once when it is killed (loop false) and its last frame is held until it fades: recoil from the blow, then collapse, topple or come apart into a still final pose (no return to rest, nothing still moving at t=1; keep it at ground level, the feet are at y 0).'
      : "",
    "Keep motion believable for this body: legs alternate, heavy parts move less, wind-ups lean back before striking. Only animate bones listed above.",
    input.limits ? piecesText(input.limits) : "",
    input.feedback ? `Creator's direction: ${input.feedback}` : "",
    'Reply with JSON only: {"clips": {"<slot>": <clip>, ...}, "notes": "<one sentence>"}',
  ]
    .filter(Boolean)
    .join("\n");
}

export function animCritiquePrompt(input: { slots: string[]; clipsJson: string; framesPerClip: number; limits?: string }): string {
  const oneShots = ONE_SHOT_CLIP_SLOTS.filter((s) => input.slots.includes(s));
  return [
    `The image shows the clips as filmstrips: one row per clip in this order: ${input.slots.join(", ")}; ${input.framesPerClip} evenly spaced frames per row, left to right.`,
    `Current clips:\n${input.clipsJson}`,
    "Score the animation (0-10) for readability and appeal, then fix problems: limbs detaching or spinning wrongly, motion too small to see or too wild, wrong direction, missing anticipation, loops that pop.",
    input.limits ? `${piecesText(input.limits)} Gaps or holes at a joint mean that joint moved too far.` : "",
    oneShots.length > 0
      ? `${oneShots.join(" and ")} ${oneShots.length > 1 ? "play" : "plays"} once (loop false) and ${oneShots.length > 1 ? "hold their" : "holds its"} last frame${oneShots.includes("death") ? "; death must end in a still, clearly defeated pose" : ""}.`
      : "",
    'Reply with JSON only: {"score": 0-10, "issues": ["<short>", ...], "clips": {<the full improved clips, same names>}}',
  ]
    .filter(Boolean)
    .join("\n");
}
