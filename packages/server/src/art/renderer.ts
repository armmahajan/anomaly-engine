import { browserGlArgs } from "./glArgs.ts";
import { PagePool } from "./pagePool.ts";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import {
  decodeRuntimeMessage,
  encodeStudioMessage,
  PROTOCOL_VERSION,
  type RenderRigRequest,
  type RuntimeToStudio,
} from "@anomaly/core";
import type { Browser, Page } from "playwright-core";

/**
 * Server-side rendering for the art pipeline: rig previews (drawn by the real
 * Godot runtime, so the critic sees exactly what players see) and simple
 * image operations (cropping concept sheets). Runs the exported web runtime
 * in headless Chromium; nothing is served over the network.
 */

export interface RenderedImage {
  png: Buffer;
  width: number;
  height: number;
  /** Rig px -> image px. */
  scale: number;
  warnings: string[];
}

export interface Renderer {
  /** A cutout rig's source image travels in `images` (base64 by file ref); without it its parts are not drawn (a warning says so). */
  renderRig(request: Omit<RenderRigRequest, "requestId">): Promise<RenderedImage>;
  /** Crop a region (fractions of the image, 0..1) and scale it to fit `maxSize` px. Returns PNG. */
  crop(image: Buffer, region: { x: number; y: number; width: number; height: number }, maxSize: number): Promise<Buffer>;
  /** Stack images (each stretched to width x height) over a background, optionally with a labelled pixel grid. Returns PNG. */
  compose(request: ComposeRequest): Promise<Buffer>;
  close(): Promise<void>;
}

export interface ComposeRequest {
  width: number;
  height: number;
  background?: string;
  layers: { image: Buffer; alpha?: number; flipX?: boolean }[];
  /** Grid spacing in px (lines + coordinate labels), drawn on top. */
  grid?: number;
}

const ORIGIN = "http://localhost:47913";
const BOOT_TIMEOUT_MS = 60_000;
/** Close the browser after this long without work: an idle Godot page still redraws every frame. */
const IDLE_CLOSE_MS = 30_000;
const RENDER_TIMEOUT_MS = 30_000;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
};


/** In-page helpers (run in the render page): base64 PNG <-> canvas. */
const PAGE_HELPERS = `
window.__anomalyDecode = async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes]));
};
window.__anomalyEncode = async (canvas) => {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(binary);
};
`;

type PageWindow = Window & {
  __anomalyDecode: (data: string) => Promise<ImageBitmap>;
  __anomalyEncode: (canvas: OffscreenCanvas) => Promise<string>;
};

export interface SlicedPiece {
  png: Buffer;
  width: number;
  height: number;
  /** Grid cell index, reading order. */
  cell: number;
}

/**
 * One headless Chromium with a small pool of render pages (`pages`, default 1):
 * each request takes a free page, opening one more while there are fewer than
 * `pages`, else waits its turn. Several art jobs render side by side this way
 * while memory stays bounded (one browser, a few pages). Everything closes after
 * a while without work, and on close().
 */
export class BrowserRenderer implements Renderer {
  private browser: Promise<Browser> | null = null;
  private readonly pool: PagePool<Page>;
  private nextId = 1;
  private waiters = new Map<string, (m: Extract<RuntimeToStudio, { type: "rendered" }>) => void>();
  private readonly gameDir: string;
  private active = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** `gameDir`: the web export (apps/studio/public/game). `pages`: render pages at most (1..3). */
  constructor(gameDir: string, options: { pages?: number } = {}) {
    this.gameDir = gameDir;
    this.pool = new PagePool(() => this.openPage(), Math.min(3, Math.max(1, Math.floor(options.pages ?? 1))));
  }

  /** Render pages open now (tests, diagnostics). */
  get pages(): number {
    return this.pool.size;
  }

  renderRig(request: Omit<RenderRigRequest, "requestId">): Promise<RenderedImage> {
    return this.withPage((page) => this.render(page, request));
  }

  crop(image: Buffer, region: { x: number; y: number; width: number; height: number }, maxSize: number): Promise<Buffer> {
    return this.withPage((page) => this.cropOn(page, image, region, maxSize));
  }

  compose(request: ComposeRequest): Promise<Buffer> {
    return this.withPage((page) => this.composeOn(page, request));
  }

