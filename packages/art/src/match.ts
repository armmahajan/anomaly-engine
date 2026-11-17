import { crc32, deflateSync, inflateSync } from "node:zlib";

/**
 * How closely a rig matches its concept: the rest-pose render and the
 * concept, framed the same, compared by silhouette (intersection over union
 * of their opaque pixels) and by color where both are opaque. 0-1 each.
 * Also the small PNG codec the pipeline uses for pixel work (no native deps).
 */
export interface MatchScore {
  silhouette: number;
  color: number;
}

/** RGBA, 8 bits per channel, row-major. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Pixels this close to the background color (RGB distance) count as empty. */
const EMPTY_DISTANCE = 24;

export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Both PNGs the same size; the background (`background`, #rrggbb) and transparent pixels count as empty. */
export function matchScore(render: Buffer | Pixels, concept: Buffer | Pixels, background: string): MatchScore {
  const a = Buffer.isBuffer(render) ? decodePng(render) : render;
  const b = Buffer.isBuffer(concept) ? decodePng(concept) : concept;
  if (a.width !== b.width || a.height !== b.height) throw new Error(`matchScore: sizes differ (${a.width}x${a.height} vs ${b.width}x${b.height})`);
  const [br, bg, bb] = hexRgb(background);
  const solid = (d: Uint8Array, i: number) =>
    d[i + 3]! > 127 && Math.hypot(d[i]! - br, d[i + 1]! - bg, d[i + 2]! - bb) > EMPTY_DISTANCE;
  let both = 0;
  let either = 0;
  let similarity = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const sa = solid(a.data, i);
    const sb = solid(b.data, i);
    if (sa || sb) either++;
    if (sa && sb) {
      both++;
      const distance = Math.hypot(a.data[i]! - b.data[i]!, a.data[i + 1]! - b.data[i + 1]!, a.data[i + 2]! - b.data[i + 2]!);
      similarity += Math.max(0, 1 - distance / 255);
    }
  }
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { silhouette: either === 0 ? 0 : round(both / either), color: both === 0 ? 0 : round(similarity / both) };
}

/** One number for ranking attempts. */
export const matchValue = (m: MatchScore) => (m.silhouette + m.color) / 2;

/** `image` drawn over a solid background (alpha blended), opaque. */
export function flatten(image: Pixels, background: string): Pixels {
  const [br, bg, bb] = hexRgb(background);
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = image.data[i + 3]! / 255;
    data[i] = Math.round(image.data[i]! * a + br * (1 - a));
    data[i + 1] = Math.round(image.data[i + 1]! * a + bg * (1 - a));
    data[i + 2] = Math.round(image.data[i + 2]! * a + bb * (1 - a));
    data[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}

// --- PNG ------------------------------------------------------------------------

/** Decode a non-interlaced PNG (any color type, bit depth 1-16) to RGBA8. */
export function decodePng(png: Buffer): Pixels {
  if (png.length < 33 || png.toString("ascii", 1, 4) !== "PNG") throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let type = 6;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const kind = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (kind === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      if (body[12] !== 0) throw new Error("interlaced PNGs are not supported");
    } else if (kind === "PLTE") palette = body;
    else if (kind === "tRNS") transparency = body;
    else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`unsupported PNG color type ${type}`);
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const raw = inflateSync(Buffer.concat(idat));
  const rows = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out[x - bpp]! : 0;
      const up = prev[x]!;
      const corner = x >= bpp ? prev[x - bpp]! : 0;
      let v = line[x]!;
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - corner);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      out[x] = v & 255;
    }
    prev = out;
  }
  const data = new Uint8Array(width * height * 4);
  const max = (1 << depth) - 1;
  const sample = (row: Buffer, index: number): number => {
    if (depth === 8) return row[index]!;
    if (depth === 16) return row[index * 2]!;
    const bit = index * depth;
    return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & max;
  };
  const scale = (v: number) => (depth >= 8 ? v : Math.round((v * 255) / max));
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (type === 3) {
        const index = sample(row, x);
        data[o] = palette?.[index * 3] ?? 0;
        data[o + 1] = palette?.[index * 3 + 1] ?? 0;
        data[o + 2] = palette?.[index * 3 + 2] ?? 0;
        data[o + 3] = transparency && index < transparency.length ? transparency[index]! : 255;
      } else if (type === 0 || type === 4) {
        const g = scale(sample(row, x * channels));
        data[o] = data[o + 1] = data[o + 2] = g;
        data[o + 3] = type === 4 ? scale(sample(row, x * channels + 1)) : 255;
      } else {
        for (let c = 0; c < 3; c++) data[o + c] = scale(sample(row, x * channels + c));
        data[o + 3] = type === 6 ? scale(sample(row, x * channels + 3)) : 255;
      }
    }
  }
  return { width, height, data };
}

/** Encode RGBA8 pixels as a PNG. */
export function encodePng(image: Pixels): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const out = Buffer.alloc(8 + body.length + 4);
    out.writeUInt32BE(body.length, 0);
    typed.copy(out, 4);
    out.writeUInt32BE(crc32(typed) >>> 0, 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
