import { crc32, deflateSync } from "node:zlib";
import { CLIP_SLOTS, exampleClips, exampleRig } from "@anomaly/core";
import { pngSize } from "./frame.ts";
import { encodePng } from "./match.ts";
import { creaturePlan, drawCreatureSheet } from "./rigFixtures.ts";
import type { ImageModel, ImageRequest, GeneratedImage, VisionModel, VisionReply, VisionRequest } from "./models.ts";

/**
 * Scripted stand-ins for the art models: no network, no cost. They answer
 * each pipeline question with valid data (the example rig and clips), so the
 * whole pipeline can run in tests and e2e.
 */

/** A valid solid-color RGB PNG, so renderers and browsers can decode fake images. */
export function solidPng(width: number, height: number, rgb: [number, number, number] = [200, 198, 190]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3]!)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TINY_PNG = solidPng(64, 64);

/** Renderer stand-in: answers with solid PNGs of the right size. */
export class FakeRenderer {
  renders = 0;
  readonly crops: { x: number; y: number; width: number; height: number }[] = [];

  async renderRig(request: { cellWidth: number; cellHeight: number; columns: number; frames: unknown[] }) {
    // The real renderer's limit (game/scripts/art/render_service.gd MAX_FRAMES).
    if (request.frames.length < 1 || request.frames.length > 96) throw new Error("render failed: frames must have 1-96 entries");
    this.renders++;
    const rows = Math.ceil(request.frames.length / request.columns);
    return { png: solidPng(request.cellWidth * request.columns, request.cellHeight * rows, [this.renders % 256, 90, 90]), warnings: [] };
  }

  async crop(_image: Buffer, region: { x: number; y: number; width: number; height: number }, maxSize: number) {
    this.crops.push(region);
    return solidPng(Math.min(maxSize, 32), Math.min(maxSize, 32), [9, 9, 9]);
  }

  async compose(request: { width: number; height: number }) {
    return solidPng(request.width, request.height);
  }

  readonly worldRenders: { cameras: number[]; labels?: boolean }[] = [];

  async renderWorld(request: { cameras: number[]; width: number; height: number; labels?: boolean }) {
    this.worldRenders.push({ cameras: request.cameras, labels: request.labels });
    return { png: solidPng(request.width, request.height * request.cameras.length, [40, 60, 80]), warnings: [] };
  }

  async tileableX(image: Buffer) {
    return image;
  }

  /** Every cell of the sheet, as 16x24 pieces. */
  async sliceGrid(_image: Buffer, cols: number, rows: number) {
    return Array.from({ length: cols * rows }, (_, cell) => ({ png: solidPng(16, 24, [cell, 0, 0]), width: 16, height: 24, cell }));
  }
}

export class FakeImageModel implements ImageModel {
  readonly id = "fake/image";
  readonly requests: ImageRequest[] = [];
  private readonly image: Buffer;

  constructor(image: Buffer = TINY_PNG) {
    this.image = image;
  }

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    this.requests.push(request);
    // Each request gets different pixels (like a real model), unless a fixed image was given.
    const image =
      this.image !== TINY_PNG ? this.image : isConceptSheet(request.prompt)
          ? fakeConceptSheet(this.requests.length)
          : request.transparent && request.aspectRatio === "3:2"
            ? fakeSilhouettes(this.requests.length)
            : solidPng(64, 64, [this.requests.length % 256, 120, 140]);
    return { image, ext: "png", usage: { cost: 0.002, promptTokens: 100, completionTokens: 272 }, model: this.id };
  }
}

/** Answers by recognizing which prompt it got. Override `replies` to script specific answers. */
export class FakeVisionModel implements VisionModel {
  readonly id = "fake/vision";
  readonly requests: VisionRequest[] = [];
  /** Queue of raw replies to return first (e.g. invalid JSON to test repairs). */
  readonly replies: string[] = [];

