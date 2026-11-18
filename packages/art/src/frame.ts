import { rigBounds, type Rig } from "@anomaly/core";

/**
 * Models trace far better in the concept image's own pixels than in an
 * abstract game frame. They author rigs in *canvas space* (concept pixels,
 * origin top-left, y down) and the pipeline maps them to *rig space*
 * (game px, origin at the feet):  rig = (canvas - anchor) * scale.
 */
export interface Frame {
  scale: number;
  anchor: [number, number];
}

/** How much bigger than the collision box the art may be (horns, antennae stick out). */
const ART_OVER_BOX = 1.2;

const round = (n: number) => Math.round(n * 10) / 10;

/** Frame that puts a canvas-space rig's feet at the origin and sizes it to the collision box. */
export function fitFrame(canvasRig: Rig, box: { width: number; height: number }): Frame {
  return fitBounds(rigBounds(canvasRig), box);
}

/** The same for canvas-space bounds (a cutout rig fits its opaque pixels, not its grown polygons). */
export function fitBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, box: { width: number; height: number }): Frame {
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const scale = Math.min((box.width * ART_OVER_BOX) / w, (box.height * ART_OVER_BOX) / h);
  return { scale, anchor: [(b.minX + b.maxX) / 2, b.maxY] };
}

/** Frame that shows an existing rig-space rig centred in a canvas, feet near the bottom (for revisions). */
export function frameForCanvas(rig: Rig, canvas: { width: number; height: number }): Frame {
  const b = rigBounds(rig);
  const scale = Math.max((b.maxX - b.minX) / (canvas.width * 0.7), (b.maxY - b.minY) / (canvas.height * 0.7), 0.001);
  const centerX = (b.minX + b.maxX) / 2;
  return { scale, anchor: [canvas.width / 2 - centerX / scale, canvas.height * 0.85] };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Map every coordinate in a rig by p * k + t (lengths by k). A cutout rig's source and part textures move with it. */
function mapRig(rig: Rig, k: number, t: readonly [number, number]): Rig {
  const point = ([x, y]: readonly [number, number]): [number, number] => [round(x * k + t[0]), round(y * k + t[1])];
  const length = k;
  // source: space = (image - anchor) * scale; afterwards (image - (anchor - t / (scale * k))) * scale * k.
  const s = rig.source;
  const source = s && { ...s, scale: s.scale * k, anchor: [s.anchor[0] - t[0] / (s.scale * k), s.anchor[1] - t[1] / (s.scale * k)] as [number, number] };
  return {
    ...(rig.mode ? { mode: rig.mode } : {}),
    ...(source ? { source } : {}),
    bones: rig.bones.map((b) => ({ ...b, pivot: point(b.pivot) })),
    parts: rig.parts.map((part) => {
      const s = part.shape;
      const shape =
        s.type === "ellipse"
          ? { ...s, center: point(s.center), rx: round(Math.max(0.5, s.rx * length)), ry: round(Math.max(0.5, s.ry * length)) }
          : s.type === "stroke"
            ? {
                ...s,
                points: s.points.map(point),
                width: round(Math.max(0.5, s.width * length)),
                ...(s.widthEnd !== undefined ? { widthEnd: round(s.widthEnd * length) } : {}),
              }
            : { ...s, points: s.points.map(point) };
      // A texture's rectangle maps like the shape (finer rounding: it places every texel).
      const r = part.texture?.rect;
      const rect = r && ([r2(r[0] * k + t[0]), r2(r[1] * k + t[1]), Math.max(0.01, r2(r[2] * k)), Math.max(0.01, r2(r[3] * k))] as [number, number, number, number]);
      return { ...part, shape, ...(part.texture && rect ? { texture: { ...part.texture, rect } } : {}) };
    }),
  };
}

export function toRigSpace(canvasRig: Rig, frame: Frame): Rig {
  const [ax, ay] = frame.anchor;
  return mapRig(canvasRig, frame.scale, [-ax * frame.scale, -ay * frame.scale]);
}

export function toCanvasSpace(rig: Rig, frame: Frame): Rig {
  return mapRig(rig, 1 / frame.scale, frame.anchor);
}

/** Width and height of a PNG (from its header). */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") throw new Error("not a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
