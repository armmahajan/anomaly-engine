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
  close(): Promise<void>;
}

const ORIGIN = "http://localhost:47913";
const BOOT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 30_000;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
};

/** Cell crop of a 2x2 concept sheet, with a small inset to drop gutters. */
export function sheetCell(cell: number): { x: number; y: number; width: number; height: number } {
  const inset = 0.01;
  return { x: (cell % 2) * 0.5 + inset, y: Math.floor(cell / 2) * 0.5 + inset, width: 0.5 - 2 * inset, height: 0.5 - 2 * inset };
}

export class BrowserRenderer implements Renderer {
  private browser: Browser | null = null;
  private page: Promise<Page> | null = null;
  private nextId = 1;
  private waiters = new Map<string, (m: Extract<RuntimeToStudio, { type: "rendered" }>) => void>();
  private ready: (() => void) | null = null;
  private readonly gameDir: string;

  /** `gameDir`: the web export (apps/studio/public/game). */
  constructor(gameDir: string) {
    this.gameDir = gameDir;
  }

  async renderRig(request: Omit<RenderRigRequest, "requestId">): Promise<RenderedImage> {
    const page = await this.open();
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

  async crop(image: Buffer, region: { x: number; y: number; width: number; height: number }, maxSize: number): Promise<Buffer> {
    const page = await this.open();
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

  async close(): Promise<void> {
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
    await page.goto(`${ORIGIN}/index.html`);
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
