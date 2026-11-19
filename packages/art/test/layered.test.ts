import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyBatch, createDefaultProject, Rig, type FileRef, type OperationCall, type ProjectSpec } from "@anomaly/core";
import {
  bendPoint,
  blendWeight,
  boneTransforms,
  jointBetween,
  buildLayered,
  buildRig,
  chooseConcept,
  creaturePlan,
  cutCharacter,
  decodePng,
  drawCreature,
  drawCreatureSheet,
  drawLayered,
  encodePng,
  FakeImageModel,
  FakeRenderer,
  FakeVisionModel,
  jointBlend,
  LAYER_PAINT_MARK,
  orient,
  placeCutout,
  pointInPolygon,
  polygonArea,
  segmentsCross,
  triangulate,
  type ArtActivity,
  type ArtContext,
  type LayeredBuild,
  type Vec,
} from "../src/index.ts";

// Layered rigs (layered.ts, mesh.ts): the design split into part layers at full resolution, hidden
// stretches filled, each layer on a triangle mesh that bends across its joint.

const SIZE = 256;
const K = 2;
const FILE = `${"a".repeat(40)}.png`;

/** The creature drawn at twice the canvas size: the "native" design behind a 256 px pick. */
const nativeImage = drawCreature(SIZE * K, SIZE * K);
const native = cutCharacter(nativeImage)!;
const plan = creaturePlan(SIZE, SIZE);

/** A painter that knows what's behind: each hidden pixel gets a colour of its own part's region. */
const PAINT: [number, number, number] = [10, 200, 30];
function build(paint = false): LayeredBuild {
  return buildLayered(native, plan, K, paint ? () => PAINT : undefined);
}

/** Triangles of a mesh as vertex triples (native px). */
function triangles(mesh: { points: Vec[]; inner: Vec[]; triangles: number[] }): [Vec, Vec, Vec][] {
  const v = [...mesh.points, ...mesh.inner];
  const out: [Vec, Vec, Vec][] = [];
  for (let t = 0; t < mesh.triangles.length; t += 3) out.push([v[mesh.triangles[t]!]!, v[mesh.triangles[t + 1]!]!, v[mesh.triangles[t + 2]!]!]);
  return out;
}

const inTriangle = (p: Vec, [a, b, c]: [Vec, Vec, Vec]) => {
  const s = Math.sign(orient(a, b, c));
  return s * orient(a, b, p) >= -1e-9 && s * orient(b, c, p) >= -1e-9 && s * orient(c, a, p) >= -1e-9;
};

describe("triangulate", () => {
  it("fills a concave outline with interior points, every triangle inside it", () => {
    // An L shape with a notch.
    const outline: Vec[] = [[0, 0], [40, 0], [40, 10], [12, 10], [12, 40], [0, 40]];
    const inner: Vec[] = [];
    for (let y = 2; y < 40; y += 3) for (let x = 2; x < 40; x += 3) inner.push([x + 0.37, y + 0.21]);
    const mesh = triangulate(outline, inner);
    expect(mesh.inner.length).toBeGreaterThan(20);
    const tris = triangles(mesh);
    const area = tris.reduce((s, [a, b, c]) => s + Math.abs(orient(a, b, c)) / 2, 0);
    expect(area).toBeCloseTo(Math.abs(polygonArea(outline)), 6);
    for (const t of tris) {
      expect(orient(t[0], t[1], t[2])).toBeGreaterThan(0);
      const c: Vec = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3];
      expect(pointInPolygon(c[0], c[1], outline)).toBe(true);
    }
  });
});

