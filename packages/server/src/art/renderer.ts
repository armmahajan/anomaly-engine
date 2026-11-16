import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import {
  decodeRuntimeMessage,
  encodeStudioMessage,
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

export class BrowserRenderer implements Renderer {
  private browser: Browser | null = null;
  private page: Promise<Page> | null = null;
  private nextId = 1;
  private waiters = new Map<string, (m: Extract<RuntimeToStudio, { type: "rendered" }>) => void>();
  private ready: (() => void) | null = null;
  private readonly gameDir: string;
  private active = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** `gameDir`: the web export (apps/studio/public/game). */
  constructor(gameDir: string) {
    this.gameDir = gameDir;
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

  private async withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
    this.active++;
    clearTimeout(this.idleTimer);
    try {
      return await work(await this.open());
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
    this.page = null;
    await browser?.close();
  }

  private open(): Promise<Page> {
    this.page ??= this.launch().catch((error: unknown) => {
      this.page = null;
      throw error;
    });
    return this.page;
  }

  private async launch(): Promise<Page> {
    const { chromium } = await import("playwright-core");
    this.browser = await chromium.launch({
      // No GPU in headless Chromium: WebGL falls back to SwiftShader.
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    });
    const page = await this.browser.newPage({ viewport: { width: 320, height: 240 } });
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
    await page.exposeFunction("__anomalyRuntimeMessage", (data: string) => this.receive(data));
    await page.addInitScript(() => {
      window.addEventListener("message", (event) => {
        if (typeof event.data === "string" && event.data.includes('"anomaly-runtime"')) {
          (window as unknown as { __anomalyRuntimeMessage: (d: string) => void }).__anomalyRuntimeMessage(event.data);
        }
      });
    });
    const booted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("render runtime did not start (is the game exported? npm run build:game)")), BOOT_TIMEOUT_MS);
      this.ready = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    await page.goto(`${ORIGIN}/index.html?render=1`);
    await booted;
    return page;
  }

  private receive(data: string): void {
    const decoded = decodeRuntimeMessage(data);
    if (decoded.kind !== "message") return;
    const message = decoded.message;
    if (message.type === "ready") this.ready?.();
    if (message.type === "rendered") {
      this.waiters.get(message.requestId)?.(message);
      this.waiters.delete(message.requestId);
    }
  }
}
