import { crc32, deflateSync } from "node:zlib";
import { exampleClips, exampleRig } from "@anomaly/core";
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
    return { image: this.image, ext: "png", usage: { cost: 0.002, promptTokens: 100, completionTokens: 272 }, model: this.id };
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
    if (prompt.includes("That reply was invalid")) reply = { rig: exampleRig(), clips: exampleClips(), cell: 0, reason: "fixed", score: 7, issues: [] };
    else if (prompt.includes("Pick the single best design")) reply = { cell: 1, reason: "clearest silhouette" };
    else if (prompt.includes("Build the rig")) reply = { rig: exampleRig(), notes: "beetle" };
    else if (prompt.includes("Score how well the render matches")) reply = { score: 8, issues: ["horn a bit small"], rig: exampleRig() };
    else if (prompt.includes("Write these clips")) reply = { clips: exampleClips(), notes: "ok" };
    else if (prompt.includes("Score the animation")) reply = { score: 8, issues: [], clips: exampleClips() };
    else reply = { error: "fake model got an unexpected prompt" };
    return { text: "```json\n" + JSON.stringify(reply) + "\n```", usage, model: this.id };
  }
}