describe("layered rig from a design", () => {
  const built = build();
  const rig = built.rigFor(FILE);
  const atlas = built.atlas.image;

  it("is a valid layered rig of textured meshes, one per part", () => {
    const parsed = Rig.safeParse(rig);
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.message)).toEqual([]);
    expect(rig.mode).toBe("layered");
    expect(rig.parts.map((p) => p.id).sort()).toEqual(["body", "head", "leg_far", "leg_near"]);
    for (const p of rig.parts) {
      expect(p.shape.type).toBe("mesh");
      expect(p.texture?.file).toBe(FILE);
      expect(p.texture?.uv).toEqual([0, 0, atlas.width, atlas.height]);
    }
    // Native resolution: the layers are packed at full size (no shrinking), so a canvas px is K texels.
    expect(built.atlas.scale).toBe(1);
    // Children bend toward their parent; the body (on the root's child) bends toward nothing that has parts.
    expect(rig.parts.find((p) => p.id === "head")?.bendTo).toBe("body");
    expect(rig.parts.find((p) => p.id === "leg_near")?.bendTo).toBe("body");
    expect(rig.parts.find((p) => p.id === "body")?.bendTo).toBeUndefined();
  });

  it("puts every vertex's uv on its own layer's pixels", () => {
    for (const piece of built.pieces) {
      const layer = built.layers.find((l) => l.part === piece.part)!;
      const [ax, ay, aw, ah] = piece.region;
      const part = rig.parts[piece.index]!;
      if (part.shape.type !== "mesh") throw new Error("not a mesh");
      const verts = [...piece.mesh.points, ...piece.mesh.inner];
      verts.forEach((v, i) => {
        const [u, w] = part.shape.type === "mesh" ? part.shape.uv[i]! : [0, 0];
        // Inside its own atlas region...
        expect(u).toBeGreaterThanOrEqual(ax - 0.01);
        expect(u).toBeLessThanOrEqual(ax + aw + 0.01);
        expect(w).toBeGreaterThanOrEqual(ay - 0.01);
        expect(w).toBeLessThanOrEqual(ay + ah + 0.01);
        // ...at the very spot of the layer the vertex sits on (native px).
        expect(piece.box.x + ((u - ax) * piece.box.width) / aw).toBeCloseTo(v[0], 1);
        expect(piece.box.y + ((w - ay) * piece.box.height) / ah).toBeCloseTo(v[1], 1);
        // Interior vertices on the layer's own opaque pixels show exactly that pixel.
        const lx = Math.floor(v[0]) - layer.x;
        const ly = Math.floor(v[1]) - layer.y;
        if (i < piece.mesh.points.length || lx < 0 || ly < 0 || lx >= layer.image.width || ly >= layer.image.height) return;
        const lo = (ly * layer.image.width + lx) * 4;
        if (layer.image.data[lo + 3]! < 255) return;
        const ao = (Math.floor(w) * atlas.width + Math.floor(u)) * 4;
        expect([...atlas.data.subarray(ao, ao + 4)]).toEqual([...layer.image.data.subarray(lo, lo + 4)]);
      });
    }
  });

  it("covers each layer's opaque pixels with triangles that stay inside its outline", () => {
    for (const piece of built.pieces) {
      const layer = built.layers.find((l) => l.part === piece.part)!;
      const tris = triangles(piece.mesh);
      const outline = piece.mesh.points;
      // Every triangle inside the outline: it tiles the outline exactly, and no edge crosses it.
      const area = tris.reduce((s, [a, b, c]) => s + Math.abs(orient(a, b, c)) / 2, 0);
      expect(area / Math.abs(polygonArea(outline))).toBeCloseTo(1, 4);
      for (const t of tris) {
        const c: Vec = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3];
        expect(pointInPolygon(c[0], c[1], outline)).toBe(true);
        for (const [p, q] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]] as const)
          for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) expect(segmentsCross(p, q, outline[j]!, outline[i]!)).toBe(false);
      }
      // The layer's opaque pixels (this piece's) fall in some triangle.
      let opaque = 0;
      let covered = 0;
      const { width: w, height: h, data } = layer.image;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3]! === 0) continue;
          const p: Vec = [layer.x + x + 0.5, layer.y + y + 0.5];
          if (!pointInPolygon(p[0], p[1], outline) && built.pieces.filter((q) => q.part === piece.part).length > 1) continue;
          opaque++;
          if (tris.some((t) => inTriangle(p, t))) covered++;
        }
      expect(covered / opaque).toBeGreaterThanOrEqual(0.98);
    }
  });

  it("weighs vertices toward the parent bone only near the joint, blending across the pivot", () => {
    for (const piece of built.pieces) {
      const part = rig.parts[piece.index]!;
      if (!part.bendTo) continue;
      const weights = part.shape.type === "mesh" ? part.shape.weights! : [];
      const pivotCanvas = rig.bones.find((b) => b.id === part.bone)!.pivot;
      const pivot: Vec = [pivotCanvas[0] * K - native.offset[0], pivotCanvas[1] * K - native.offset[1]];
      const blend = jointBlend(built.lp, piece.part, pivot)!;
      const verts = [...piece.mesh.points, ...piece.mesh.inner];
      let blended = 0;
      verts.forEach((v, i) => {
        const w = weights[i]!;
        expect(w).toBe(blendWeight(blend, v));
        const dist = Math.hypot(v[0] - pivot[0], v[1] - pivot[1]);
        if (dist > blend.reach + blend.r) expect(w).toBe(0);
        if (dist < blend.r && w > 0.02 && w < 0.98) blended++;
      });
      // Near the pivot, vertices sit in between (the joint bends, it doesn't hinge).
      expect(blended).toBeGreaterThan(0);
      expect(verts.some((v, i) => Math.hypot(v[0] - pivot[0], v[1] - pivot[1]) > blend.reach + blend.r && weights[i] === 0)).toBe(true);
    }
  });

  it("draws the design itself at rest (visible pixels unchanged)", () => {
    const size = { width: SIZE * K, height: SIZE * K };
    const drawn = drawLayered(rig, atlas, size, { scale: K });
    const design = placeCutout(native, size);
    let both = 0;
    let either = 0;
    let interior = 0;
    let same = 0;
    for (let i = 0; i < size.width * size.height; i++) {
      const a = drawn.data[i * 4 + 3]! > 127;
      const b = design.data[i * 4 + 3]! > 127;
      if (a || b) either++;
      if (a && b) both++;
      // Away from anti-aliased edges: the design's own colour.
      const x = i % size.width;
      const y = Math.floor(i / size.width);
      const solid = [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => design.data[((y + dy) * size.width + x + dx) * 4 + 3]! === 255));
      if (!solid) continue;
      interior++;
      const diff = Math.max(...[0, 1, 2].map((c) => Math.abs(drawn.data[i * 4 + c]! - design.data[i * 4 + c]!)));
      if (diff <= 3 && drawn.data[i * 4 + 3]! >= 254) same++;
    }
    expect(both / either).toBeGreaterThanOrEqual(0.99);
    expect(same / interior).toBeGreaterThanOrEqual(0.995);
  });

  it("opens no gaps at the joints when bent, with the hidden stretches filled", () => {
    const size = { width: SIZE * K, height: SIZE * K };
    const painted = build(true);
    const prig = painted.rigFor(FILE);
    expect(painted.layers.reduce((s, l) => s + l.painted, 0)).toBeGreaterThan(500);
    const rest = drawLayered(prig, painted.atlas.image, size, { scale: K });
    for (const angle of [-30, 30]) {
      const bent = drawLayered(prig, painted.atlas.image, size, { scale: K, rotate: { head: angle, leg_far: angle, leg_near: angle } });
      for (const id of ["head", "leg_far", "leg_near"]) {
        const [px, py] = prig.bones.find((b) => b.id === id)!.pivot.map((v) => v * K) as [number, number];
        const R = 10;
        const holes: string[] = [];
        for (let dy = -R; dy <= R; dy++)
          for (let dx = -R; dx <= R; dx++) {
            const x = Math.round(px + dx);
            const y = Math.round(py + dy);
            if (Math.hypot(dx, dy) > R) continue;
            const solid = (sx: number, sy: number) => [-2, 0, 2].every((ey) => [-2, 0, 2].every((ex) => rest.data[((Math.round(sy) + ey) * size.width + Math.round(sx) + ex) * 4 + 3]! >= 250));
            // Covered at rest, and still covered by the limb turned stiffly (where it turns away from, nothing need stay).
            const a = (-angle * Math.PI) / 180;
            const back: [number, number] = [px + dx * Math.cos(a) - dy * Math.sin(a), py + dx * Math.sin(a) + dy * Math.cos(a)];
            const inside = solid(x, y) && solid(back[0], back[1]);
            if (inside && bent.data[(y * size.width + x) * 4 + 3]! < 200) holes.push(`${dx},${dy}`);
          }
        expect(holes, `${id} at ${angle}°`).toEqual([]);
      }
    }
  });

  it("keeps the visible pixels when a painting fills what is hidden", () => {
    const painted = build(true);
    const size = { width: SIZE * K, height: SIZE * K };
    const plainRest = drawLayered(rig, atlas, size, { scale: K });
    const paintedRest = drawLayered(painted.rigFor(FILE), painted.atlas.image, size, { scale: K });
    let differ = 0;
    let total = 0;
    for (let i = 0; i < size.width * size.height; i++) {
      if (plainRest.data[i * 4 + 3]! < 255) continue;
      total++;
      if (Math.max(...[0, 1, 2].map((c) => Math.abs(plainRest.data[i * 4 + c]! - paintedRest.data[i * 4 + c]!))) > 3) differ++;
    }
    // The paint (a loud green) only goes where the design is hidden: nothing shows at rest.
    expect(differ / total).toBeLessThan(0.002);
    // Behind the near leg the body is green.
    const body = painted.layers.find((l) => plan.parts[l.part]!.id === "body")!;
    let green = 0;
    for (let i = 0; i < body.image.width * body.image.height; i++) if (!body.visible[i] && body.image.data[i * 4 + 1] === 200 && body.image.data[i * 4 + 3] === 255) green++;
    expect(green).toBeGreaterThan(100);
  });
});

