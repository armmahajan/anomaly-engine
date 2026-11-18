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
  /** Ask for designs ready to rig: a neutral pose, limbs apart, distinct colours, the whole figure inside its cell. */
  rigReady?: boolean;
}): string {
  const { character, brief, direction, feedback, refining } = input;
  const lines = [
    refining
      ? `Concept art sheet: four variations on the attached character design for a 2D side-view action platformer ${roleOf(character)}: ${brief}.`
      : `Concept art sheet for a 2D side-view action platformer ${roleOf(character)}: ${brief}.`,
    ...(input.rigReady
      ? [
          "2x2 grid of four distinct design variations, exactly one figure per quadrant. Each is one full-body side view facing RIGHT (head toward the right edge) in a neutral standing pose, ready to be cut apart into an animation puppet: upright, every limb fully visible and held a little apart from the body and from the other limbs (arms hanging slightly away from the torso, legs or paws a little apart), nothing crossing in front of the body.",
          "Draw the figures SMALL: each whole figure, from the top of the head to the soles of the feet (and tail tip to nose), spans only about two thirds of its quadrant, centered, with a wide empty band of background above the head, below the feet and on both sides. No part may touch or cross a quadrant's edge. Plain flat light-grey background. Nothing else in a quadrant: no effects, sparks, glows, shadows, ground, props or bits of the neighbouring designs.",
          "Adjacent parts in clearly different colours or values so each can be told apart at a glance (sleeves vs torso, shirt vs trousers, hands vs cuffs, head vs neck, legs vs body), even within a dark or single-colour outfit.",
        ]
      : [
          "2x2 grid of four distinct design variations. Each is one full-body side view facing RIGHT (head toward the right edge), whole body visible and centered in its quadrant, separated by clear gaps, on a plain flat light-grey background.",
        ]),
    `Body proportions: ${proportions(character)}.`,
    input.rigReady
      ? "Designed to be rebuilt from simple flat shapes: a bold readable silhouette, a few large parts, no tiny details, no texture."
      : "Designed to be rebuilt from simple flat shapes: a bold readable silhouette, a few large parts, clearly separated limbs, no tiny details, no texture.",
    `Style: ${directionText(direction)}`,
    "No text, no labels, no frames, no ground scenery.",
  ];
  if (feedback?.trim()) lines.push(`Creator's direction for this round: ${feedback.trim()}`);
  return lines.join("\n");
}

export const FACING_PROMPT =
  'Which way is this character facing: toward the left or the right edge of the image (where its head/face is)? Reply with JSON only: {"facing": "left" | "right"}';

/** Image edit: the chosen design redrawn as clean flat art, so tracing it gives clean shapes. */
export function flatRedrawPrompt(brief: string): string {
  return [
    `Redraw the attached character as clean flat 2D game art for a cut-out animation puppet: ${brief}.`,
    "Keep exactly the same character: design, costume, proportions, pose and the side view facing RIGHT. Keep every colour exactly as in the attached image (the same hair colour, skin tone and clothing colours, picked from the image), only flattened.",
    "Flat colour only: every area one solid colour, no shading, gradients, highlights, texture or brush strokes. Adjacent parts in clearly different colours or values (sleeves vs torso, shirt vs trousers, hands vs cuffs).",
    "One clean, even, dark outline around the figure and around each limb; simple clean shapes; small features (eyes, ears, hands, feet) kept clear and readable.",
    "The whole figure centered with wide empty space on every side, on a plain flat light-grey background. Nothing else: no shadow, ground, effects, text or frame.",
  ].join("\n");
}

/** Image edit: the character taken apart into separate puppet pieces, each drawn whole. */
export function partsSheetPrompt(brief: string, pieces: string[]): string {
  return [
    `Cut-out puppet parts sheet for the attached character (${brief}): the same character taken apart into separate pieces, laid out in rows on a plain flat light-grey background, with wide empty gaps between the pieces (no piece touching another).`,
    `Draw exactly these ${pieces.length} pieces, each once and each as its own separate shape: ${pieces.map((p, i) => `(${i + 1}) ${p}`).join("; ")}.`,
    "Follow the list exactly: a limb is cut where the list cuts it (an upper leg and a lower leg are two separate pieces with a gap between them), a hand or foot named with a piece stays attached to that piece, and only one of each listed limb piece is drawn (one leg, not a pair of legs; one arm, not two).",
    "Draw every piece complete and whole, including what is normally hidden behind other pieces (the whole torso under the arm, the whole top of the leg), with rounded ends at the joints so the pieces can overlap there. Same side view facing RIGHT, same scale, proportions and colours as the character, flat colour, one clean dark outline around each piece.",
    "No shading, no text, no labels, no numbers, no pins or joint marks, no assembled character.",
  ].join("\n");
}