  async complete(request: VisionRequest): Promise<VisionReply> {
    this.requests.push(request);
    const usage = { cost: 0.001, promptTokens: 2000, completionTokens: 800 };
    const queued = this.replies.shift();
    if (queued !== undefined) return { text: queued, usage, model: this.id };

    const prompt = request.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    let reply: unknown;
    const asked = (request.history ?? []).map((h) => (typeof h.content === "string" ? h.content : h.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"))).join("\n");
    if (prompt.includes("That reply was invalid") && asked.includes("Plan the kit of sprites")) reply = fakeKitPlan(asked);
    else if (prompt.includes("That reply was invalid") && asked.includes("Write the art direction for this game")) reply = fakeDirection(asked);
    else if (prompt.includes("That reply was invalid")) reply = { rig: exampleRig(), clips: exampleClips(), cell: 0, reason: "fixed", score: 7, issues: [] };
    else if (prompt.includes("Pick the single best design")) reply = { cell: 1, reason: "clearest silhouette" };
    else if (prompt.includes("Which way is this character facing")) reply = { facing: "left" };
    else if (prompt.includes("Build the rig")) reply = { rig: exampleRig(), notes: "beetle" };
    else if (prompt.includes("Score how well the render matches")) reply = { score: 8, issues: ["horn a bit small"], rig: exampleRig() };
    else if (prompt.includes("Write these clips")) reply = { clips: exampleClips(), notes: "ok" };
    // Clips asked by name (the animation list), not weapon attacks: those keep going through the repair path their tests expect.
    else if (prompt.includes("Write exactly these clips") && !prompt.includes("The hit (active window)") && customClipNames(prompt).length > 0) reply = { clips: fakeClips(prompt), notes: "ok" };
    else if (prompt.includes("Find where a hand holds it")) reply = fakeWeaponPoints(prompt);
    else if (prompt.includes("It holds a weapon")) reply = fakeWeaponClips(prompt);
    else if (prompt.includes("Score the animation")) reply = { score: 8, issues: [], clips: exampleClips() };
    else if (prompt.includes("Add detail shapes so the rig reads like the design")) reply = { details: fakeDetails(prompt), notes: "a highlight" };
    else if (prompt.includes("Score how well the detailed rig reads like the design")) reply = { score: 8, issues: [], details: fakeDetails(prompt) };
    else if (prompt.includes("Plan the cutout rig")) reply = fakeCutoutPlan(request);
    else if (prompt.includes("Review the cutout rig")) reply = { score: 8, issues: ["the head could turn further"], plan: null };
    else if (prompt.includes("Write the art direction for this game")) reply = fakeDirection(prompt);
    else if (prompt.includes("Plan the kit of sprites")) reply = fakeKitPlan(prompt);
    else if (prompt.includes("Non-empty cells")) {
      reply = {
        pieces: [
          { sheet: "structures", cell: 0, name: "Tall Pillar", kind: "structure", size: 420 },
          { sheet: "structures", cell: 1, name: "Root Curtain", kind: "hanging", size: 260 },
          { sheet: "structures", cell: 2, name: "Fallen Beam", kind: "span", size: 50 },
          { sheet: "props", cell: 0, name: "Lantern", kind: "light", size: 48, glow: "#ffcc80" },
          { sheet: "props", cell: 1, name: "Mushrooms", kind: "decor", size: 36 },
        ],
        ...(prompt.includes("drifts in its air") ? { particles: "spores" } : {}),
      };
    } else if (prompt.includes("Compose one room")) {
      reply = {
        palette: { ambient: "#8090a0", fog: "#3a5068", light: "#ffd9a0", shadow: "#05070a" },
        ...(prompt.includes("Also design the walkable layout")
          ? { platforms: [{ x: 0, y: 610, width: 1600, height: 110 }, { x: 600, y: 470, width: 220, height: 30 }] }
          : {}),
        placements: [
          { piece: "s0_tall_pillar", layer: "mid", x: 500, y: 610, scale: 1.5, flip: false },
          { piece: "s1_root_curtain", layer: "front", x: 900, y: 0, scale: 1, flip: true },
          { piece: "p0_lantern", layer: "play", x: 700, y: 470, scale: 1, flip: false },
          { piece: "p1_mushrooms", layer: "play", x: 300, y: 610, scale: 1, flip: false },
        ],
        lights: [],
        fog: { mid: 0.5, back: 0.3, play: 0.2 },
        rays: [{ x: 1200, width: 240, angle: 15, alpha: 0.3 }],
        dust: { color: "#ffe2b0", amount: 80 },
      };
    }
    else if (prompt.includes("Score 1-10 how good it looks as a finished game room")) {
      reply = { score: 6, issues: ["the lantern hangs off its ledge"], fixes: [{ id: "pl_3", x: 650 }], add: [] };
    }
    else reply = fakeGameReply(prompt) ?? { error: "fake model got an unexpected prompt" };
    return { text: "```json\n" + JSON.stringify(reply) + "\n```", usage, model: this.id };
  }
}

/** A held object's grip near its left end and tip at its right end, in the shown image's px. */
function fakeWeaponPoints(prompt: string): unknown {
  const m = prompt.match(/The image is (\d+)x(\d+) px/);
  const [w, h] = m ? [Number(m[1]), Number(m[2])] : [100, 40];
  return { grip: [Math.round(w * 0.15), Math.round(h / 2)], tip: [Math.round(w * 0.97), Math.round(h / 2)], notes: "handle on the left" };
}

/** Each asked attack clip as a lazy swing of the first bone, peaking in the wind-up (the pipeline holds it to the attack). */
function fakeWeaponClips(prompt: string): unknown {
  const bone = prompt.match(/^- ([a-z0-9_]+) \(parent/m)?.[1] ?? "root";
  const names = [...prompt.matchAll(/^- "([a-z0-9_]+)":/gm)].map((m) => m[1]!);
  const clip = { duration: 0.4, loop: false, tracks: [{ bone, property: "rotate", keys: [[0, 0], [0.15, -12], [1, 0]], ease: "smooth" }], motions: [] };
  return { clips: Object.fromEntries(names.map((n) => [n, clip])), notes: "a swing" };
}

/** The clips the prompt asks for ("Write exactly these clips, named by ...: "a" (...); "b" (...)."): the example's clip of that name, else its idle clip under the asked name. */
function fakeClips(prompt: string): Record<string, unknown> {
  const examples = exampleClips() as Record<string, unknown>;
  return Object.fromEntries(askedClipNames(prompt).map((n) => [n, examples[n] ?? examples.idle]));
}

function askedClipNames(prompt: string): string[] {
  const line = prompt.match(/Write exactly these clips[^:]*: (.*)$/m)?.[1];
  return line ? [...line.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!) : [];
}

/** Asked clips that aren't standard slots (named in the animation list). */
const customClipNames = (prompt: string) => askedClipNames(prompt).filter((n) => !(n in CLIP_SLOTS));

/** One highlight inside the first listed part ("- id (bone b, ...): x a-b, y c-d"), so the detail pass has something to keep. */
function fakeDetails(prompt: string): unknown[] {
  const m = prompt.match(/^- ([a-z0-9_]+) \(bone [^)]*\): x (-?\d+)-(-?\d+), y (-?\d+)-(-?\d+)/m);
  if (!m) return [];
  const [x0, x1, y0, y1] = [m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number];
  const rx = Math.max(1, (x1 - x0) / 4);
  const ry = Math.max(1, (y1 - y0) / 4);
  return [{ id: "fake_highlight", on: m[1], shape: { type: "ellipse", center: [(x0 + x1) / 2, (y0 + y1) / 2], rx, ry }, fill: "#ffffff", opacity: 0.3, clip: true }];
}

// --- art direction and kit plans ---------------------------------------------------

/** A direction "from the wiki": names the game and the overview's first words, so tests can tell. */
function fakeDirection(prompt: string): unknown {
  const game = prompt.match(/^Game: (.+)$/m)?.[1] ?? "the game";
  const overview = prompt.match(/^Overview\. (.+)$/m)?.[1]?.slice(0, 80) ?? "";
  return {
    style: `Painted 2D game art for ${game}, drawn from its design: ${overview}. Clean outlines, simple bold shapes.`,
    palette: ["#101820", "#f0e6d2", "#3a6ea5", "#c8553d", "#8fb339", "#f2c14e"],
    ink: "#101820",
    inkWidth: 1.4,
    boil: 0.2,
  };
}

const STOP = new Set(["a", "an", "the", "of", "and", "with", "in", "on", "at", "to", "its", "for", "from", "under", "over", "set"]);

/** A kit plan built from the place's own words (each item names the place), with every role composition needs. */
function fakeKitPlan(prompt: string): unknown {
  const place = prompt.match(/^Place: (.+)$/m)?.[1] ?? "place";
  const words = place.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w));
  const [a = "place", b = a] = words;
  const item = (name: string, role: string) => ({ name, look: `a ${name} of the ${a} ${b}`, role });
  return {
    structures: [
      item(`${a} tower`, "standing"),
      item(`${b} wall`, "standing"),
      item(`${a} column`, "standing"),
      item(`${b} gate`, "standing"),
      item(`${a} mass`, "standing"),
      item(`${b} spire`, "standing"),
      item(`${a} drape`, "hanging"),
      item(`${b} overhang`, "hanging"),
      item(`${a} beam`, "span"),
    ],
    props: [
      item(`${a} lamp`, "light"),
      item(`${b} glow`, "light"),
      item(`${a} pebbles`, "ground"),
      item(`${b} sprigs`, "ground"),
      item(`${a} shards`, "ground"),
      item(`${b} pile`, "ground"),
      item(`${a} tufts`, "ground"),
      item(`${b} debris`, "ground"),
      item(`${a} tassel`, "hanging"),
    ],
    ground: `packed ${a} ${b} ground`,
  };
}