describe("joints in motion", () => {
  it("bends by turning about the joint: the outside of a 90° bend keeps its distance from the joint", () => {
    const rig = { bones: [{ id: "upper", parent: null, pivot: [0, 0] as Vec }, { id: "fore", parent: "upper", pivot: [20, 0] as Vec }] };
    const pose = boneTransforms(rig as never, { fore: 90 });
    const A = pose.get("fore")!;
    const B = pose.get("upper")!;
    const joint = jointBetween(rig as never, "fore", "upper");
    expect(joint).toEqual([20, 0]);
    for (const w of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      for (const v of [[20, -5], [24, -5], [20, 5], [26, 6]] as Vec[]) {
        const rest = Math.hypot(v[0] - 20, v[1]);
        const bent = bendPoint(A, B, joint, w, v);
        expect(Math.abs(Math.hypot(bent[0] - 20, bent[1]) / rest - 1)).toBeLessThan(0.02);
      }
    }
    // The ends follow their bones exactly; a straight blend of positions would have cut the corner.
    expect(bendPoint(A, B, joint, 0, [40, -5])).toEqual([25, 20].map((n) => expect.closeTo(n, 6)));
    expect(bendPoint(A, B, joint, 1, [40, -5])).toEqual([40, -5]);
    const lerped: Vec = [(20 + 15) / 2, (-5 + 0) / 2];
    expect(Math.hypot(lerped[0] - 20, lerped[1]) / 5).toBeLessThan(0.75);
  });

  it("is opaque inside the figure at rest and bent, every seam backed by the layer behind it", () => {
    const built = build();
    const rig = built.rigFor(FILE);
    const size = { width: SIZE * K, height: SIZE * K };
    const design = placeCutout(native, size);
    for (const rotate of [{}, { head: 35, leg_far: -35, leg_near: 35 }, { head: -35, leg_far: 35, leg_near: -35 }] as Record<string, number>[]) {
      const drawn = drawLayered(rig, built.atlas.image, size, { scale: K, rotate });
      const rest = drawLayered(rig, built.atlas.image, size, { scale: K });
      let thin = 0;
      for (let y = 3; y < size.height - 3; y++)
        for (let x = 3; x < size.width - 3; x++) {
          const i = y * size.width + x;
          // Deep inside the body (away from the moving limbs' outer edges): fully covered.
          const deep = [-3, 0, 3].every((dy) => [-3, 0, 3].every((dx) => design.data[((y + dy) * size.width + x + dx) * 4 + 3] === 255 && rest.data[((y + dy) * size.width + x + dx) * 4 + 3]! >= 254));
          if (deep && drawn.data[i * 4 + 3]! < 254) {
            // Allowed only where a turned limb's own outline passes (it has moved off this spot).
            const near = [-3, 0, 3].some((dy) => [-3, 0, 3].some((dx) => drawn.data[((y + dy) * size.width + x + dx) * 4 + 3]! === 0));
            if (!near) thin++;
          }
        }
      expect(thin, JSON.stringify(rotate)).toBe(0);
    }
    // Every hidden pixel a part may take is filled (no transparent holes for a moving part to open).
    for (const layer of built.layers) {
      const hidden = built.lp.hidden[layer.part]!;
      let empty = 0;
      for (let y = 0; y < layer.image.height; y++)
        for (let x = 0; x < layer.image.width; x++)
          if (hidden[(y + layer.y) * built.lp.W + x + layer.x] && layer.image.data[(y * layer.image.width + x) * 4 + 3]! < 255) empty++;
      expect(empty).toBe(0);
    }
  });

  it("fills hidden stretches from the part's own interior colours, never its pale outer rim", () => {
    // The creature with a white rim around its outside (a halo the cutout kept).
    const rimmed = drawCreature(SIZE * K, SIZE * K);
    const cut = cutCharacter(rimmed)!;
    const { width: W, height: H, data } = cut.image;
    const out = cut.image.data.slice();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (data[i * 4 + 3] === 0) continue;
        const edge = [-2, 0, 2].some((dy) => [-2, 0, 2].some((dx) => data[((Math.min(H - 1, Math.max(0, y + dy))) * W + Math.min(W - 1, Math.max(0, x + dx))) * 4 + 3] === 0));
        if (edge) out.set([250, 250, 250, 255], i * 4);
      }
    const halo = { ...cut, image: { width: W, height: H, data: out } };
    const built = buildLayered(halo, plan, K);
    const body = built.layers.find((l) => plan.parts[l.part]!.id === "body")!;
    const hidden = built.lp.hidden[body.part]!;
    let pale = 0;
    let n = 0;
    for (let y = 0; y < body.image.height; y++)
      for (let x = 0; x < body.image.width; x++) {
        const i = y * body.image.width + x;
        if (body.visible[i] || !hidden[(y + body.y) * W + x + body.x]) continue;
        n++;
        if (body.image.data[i * 4]! > 180) pale++;
      }
    expect(n).toBeGreaterThan(500);
    expect(pale / n).toBeLessThan(0.01);
  });
});

