/**
 * Triangle meshes for layered rigs (layered.ts): a simple polygon (the layer's outline) with
 * interior points, triangulated so every triangle stays inside the outline (ear clipping, then the
 * interior points inserted one by one with Delaunay edge flips that never cross the outline).
 * Pure geometry; no pixels.
 */

export type Vec = [number, number];

/** Twice the signed area of a, b, c (positive when a -> b -> c turns the positive way). */
export const orient = (a: Vec, b: Vec, c: Vec) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Signed area (shoelace; positive in the same sense as `orient`). */
export function polygonArea(poly: Vec[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j]![0] * poly[i]![1] - poly[i]![0] * poly[j]![1];
  return s / 2;
}

export function pointInPolygon(x: number, y: number, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(p: Vec, a: Vec, b: Vec): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Distance from a point to the polygon's outline. */
export function outlineDistance(p: Vec, poly: Vec[]): number {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segmentDistance(p, poly[j]!, poly[i]!));
  return d;
}

/** Segments ab and cd cross at a point inside both (touching at an end does not count). */
export function segmentsCross(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

/** No two edges cross and no point repeats. */
export function isSimple(poly: Vec[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  const seen = new Set<string>();
  for (const p of poly) {
    const key = `${p[0]},${p[1]}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

/** Removes crossings by reversing the stretch between two crossing edges (2-opt), at most `limit` times. */
export function untangle(poly: Vec[], limit = 200): Vec[] {
  const p = poly.slice();
  const n = p.length;
  for (let round = 0; round < limit; round++) {
    let fixed = false;
    outer: for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (segmentsCross(p[i]!, p[i + 1]!, p[j]!, p[(j + 1) % n]!)) {
          const mid = p.slice(i + 1, j + 1).reverse();
          p.splice(i + 1, mid.length, ...mid);
          fixed = true;
          break outer;
        }
      }
    }
    if (!fixed) break;
  }
  return p;
}

/** Drops repeated and (nearly) collinear points; orders the polygon positively. */
export function cleanPolygon(poly: Vec[]): Vec[] {
  let p = poly.filter((v, i) => {
    const prev = poly[(i + poly.length - 1) % poly.length]!;
    return v[0] !== prev[0] || v[1] !== prev[1];
  });
  for (let changed = true; changed && p.length > 3; ) {
    changed = false;
    for (let i = 0; i < p.length && p.length > 3; i++) {
      const a = p[(i + p.length - 1) % p.length]!;
      const b = p[i]!;
      const c = p[(i + 1) % p.length]!;
      const scale = Math.max(Math.hypot(c[0] - a[0], c[1] - a[1]), 1e-9);
      if (Math.abs(orient(a, b, c)) / scale < 1e-6) {
        p.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  if (polygonArea(p) < 0) p = p.reverse();
  return p;
}

/**
 * More outline points along long edges (so the outline bends smoothly with the mesh): each edge
 * split into pieces no longer than `maxLength` at its midpoint, the new points nudged a hair
 * outward so none is exactly collinear. A positively ordered polygon stays so.
 */
export function densify(poly: Vec[], maxLength: (mid: Vec) => number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    out.push(a);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const n = Math.ceil(len / Math.max(1e-6, maxLength([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])));
    for (let j = 1; j < n; j++) {
      const t = j / n;
      out.push([Math.round((a[0] + dx * t + (dy / len) * 0.05) * 1000) / 1000, Math.round((a[1] + dy * t - (dx / len) * 0.05) * 1000) / 1000]);
    }
  }
  return out;
}

/** Convex hull (positive order), for an outline nothing else can make simple. */
export function convexHull(points: Vec[]): Vec[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (pts: Vec[]) => {
    const h: Vec[] = [];
    for (const q of pts) {
      while (h.length >= 2 && orient(h[h.length - 2]!, h[h.length - 1]!, q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half(p.reverse())];
}

const inTriangle = (p: Vec, a: Vec, b: Vec, c: Vec) => orient(a, b, p) >= 0 && orient(b, c, p) >= 0 && orient(c, a, p) >= 0;

/** Triangles of a simple, positively ordered polygon (ear clipping), as index triples, each positively ordered. */
export function earClip(poly: Vec[]): [number, number, number][] {
  const idx = poly.map((_, i) => i);
  const out: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10_000) {
    const m = idx.length;
    let clipped = false;
    let fallback = -1;
    let fallbackArea = -Infinity;
    for (let i = 0; i < m; i++) {
      const a = idx[(i + m - 1) % m]!;
      const b = idx[i]!;
      const c = idx[(i + 1) % m]!;
      const area = orient(poly[a]!, poly[b]!, poly[c]!);
      if (area <= 0) continue;
      if (area > fallbackArea) (fallbackArea = area), (fallback = i);
      let blocked = false;
      for (const j of idx) {
        if (j === a || j === b || j === c) continue;
        const q = poly[j]!;
        if ((q[0] === poly[a]![0] && q[1] === poly[a]![1]) || (q[0] === poly[c]![0] && q[1] === poly[c]![1])) continue;
        if (inTriangle(q, poly[a]!, poly[b]!, poly[c]!)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Numerically stuck (nearly degenerate outline): clip the fattest convex corner.
      if (fallback < 0) break;
      const m2 = idx.length;
      out.push([idx[(fallback + m2 - 1) % m2]!, idx[fallback]!, idx[(fallback + 1) % m2]!]);
      idx.splice(fallback, 1);
    }
  }
  if (idx.length === 3 && orient(poly[idx[0]!]!, poly[idx[1]!]!, poly[idx[2]!]!) > 0) out.push([idx[0]!, idx[1]!, idx[2]!]);
  return out;
}

/** d lies inside the circle through a, b, c (a positively ordered triangle). */
function inCircle(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const adx = a[0] - d[0];
  const ady = a[1] - d[1];
  const bdx = b[0] - d[0];
  const bdy = b[1] - d[1];
  const cdx = c[0] - d[0];
  const cdy = c[1] - d[1];
  const det =
    (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) - (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) + (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
  return det > 1e-9;
}

/** A triangulation with fixed (outline) edges, refined by inserting points and flipping edges. */
class Triangulation {
  readonly tris: ([number, number, number] | null)[] = [];
  /** Directed edge a->b -> triangle holding it. */
  private readonly edges = new Map<number, number>();
  private readonly fixed = new Set<number>();

  readonly pts: Vec[];

  constructor(pts: Vec[], outline: number) {
    this.pts = pts;
    for (let i = 0; i < outline; i++) {
      const j = (i + 1) % outline;
      this.fixed.add(this.key(Math.min(i, j), Math.max(i, j)));
    }
  }

  private key(a: number, b: number) {
    return a * 65536 + b;
  }

  isFixed(a: number, b: number) {
    return this.fixed.has(this.key(Math.min(a, b), Math.max(a, b)));
  }

  add(t: [number, number, number]): number {
    const i = this.tris.length;
    this.tris.push(t);
    for (let e = 0; e < 3; e++) this.edges.set(this.key(t[e]!, t[(e + 1) % 3]!), i);
    return i;
  }

  remove(i: number): void {
    const t = this.tris[i]!;
    for (let e = 0; e < 3; e++) {
      const k = this.key(t[e]!, t[(e + 1) % 3]!);
      if (this.edges.get(k) === i) this.edges.delete(k);
    }
    this.tris[i] = null;
  }

  /** The triangle across edge a->b (the one holding b->a). */
  opposite(a: number, b: number): number | undefined {
    return this.edges.get(this.key(b, a));
  }

  /** Flip edge a->b of triangle (a, b, p) when the far point is in its circle (and the quad is convex), then check the new edges. */
  legalize(a: number, b: number, p: number, depth = 0): void {
    if (depth > 64 || this.isFixed(a, b)) return;
    const o = this.opposite(a, b);
    if (o === undefined) return;
    const t = this.tris[o]!;
    const d = t.find((v) => v !== a && v !== b)!;
    const P = this.pts;
    if (!inCircle(P[a]!, P[b]!, P[p]!, P[d]!)) return;
    if (orient(P[a]!, P[d]!, P[p]!) <= 0 || orient(P[d]!, P[b]!, P[p]!) <= 0) return;
    const mine = this.edges.get(this.key(a, b))!;
    this.remove(mine);
    this.remove(o);
    this.add([a, d, p]);
    this.add([d, b, p]);
    this.legalize(a, d, p, depth + 1);
    this.legalize(d, b, p, depth + 1);
  }

  /** Insert point `p` (an index into pts). False when it sits on the outline or outside every triangle. */
  insert(p: number): boolean {
    const P = this.pts;
    const q = P[p]!;
    for (let i = 0; i < this.tris.length; i++) {
      const t = this.tris[i];
      if (!t) continue;
      const [a, b, c] = t;
      const scale = Math.max(Math.abs(orient(P[a]!, P[b]!, P[c]!)), 1e-9);
      const eps = 1e-9 * scale;
      const o = [orient(P[a]!, P[b]!, q), orient(P[b]!, P[c]!, q), orient(P[c]!, P[a]!, q)];
      if (o.some((v) => v < -eps)) continue;
      const onEdge = o.findIndex((v) => Math.abs(v) <= eps);
      if (onEdge < 0) {
        this.remove(i);
        this.add([a, b, p]);
        this.add([b, c, p]);
        this.add([c, a, p]);
        this.legalize(a, b, p);
        this.legalize(b, c, p);
        this.legalize(c, a, p);
        return true;
      }
      // On edge (u, v) of this triangle (w opposite): split it and its neighbour.
      const u = t[onEdge]!;
      const v = t[(onEdge + 1) % 3]!;
      const w = t[(onEdge + 2) % 3]!;
      if (this.isFixed(u, v)) return false;
      const o2 = this.opposite(u, v);
      if (o2 === undefined) return false;
      const x = this.tris[o2]!.find((z) => z !== u && z !== v)!;
      this.remove(i);
      this.remove(o2);
      this.add([u, p, w]);
      this.add([p, v, w]);
      this.add([v, p, x]);
      this.add([p, u, x]);
      this.legalize(v, w, p);
      this.legalize(w, u, p);
      this.legalize(u, x, p);
      this.legalize(x, v, p);
      return true;
    }
    return false;
  }

  /** Flip every free edge that fails the circle test, until none does (or a pass limit). */
  delaunay(passes = 8): void {
    for (let pass = 0; pass < passes; pass++) {
      let flipped = false;
      for (let i = 0; i < this.tris.length; i++) {
        const t = this.tris[i];
        if (!t) continue;
        for (let e = 0; e < 3; e++) {
          const a = t[e]!;
          const b = t[(e + 1) % 3]!;
          const p = t[(e + 2) % 3]!;
          if (this.isFixed(a, b)) continue;
          const before = this.tris.length;
          this.legalize(a, b, p, 60);
          if (this.tris.length !== before) {
            flipped = true;
            break;
          }
        }
      }
      if (!flipped) break;
    }
  }
}

export interface TriangleMesh {
  /** The outline as triangulated (cleaned, positively ordered). */
  points: Vec[];
  /** Interior points that made it in (some are dropped: on the outline, or duplicates). */
  inner: Vec[];
  /** Index triples into points then inner, each positively ordered. */
  triangles: number[];
}

/**
 * Triangulate the polygon `outline` (simple; any orientation) with interior points `inner`: every
 * triangle lies inside the outline, every outline edge is a triangle edge, and the interior points
 * are vertices (those on the outline or repeated are dropped).
 */
export function triangulate(outline: Vec[], inner: Vec[]): TriangleMesh {
  const poly = cleanPolygon(outline);
  const n = poly.length;
  const pts: Vec[] = [...poly];
  const tri = new Triangulation(pts, n);
  for (const t of earClip(poly)) tri.add(t);
  tri.delaunay();
  const kept: Vec[] = [];
  const seen = new Set(poly.map((p) => `${p[0]},${p[1]}`));
  for (const q of inner) {
    const key = `${q[0]},${q[1]}`;
    if (seen.has(key) || !pointInPolygon(q[0], q[1], poly)) continue;
    pts.push(q);
    if (tri.insert(pts.length - 1)) {
      kept.push(q);
      seen.add(key);
    } else pts.pop();
  }
  tri.delaunay();
  // Indices: outline then the kept interior points (pts holds exactly those, in order).
  const triangles: number[] = [];
  for (const t of tri.tris) if (t) triangles.push(t[0], t[1], t[2]);
  return { points: poly, inner: kept, triangles };
}