// --- game art stages (props) -------------------------------------------------------

/** Scripted answers for the game-art stages' prompts, or undefined. Props: the first gets a piece painted, the rest the kit's first piece. */
export function fakeGameReply(prompt: string): unknown {
  if (!prompt.includes("Choose a sprite for each object")) return undefined;
  const data = (label: string) => JSON.parse(prompt.split(`${label} (JSON): `)[1]!.split("\n")[0]!) as { id: string; name?: string | null }[];
  const pieces = data("Kit pieces");
  return {
    props: data("Props").map((p, i) =>
      i === 0 || pieces.length === 0
        ? { id: p.id, piece: null, paint: { name: `${p.name ?? p.id} block`, description: "a carved stone block", kind: "decor" } }
        : { id: p.id, piece: pieces[0]!.id },
    ),
  };
}

// --- cutout rigs (character art) ---------------------------------------------------
// Concept sheets show a drawn creature (rigFixtures.ts) so a cutout has something to cut out;
// the cutout plan is that creature's, sized to the image the model was shown.

const isConceptSheet = (prompt: string) => prompt.startsWith("Concept art sheet");

function fakeConceptSheet(n: number): Buffer {
  return encodePng(drawCreatureSheet(256, (n * 7) % 40));
}

function fakeCutoutPlan(request: VisionRequest): unknown {
  const shown = request.content.find((c) => c.type === "image");
  const { width, height } = shown?.type === "image" ? pngSize(shown.image) : { width: 512, height: 512 };
  return { ...creaturePlan(width, height), notes: "body, head, two legs" };
}

/** A wide transparent image with a band of "silhouettes" along its bottom (a background plane). */
function fakeSilhouettes(n: number): Buffer {
  const width = 96;
  const height = 64;
  const data = new Uint8Array(width * height * 4);
  for (let x = 0; x < width; x++) {
    const top = Math.round(height * (0.5 + 0.2 * Math.sin((x + n * 7) / 9)));
    for (let y = top; y < height; y++) data.set([30 + (n % 5) * 20, 40, 60, 255], (y * width + x) * 4);
  }
  return encodePng({ width, height, data });
}