// --- the stage -----------------------------------------------------------------------------------

class MemoryFiles {
  readonly files = new Map<FileRef, Buffer>();
  async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
    const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 40)}.${ext}`;
    this.files.set(ref, data);
    return ref;
  }
  async get(ref: FileRef): Promise<Buffer> {
    const data = this.files.get(ref);
    if (!data) throw new Error(`no file ${ref}`);
    return data;
  }
}

/** The paint-in answered by painting the marked parts back (the unmarked design, its second reference). */
class RestoringImage extends FakeImageModel {
  override async generate(request: Parameters<FakeImageModel["generate"]>[0]) {
    const done = await super.generate(request);
    return request.prompt.includes(LAYER_PAINT_MARK) ? { ...done, image: request.references![1]! } : done;
  }
}

/** A charger chosen from a 1536 px creature sheet and rigged in layered mode. */
async function layeredStage(image: FakeImageModel) {
  let project: ProjectSpec = createDefaultProject();
  const files = new MemoryFiles();
  const log: ArtActivity[] = [];
  {
    const ctx: ArtContext = {
      project: () => project,
      image,
      vision: new FakeVisionModel(),
      renderer: new FakeRenderer({ pixels: true }),
      files,
      log: (a) => log.push(a),
      remaining: () => 1,
      spend: () => {},
      rigRounds: 1,
    };
    const commit = (operations: OperationCall[]) => {
      const result = applyBatch(project, operations);
      if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues)}`);
      project = result.project;
    };
    // A 1536 px sheet: the chosen design is its cell at 512 px, the cell itself ~737 px (facing left: the choose stage mirrors it).
    const sheet = await files.put(encodePng(drawCreatureSheet(1536)), "png");
    commit([
      { name: "createAsset", input: { asset: { id: "look", name: "Look", kind: "character", brief: "a stout beast" }, assignTo: "charger" } },
      { name: "addConcept", input: { assetId: "look", concept: { file: sheet, prompt: "p", model: "m", cost: 0, at: "2026-01-01T00:00:00Z", recommended: { cell: 0, reason: "r" } } } },
    ]);
    commit((await chooseConcept(ctx, { characterId: "charger" })).operations);
    commit((await buildRig(ctx, { characterId: "charger", rigMode: "layered" })).operations);
  }
  return { project, files, log };
}