export const PICK_SYSTEM =
  "You are an art director for a 2D platformer. You judge concept sheets for readability at small size, " +
  "fit to the brief and style, and how easily the design can be rebuilt from simple flat shapes and animated.";

/** Words only a rig-ready concept prompt has: a sheet drawn with them was meant to be rigged as drawn. */
export const RIG_READY_MARK = "ready to be cut apart into an animation puppet";
/** Whether a concept sheet was drawn rig-ready (its stored prompt). */
export const isRigReadySheet = (prompt: string) => prompt.includes(RIG_READY_MARK);

export function pickPrompt(brief: string, direction: ArtDirection, feedback?: string, rigReady?: { cutOff: number[] }): string {
  return [
    "The image is a 2x2 concept sheet: cells 0 (top-left), 1 (top-right), 2 (bottom-left), 3 (bottom-right).",
    `Brief: ${brief}`,
    feedback ? `Creator's direction: ${feedback}` : "",
    `Style: ${directionText(direction)}`,
    rigReady
      ? `The design will be cut apart and animated, so prefer one in a neutral pose whose limbs are clearly apart from the body and whose adjacent parts have clearly different colours.${rigReady.cutOff.length > 0 ? ` Cells ${rigReady.cutOff.join(", ")} run off their quadrant's edge (cut off or crowded): do not pick them.` : ""}`
      : "",
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
  glow: true for glowing eyes, lights and other glowing parts. bendTo: a second bone the part bends toward (cloaks, tails, soft bodies).`;

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

/** Limbs split at the elbow / knee, for rigs that should bend naturally. */
export const LIMB_JOINTS =
  "Split every arm and leg at its elbow / knee (hock, for animals): an upper piece and a lower piece (with the hand / foot / paw) on two bones, the lower bone's parent the upper bone and its pivot at the elbow / knee. Necks and tails may get two bones too.";

export function rigAuthorPrompt(character: Character, brief: string, canvas: { width: number; height: number }, options: { limbJoints?: boolean } = {}): string {
  return [
    `Build the rig for the character in the image (${canvas.width}x${canvas.height}px): ${brief}.`,
    `It is a ${roleOf(character)}; in the game its body is about ${character.size.width}x${character.size.height}px, so keep the overall proportions.`,
    "Trace it in image pixel coordinates. Ignore the background and the grid. Face right.",
    options.limbJoints ? `${LIMB_JOINTS} Draw each limb piece as a whole shape from its pivot to the next joint, rounded at both ends so the pieces overlap at the joint when it bends.` : "",
    'Reply with JSON only: {"rig": {"bones": [...], "parts": [...]}, "notes": "<one sentence>"}',
  ]
    .filter(Boolean)
    .join("\n");
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

/** What to ask for in a traced rig's plan: the small details the redraw must keep. */
const FEATURES =
  'Also list "features": a point [x, y] on each small detail that must stay visible when the drawing is redrawn as flat shapes (eyes, ears, nose, mouth, hands, buttons, small marks), at most 16.';

export function cutoutAuthorPrompt(
  character: Character,
  brief: string,
  canvas: { width: number; height: number },
  options: { limbJoints?: boolean; features?: boolean } = {},
): string {
  return [
    `Plan the cutout rig for the character in the image (${canvas.width}x${canvas.height}px): ${brief}.`,
    `It is a ${roleOf(character)}, about ${character.size.width}x${character.size.height}px in the game.`,
    options.limbJoints ? `${LIMB_JOINTS} Draw each region around just that piece; 8-20 parts is typical.` : "",
    options.features ? FEATURES : "",
    `Reply with JSON only: {"bones": [...], "parts": [...]${options.features ? ', "features": [[x, y], ...]' : ""}, "notes": "<one sentence>"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function cutoutCritiquePrompt(input: {
  plan: unknown;
  warnings: string[];
  canvas: { width: number; height: number };
  /** Image 4 is the rig as drawn (a traced rig's flat redraw), checked against the character. */
  review?: boolean;
}): string {
  return [
    "Review the cutout rig. Image 1 is the character (with a pixel grid). Image 2 shows how the pixels were split: each part tinted its own color, bone pivots as white squares (same grid). Image 3 shows the rig with every bone bent one way, then the other: pieces should swing at their joints like a puppet's, nothing should tear, float off or reveal holes.",
    input.review
      ? 'Image 4 is the rig as the game draws it (flat shapes redrawn from the character), in the same framing as image 1. Compare it with image 1: list in issues any small feature that was lost (an eye, an ear, a hand), blotches or specks that are not in the character, and a figure cut off by the image edge. For each lost feature, add a point on it to the plan\'s "features" list (the redraw keeps the detail under each feature point), and return the plan even if nothing else changes.'
      : "",
    `Coordinates are pixels of the ${input.canvas.width}x${input.canvas.height} image.`,
    input.warnings.length > 0 ? `Pipeline warnings: ${input.warnings.join("; ")}` : "",
    `Current plan:\n${JSON.stringify(input.plan)}`,
    "Score how well it will animate (0-10): pieces split where the character bends, joints where the pieces meet, sensible draw order. Then fix the biggest problems: split or merge parts, adjust regions, fix z. The pipeline puts each pivot in the middle of the seam between a piece and its parent's piece (the white squares), so to move a joint, move that seam by adjusting the regions. The drawing itself never changes.",
    'Reply with JSON only: {"score": 0-10, "issues": ["<short>", ...], "plan": <the full improved plan, same format> | null (null = keep it)}',
  ]
    .filter(Boolean)
    .join("\n");
}

// --- puppet rig (parts sheet) ----------------------------------------------------

export const PUPPET_SYSTEM =
  "You are a 2D game character rigger. You assemble a cut-out animation puppet from separately drawn pieces of a character and check that it matches the character's design.";

/** The cutout plan, plus how each piece is drawn alone on a parts sheet. */
export function puppetPlanPrompt(character: Character, brief: string, canvas: { width: number; height: number }): string {
  return [
    cutoutAuthorPrompt(character, brief, canvas, { limbJoints: true }),
    'The pieces will be drawn again one by one on a puppet parts sheet. For each part also give "piece": what that piece is when drawn alone, in a few words (e.g. "the head with its hair", "the upper arm, shoulder to elbow", "the lower leg with the foot"). A far-side limb drawn like its near-side twin gets "twin": that part\'s id (drawn once, reused); its region still covers the far limb.',
    'Each part: {"id", "bone", "z", "region", "piece", "twin"?}. Keep a part per piece that moves on its own; 6-16 parts is typical.',
  ].join("\n");
}

export function puppetMatchPrompt(input: {
  parts: { id: string; piece: string; a: string; b: string }[];
  pieces: { n: number; box: { x0: number; y0: number; x1: number; y1: number } }[];
  sheet: { width: number; height: number };
}): string {
  return [
    "Image 1 is the character (with a pixel grid) and image 2 how it is split into parts (each part tinted). Image 3 is a parts sheet: the same character drawn again as separate pieces, each piece in a numbered coloured box (pixel grid on it too).",
    `Boxes on the ${input.sheet.width}x${input.sheet.height} sheet (x0, y0, x1, y1): ${input.pieces.map((p) => `${p.n}: ${p.box.x0},${p.box.y0},${p.box.x1},${p.box.y1}`).join("; ")}.`,
    `Parts to find, with the two points to mark on each: ${input.parts.map((p) => `"${p.id}" (${p.piece}): a = ${p.a}; b = ${p.b}`).join(" | ")}.`,
    'For each part give the number of the piece that draws it (null if the sheet has no such piece, or it is merged with another piece), the points a and b on that piece in sheet pixels, and "flip": true if the piece is drawn mirrored left-right compared with the character (facing the other way). Use each piece for one part at most.',
    'Reply with JSON only: {"parts": [{"id", "piece": n | null, "a": [x, y], "b": [x, y], "flip": bool}, ...]}',
  ].join("\n");
}

export function puppetCritiquePrompt(input: { parts: string[]; fallback: string[]; canvas: { width: number; height: number } }): string {
  return [
    "Review the assembled puppet. Image 1 is the character (with a pixel grid). Image 2 is the puppet put together from separately drawn pieces, laid semi-transparently over it (same grid): wherever they don't line up, a piece is misplaced, turned or the wrong size. Image 3 shows the puppet with every bone bent one way, then the other.",
    `Coordinates are pixels of the ${input.canvas.width}x${input.canvas.height} image. Parts: ${input.parts.join(", ")}.${input.fallback.length > 0 ? ` Parts drawn from the character itself (no piece): ${input.fallback.join(", ")}.` : ""}`,
    "Score how well it matches the character and holds together (0-10). Then fix misplaced pieces: for each, a nudge {id, dx, dy (px, moves the piece), rotate (degrees, clockwise, about its joint), scale (1 = as is)}. Nudges replace the previous ones; list every piece that needs one.",
    'Reply with JSON only: {"score": 0-10, "issues": ["<short>", ...], "nudges": [{"id", "dx", "dy", "rotate", "scale"}, ...]}',
  ].join("\n");
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
  // A traced rig's outlines and colour regions (ids ending _ink, _d<n>) go with their piece: list the pieces.
  const pieces = rig.mode === "traced" ? rig.parts.filter((p) => !/_(d\d+|ink)$/.test(p.id)) : rig.parts;
  for (const p of pieces) parts.set(p.bone, [...(parts.get(p.bone) ?? []), p.id]);
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

/** Rigs with elbows and knees: use them. */
const BEND_LIMBS =
  "Limbs with two bones (upper and lower, e.g. thigh and shin, upper arm and forearm): use both. In a walk or run the knee bends as the leg swings forward and passes under the body and straightens as the foot meets the ground; elbows stay a little bent and swing with the arm.";

export function animPrompt(input: {
  character: Character;
  brief: string;
  rig: Rig;
  slots: ClipSlot[];
  feedback?: string;
  limits?: string;
  limbJoints?: boolean;
}): string {
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
    input.limbJoints ? BEND_LIMBS : "",
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

// --- the look: detail shapes and paint-over textures ------------------------------------------------

const DETAIL_SPEC = `A detail is JSON: {"id": "snake_case", "on": "<part id>", "shape": <shape>, "fill": "#rrggbb", "opacity": 0..1, "clip": true|false, "ink": 0..3}
  on: the part it sits on. It moves with that part's bone and is drawn just above it, under any part in front of it.
  clip (default true): drawn only inside that part's shape, so it can overlap the edge freely (a shading band can be a big shape whose inner edge is the band's edge). false only for small accessories that stick out of the part (a buckle on a belt line, a tuft past an edge).
  shape: one of
    {"type": "blob", "points": [[x,y], ...3-48], "smooth": 0..1, "sharp": [indices]}  closed shape (bands, patches, highlights, panels, pockets, hair locks)
    {"type": "ellipse", "center": [x,y], "rx", "ry", "rotation": degrees}  (rivets, buttons, spots, round highlights)
    {"type": "stroke", "points": [[x,y], ...2-32], "width", "widthEnd", "smooth"}  open tapered line (folds, creases, seams, stitches, strands, scratches, fur marks)
  fill: the detail's colour (a stroke's line colour). opacity below 1 lets the part's colour through (soft shading, glints).
  ink: outline around the detail (default 0 = none; 0.5-1 only for accessories that need their own outline).
Coordinates: pixels of the rig render (origin top-left, y down), the same as the rig's parts.`;

export function detailSystemPrompt(direction: ArtDirection, canvas: { width: number; height: number }): string {
  return [
    "You are a 2D game character artist. A character is drawn in the game as a vector rig: flat shapes (parts) on bones, which the game animates. It animates well but looks plain next to its design. You add vector detail shapes on top of its parts so it reads like the design: shading bands on the side away from the light, highlights and rim light, folds and creases, seams and stitching, plates, panels and rivets, patterns, hair strands and locks, fur tufts, small accessories (buttons, buckles, straps, pockets), wear marks.",
    DETAIL_SPEC,
    `The rig render is ${canvas.width}x${canvas.height} pixels.`,
    "Guidelines:",
    "- The design shows WHICH details exist, their colours and the light direction; the rig render shows WHERE they go. The design may differ from the rig in pose and proportions: put each detail on the rig's own shapes, never at the design's coordinates.",
    "- Shading first: one darker band per big part on its shadow side (and a lighter one on its lit side where the design has it), following the part's shape. Then the design's most telling details. Then small touches.",
    "- Readable at small size: a few bold shapes beat many tiny ones. Nothing thinner than about 1.5% of the figure's height; folds and seams a little darker than the part, not black.",
    "- Keep the silhouette, the face's features (eyes, mouth, brows) and the existing detail parts readable: never cover them, never redraw a part.",
    "- Colours: shades and tints of the part's own fill, or colours picked from the design.",
    `Art direction: ${directionText(direction)}`,
  ].join("\n\n");
}

/** Parts as a compact list (id, bone, fill, bounds in the render's pixels) plus their shapes. */
function partsText(rig: Rig): string {
  const lines = rig.parts.map((p) => {
    const s = p.shape;
    const pts = s.type === "ellipse" ? [[s.center[0] - s.rx, s.center[1] - s.ry], [s.center[0] + s.rx, s.center[1] + s.ry]] : s.points;
    const xs = pts.map((q) => q[0]!);
    const ys = pts.map((q) => q[1]!);
    const r = (n: number) => Math.round(n);
    return `- ${p.id} (bone ${p.bone}, z ${p.z}, ${s.type}, fill ${p.fill}${p.clipTo ? `, detail on ${p.clipTo}` : ""}): x ${r(Math.min(...xs))}-${r(Math.max(...xs))}, y ${r(Math.min(...ys))}-${r(Math.max(...ys))}`;
  });
  const shapes = rig.parts.map((p) => ({ id: p.id, shape: p.shape }));
  return `Parts (back to front by z):\n${lines.join("\n")}\nTheir shapes:\n${JSON.stringify(shapes)}`;
}

export function detailAuthorPrompt(input: { brief: string; rig: Rig; maxDetails: number }): string {
  return [
    "Image 1 is the character's design. Image 2 is the game's render of its vector rig at rest, with a pixel grid (coordinates of the parts below).",
    `Character: ${input.brief}.`,
    partsText(input.rig),
    `Add detail shapes so the rig reads like the design: at most ${input.maxDetails} details.`,
    'Reply with JSON only: {"details": [<detail>, ...], "notes": "<one sentence>"}',
  ].join("\n");
}

export function detailCritiquePrompt(input: { brief: string; rig: Rig; details: unknown[]; maxDetails: number }): string {
  return [
    "Image 1 is the character's design. Image 2 is the game's render of its vector rig at rest with your detail shapes, with a pixel grid.",
    `Character: ${input.brief}.`,
    partsText(input.rig),
    `Current details (drawn in image 2):\n${JSON.stringify(input.details)}`,
    "Score how well the detailed rig reads like the design in look and finish (0 = plain or messy, 10 = clearly the design's character with its materials and details, clean at small size). Pose and proportions are not yours to fix.",
    `Then fix it: move details that landed in the wrong place, drop clutter and anything that hides the face or breaks the silhouette, add what the design has that is still missing (at most ${input.maxDetails} details in all).`,
    'Reply with JSON only: {"score": 0-10, "issues": ["<short>", ...], "details": [<the full improved list>]}',
  ].join("\n");
}

/** Image edit: the rig's pieces, pulled apart, painted over in the design's style (nothing moves). */
export function paintOverPrompt(brief: string, strict = false): string {
  return [
    `The first image is an exploded view of a 2D game character's cut-out puppet (${brief}): its pieces drawn as flat colour shapes with dark outlines, pulled slightly apart, on a plain flat light-grey background. The second image is the character's design.`,
    "Repaint the first image: paint every piece in the design's style, colours, materials, shading and surface detail (for example hair strands, fabric folds and seams, metal plates and dents, fur, skin shading, patterns), so each piece looks like that part of the design.",
    "Keep the first image's layout exactly: every piece stays exactly where it is, with the same outline, size and orientation, and keeps its dark outline. Do not move, join, add or remove pieces, and do not draw an assembled character. Keep the gaps between the pieces and the plain flat light-grey background. No text, labels, shadows, ground or frame.",
    strict
      ? "This is a texture-painting job on a fixed template, not a new drawing: the output is laid back over the first image pixel for pixel. Treat the first image as a colouring page: only paint inside each piece's outline. A piece that moves, grows, merges with its neighbour or is redrawn in another pose is wasted, and so is any piece painted where the first image has background."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
