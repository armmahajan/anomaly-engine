import { decodeRuntimeMessage, PROTOCOL_VERSION, STUDIO_SOURCE, WorldScene } from "@anomaly/core";

/**
 * World preview (prototype): /world.html?w=<slug> loads a generated world from
 * /world-preview/<slug>/ (written by scripts/world-demo.ts) into the game
 * runtime, which pans slowly across it.
 */

const status = document.getElementById("status")!;
const frame = document.getElementById("game") as HTMLIFrameElement;
const slug = new URLSearchParams(location.search).get("w") ?? "";

async function base64(url: string): Promise<string> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function load(): Promise<{ scene: WorldScene; images: Record<string, string> }> {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("open /world.html?w=<slug>");
  const base = `/world-preview/${slug}`;
  const scene = WorldScene.parse(await (await fetch(`${base}/scene.json`)).json());
  const refs = [...new Set([scene.backdrop, scene.ground, ...scene.pieces.map((p) => p.file)])];
  const images = Object.fromEntries(await Promise.all(refs.map(async (ref) => [ref, await base64(`${base}/${ref}`)] as const)));
  return { scene, images };
}

const loaded = load();
window.addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow) return;
  const decoded = decodeRuntimeMessage(event.data);
  if (decoded.kind !== "message") return;
  if (decoded.message.type === "ready") {
    try {
      const { scene, images } = await loaded;
      status.textContent = `${scene.name}: ${scene.pieces.length} kit pieces, ${scene.placements.length} placements`;
      const message = { type: "previewWorld", scene, images };
      frame.contentWindow!.postMessage(JSON.stringify({ source: STUDIO_SOURCE, protocolVersion: PROTOCOL_VERSION, message }), location.origin);
    } catch (error) {
      status.textContent = `Could not load the world: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (decoded.message.type === "error") {
    status.textContent = `Runtime: ${decoded.message.message}`;
  }
});