describe("the rig stage in layered mode", () => {
  it("builds from the sheet's full-resolution cell, paints in what's hidden with one image edit, and measures it", async () => {
    const image = new FakeImageModel();
    const { project, files, log } = await layeredStage(image);
    const asset = project.art.assets.find((a) => a.id === "look")!;
    if (asset.kind !== "character") throw new Error("no asset");
    const rig = asset.rig!;
    expect(Rig.safeParse(rig).success).toBe(true);
    expect(rig.mode).toBe("layered");
    expect(rig.parts.every((p) => p.shape.type === "mesh" && p.texture)).toBe(true);
    expect(log.some((a) => /layers: the design at 73\dx73\d px \(1\.4\dx the chosen design\)/.test(a.text))).toBe(true);
    // One image edit: the design with its near-side parts marked, and the design.
    const paints = image.requests.filter((r) => r.prompt.includes(LAYER_PAINT_MARK));
    expect(paints).toHaveLength(1);
    expect(paints[0]!.references).toHaveLength(2);
    expect(log.some((a) => /^layers: [1-9]\d* hidden px painted/.test(a.text))).toBe(true);
    // The atlas holds the layers at the cell's resolution: more texels than canvas px.
    const atlas = decodePng(await files.get(rig.parts[0]!.texture!.file));
    const part = rig.parts.find((p) => p.id === "body")!;
    if (part.shape.type !== "mesh") throw new Error("not a mesh");
    const xs = part.shape.uv.map((u) => u[0]);
    const canvasWidth = (Math.max(...part.shape.points.map((p) => p[0])) - Math.min(...part.shape.points.map((p) => p[0]))) / asset.preview!.frame!.scale;
    expect((Math.max(...xs) - Math.min(...xs)) / canvasWidth).toBeGreaterThan(1.35);
    expect(atlas.width).toBeLessThanOrEqual(1000);
    expect(asset.preview?.match).toBeDefined();
  }, 60_000);

  it("takes no paint from a model that paints the marked parts back instead of what they hid", async () => {
    const { project, log } = await layeredStage(new RestoringImage());
    expect(log.some((a) => /painted the marked parts back/.test(a.text))).toBe(true);
    expect(log.some((a) => /hidden px painted/.test(a.text))).toBe(false);
    const asset = project.art.assets.find((a) => a.id === "look")!;
    expect(asset.kind === "character" && asset.rig?.mode).toBe("layered");
  }, 60_000);
});