  /**
   * Make an image tile seamlessly left-to-right: the last `blend` fraction is
   * crossfaded over the start, and the result is that much narrower.
   */
  tileableX(image: Buffer, blend = 0.18): Promise<Buffer> {
    return this.withPage(async (page) => {
      const base64 = await page.evaluate(
        async ({ data, blend }) => {
          const w = window as unknown as PageWindow;
          const bitmap = await w.__anomalyDecode(data);
          const overlap = Math.round(bitmap.width * blend);
          const width = bitmap.width - overlap;
          const canvas = new OffscreenCanvas(width, bitmap.height);
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0);
          // The strip past `width` fades in over the start: at x=0 it is fully the tail, at x=overlap fully the head.
          const strip = new OffscreenCanvas(overlap, bitmap.height);
          const sctx = strip.getContext("2d")!;
          sctx.drawImage(bitmap, width, 0, overlap, bitmap.height, 0, 0, overlap, bitmap.height);
          sctx.globalCompositeOperation = "destination-in";
          const fade = sctx.createLinearGradient(0, 0, overlap, 0);
          fade.addColorStop(0, "rgba(0,0,0,1)");
          fade.addColorStop(1, "rgba(0,0,0,0)");
          sctx.fillStyle = fade;
          sctx.fillRect(0, 0, overlap, bitmap.height);
          ctx.drawImage(strip, 0, 0);
          return w.__anomalyEncode(canvas);
        },
        { data: image.toString("base64"), blend },
      );
      return Buffer.from(base64, "base64");
    });
  }

  /**
   * Cut a cols x rows sheet into pieces. Image models don't keep to the grid (a long beam
   * runs into the next cell, icicles hang into the one below), so pieces are found as
   * connected shapes over the whole sheet; each goes to the cell its centre is in, and a
   * piece is its cell's shapes with everything else cleared. A sheet whose shapes don't
   * separate (an opaque background) is cut along the grid instead. Empty cells are dropped.
   */
  sliceGrid(image: Buffer, cols: number, rows: number, maxSize = 512): Promise<SlicedPiece[]> {
    return this.withPage(async (page) => {
      const pieces = await page.evaluate(
        async ({ data, cols, rows, maxSize }) => {
          const w = window as unknown as PageWindow;
          const bitmap = await w.__anomalyDecode(data);
          const W = bitmap.width;
          const H = bitmap.height;
          const cw = Math.floor(W / cols);
          const ch = Math.floor(H / rows);
          const sheet = new OffscreenCanvas(W, H);
          const sctx = sheet.getContext("2d")!;
          sctx.drawImage(bitmap, 0, 0);
          const pixels = sctx.getImageData(0, 0, W, H).data;
          const solid = (i: number) => pixels[i * 4 + 3]! > 24;

          // Connected shapes (8-neighbour flood fill).
          const label = new Int32Array(W * H).fill(-1);
          const shapes: { minX: number; minY: number; maxX: number; maxY: number; area: number; sx: number; sy: number }[] = [];
          const stack: number[] = [];
          for (let start = 0; start < W * H; start++) {
            if (label[start] !== -1 || !solid(start)) continue;
            const id = shapes.length;
            const shape = { minX: W, minY: H, maxX: -1, maxY: -1, area: 0, sx: 0, sy: 0 };
            shapes.push(shape);
            label[start] = id;
            stack.push(start);
            while (stack.length) {
              const i = stack.pop()!;
              const x = i % W;
              const y = (i - x) / W;
              shape.area++;
              shape.sx += x;
              shape.sy += y;
              if (x < shape.minX) shape.minX = x;
              if (x > shape.maxX) shape.maxX = x;
              if (y < shape.minY) shape.minY = y;
              if (y > shape.maxY) shape.maxY = y;
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  const nx = x + dx;
                  const ny = y + dy;
                  if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                  const j = ny * W + nx;
                  if (label[j] === -1 && solid(j)) {
                    label[j] = id;
                    stack.push(j);
                  }
                }
              }
            }
          }
          const separable = shapes.every((s) => s.maxX - s.minX < 2 * cw || s.maxY - s.minY < 2 * ch);

          const out: { data: string; width: number; height: number; cell: number }[] = [];
          for (let cell = 0; cell < cols * rows; cell++) {
            const col = cell % cols;
            const row = Math.floor(cell / cols);
            let mine: Set<number>;
            let box: { minX: number; minY: number; maxX: number; maxY: number };
            if (separable) {
              mine = new Set(
                shapes
                  .map((s, id) => ({ s, id }))
                  .filter(({ s }) => Math.min(cols - 1, Math.floor(s.sx / s.area / cw)) === col && Math.min(rows - 1, Math.floor(s.sy / s.area / ch)) === row)
                  .map(({ id }) => id),
              );
              const parts = [...mine].map((id) => shapes[id]!);
              if (parts.reduce((a, s) => a + s.area, 0) < 64) continue;
              box = {
                minX: Math.min(...parts.map((s) => s.minX)),
                minY: Math.min(...parts.map((s) => s.minY)),
                maxX: Math.max(...parts.map((s) => s.maxX)),
                maxY: Math.max(...parts.map((s) => s.maxY)),
              };
            } else {
              // The grid cell, trimmed to its visible pixels.
              mine = new Set();
              box = { minX: W, minY: H, maxX: -1, maxY: -1 };
              for (let y = row * ch; y < (row + 1) * ch; y++) {
                for (let x = col * cw; x < (col + 1) * cw; x++) {
                  if (!solid(y * W + x)) continue;
                  if (x < box.minX) box.minX = x;
                  if (x > box.maxX) box.maxX = x;
                  if (y < box.minY) box.minY = y;
                  if (y > box.maxY) box.maxY = y;
                }
              }
              if (box.maxX < 0 || (box.maxX - box.minX) * (box.maxY - box.minY) < 64) continue;
            }
            const pw = box.maxX - box.minX + 1;
            const ph = box.maxY - box.minY + 1;
            const crop = new OffscreenCanvas(pw, ph);
            const cctx = crop.getContext("2d")!;
            cctx.drawImage(sheet, box.minX, box.minY, pw, ph, 0, 0, pw, ph);
            if (separable) {
              // Clear whatever belongs to other cells' shapes inside this box.
              const img = cctx.getImageData(0, 0, pw, ph);
              for (let y = 0; y < ph; y++) {
                for (let x = 0; x < pw; x++) {
                  const id = label[(box.minY + y) * W + box.minX + x]!;
                  if (id !== -1 && !mine.has(id)) img.data[(y * pw + x) * 4 + 3] = 0;
                }
              }
              cctx.putImageData(img, 0, 0);
            }
            const fit = Math.min(1, maxSize / Math.max(pw, ph));
            const piece = new OffscreenCanvas(Math.max(1, Math.round(pw * fit)), Math.max(1, Math.round(ph * fit)));
            piece.getContext("2d")!.drawImage(crop, 0, 0, pw, ph, 0, 0, piece.width, piece.height);
            out.push({ data: await w.__anomalyEncode(piece), width: piece.width, height: piece.height, cell });
          }
          return out;
        },
        { data: image.toString("base64"), cols, rows, maxSize },
      );
      return pieces.map((p) => ({ png: Buffer.from(p.data, "base64"), width: p.width, height: p.height, cell: p.cell }));
    });
  }

  /** Render a world scene from several camera positions (one frame per camera, stacked vertically). */
  async renderWorld(request: {
    scene: unknown;
    images: Record<string, string>;
    cameras: number[];
    width: number;
    height: number;
    labels?: boolean;
  }): Promise<RenderedImage> {
    return this.withPage(async (page) => {
      const requestId = `world_${this.nextId++}`;
      const reply = new Promise<Extract<RuntimeToStudio, { type: "rendered" }>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(requestId);
          reject(new Error(`world render timed out after ${(RENDER_TIMEOUT_MS * 4) / 1000}s`));
        }, RENDER_TIMEOUT_MS * 4);
        this.waiters.set(requestId, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
      const message = JSON.stringify({ source: "anomaly-studio", protocolVersion: PROTOCOL_VERSION, message: { type: "renderWorld", requestId, ...request } });
      await page.evaluate((m) => window.postMessage(m, window.location.origin), message);
      const result = await reply;
      if (result.error || !result.png) throw new Error(`world render failed: ${result.error ?? "no image"}`);
      return { png: Buffer.from(result.png, "base64"), width: result.width ?? 0, height: result.height ?? 0, scale: 1, warnings: result.warnings ?? [] };
    });
  }

  private async withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
    this.active++;
    clearTimeout(this.idleTimer);
    try {
      return await this.pool.use(work);
    } finally {
      this.active--;
      if (this.active === 0) this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
    }
  }

  private async render(page: Page, request: Omit<RenderRigRequest, "requestId">): Promise<RenderedImage> {
    const requestId = `render_${this.nextId++}`;
    const reply = new Promise<Extract<RuntimeToStudio, { type: "rendered" }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`render timed out after ${RENDER_TIMEOUT_MS / 1000}s`));
      }, RENDER_TIMEOUT_MS);
      this.waiters.set(requestId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    const message = encodeStudioMessage({ type: "renderRig", requestId, ...request });
    await page.evaluate((m) => window.postMessage(m, window.location.origin), message);
    const result = await reply;
    if (result.error || !result.png) throw new Error(`render failed: ${result.error ?? "no image"}`);
    return {
      png: Buffer.from(result.png, "base64"),
      width: result.width ?? 0,
      height: result.height ?? 0,
      scale: result.scale ?? 1,
      warnings: result.warnings ?? [],
    };
  }

  private async cropOn(
    page: Page,
    image: Buffer,
    region: { x: number; y: number; width: number; height: number },
    maxSize: number,
  ): Promise<Buffer> {
    const base64 = await page.evaluate(
      async ({ data, region, maxSize }) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes]));
        const sx = Math.round(region.x * bitmap.width);
        const sy = Math.round(region.y * bitmap.height);
        const sw = Math.round(region.width * bitmap.width);
        const sh = Math.round(region.height * bitmap.height);
        const fit = Math.min(1, maxSize / Math.max(sw, sh));
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(sw * fit)), Math.max(1, Math.round(sh * fit)));
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(binary);
      },
      { data: image.toString("base64"), region, maxSize },
    );
    return Buffer.from(base64, "base64");
  }

  private async composeOn(page: Page, request: ComposeRequest): Promise<Buffer> {
    const base64 = await page.evaluate(
      async ({ width, height, background, layers, grid }) => {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d")!;
        if (background) {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, width, height);
        }
        for (const layer of layers) {
          const bytes = Uint8Array.from(atob(layer.data), (c) => c.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes]));
          ctx.globalAlpha = layer.alpha;
          ctx.save();
          if (layer.flipX) {
            ctx.translate(width, 0);
            ctx.scale(-1, 1);
          }
          ctx.drawImage(bitmap, 0, 0, width, height);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        if (grid) {
          ctx.strokeStyle = "rgba(220, 40, 120, 0.45)";
          ctx.fillStyle = "rgba(200, 20, 100, 0.95)";
          ctx.lineWidth = 1;
          ctx.font = "11px sans-serif";
          for (let x = grid; x < width; x += grid) {
            ctx.beginPath();
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, height);
            ctx.stroke();
            ctx.fillText(String(x), x + 2, 11);
          }
          for (let y = grid; y < height; y += grid) {
            ctx.beginPath();
            ctx.moveTo(0, y + 0.5);
            ctx.lineTo(width, y + 0.5);
            ctx.stroke();
            ctx.fillText(String(y), 2, y - 2);
          }
        }
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(binary);
      },
      {
        width: request.width,
        height: request.height,
        background: request.background ?? null,
        layers: request.layers.map((l) => ({ data: l.image.toString("base64"), alpha: l.alpha ?? 1, flipX: l.flipX ?? false })),
        grid: request.grid ?? 0,
      },
    );
    return Buffer.from(base64, "base64");
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const browser = this.browser;
    this.browser = null;
    this.pool.clear();
    await (await browser?.catch(() => null))?.close();
  }

  private launchBrowser(): Promise<Browser> {
    this.browser ??= import("playwright-core")
      .then(({ chromium }) =>
        // WebGL on the GPU when there is one, else SwiftShader (ANOMALY_GL overrides; see glArgs.ts).
        chromium.launch({ args: browserGlArgs() }),
      )
      .catch((error: unknown) => {
        this.browser = null;
        throw error;
      });
    return this.browser;
  }

  /** A new render page in the shared browser, booted (the runtime said it is ready). */
  private async openPage(): Promise<Page> {
    const browser = await this.launchBrowser();
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    try {
      await page.route(`${ORIGIN}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname.replace(/^\//, "") || "index.html";
        const file = normalize(join(this.gameDir, path));
        if (!file.startsWith(normalize(this.gameDir) + sep)) return route.fulfill({ status: 404 });
        try {
          const body = await readFile(file);
          await route.fulfill({ status: 200, body, contentType: MIME[extname(file)] ?? "application/octet-stream" });
        } catch {
          await route.fulfill({ status: 404 });
        }
      });
      let ready: () => void = () => {};
      const booted = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("render runtime did not start (is the game exported? npm run build:game)")), BOOT_TIMEOUT_MS);
        ready = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      await page.exposeFunction("__anomalyRuntimeMessage", (data: string) => this.receive(data, ready));
      await page.addInitScript(PAGE_HELPERS);
      await page.addInitScript(() => {
        window.addEventListener("message", (event) => {
          if (typeof event.data === "string" && event.data.includes('"anomaly-runtime"')) {
            (window as unknown as { __anomalyRuntimeMessage: (d: string) => void }).__anomalyRuntimeMessage(event.data);
          }
        });
      });
      await page.goto(`${ORIGIN}/index.html?render=1`);
      await booted;
      return page;
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  private receive(data: string, ready: () => void): void {
    const decoded = decodeRuntimeMessage(data);
    if (decoded.kind !== "message") return;
    const message = decoded.message;
    if (message.type === "ready") ready();
    if (message.type === "rendered") {
      this.waiters.get(message.requestId)?.(message);
      this.waiters.delete(message.requestId);
    }
  }
}
