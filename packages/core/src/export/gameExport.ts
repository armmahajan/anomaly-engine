import type { ProjectSpec } from "../schema.ts";
import type { Asset } from "../art/asset.ts";
import type { FileRef } from "../art/fileRef.ts";
import { kitFiles } from "../art/world.ts";
import { rigFiles } from "../art/rig.ts";
import { defaultArchitectPlan } from "../architect/plan.ts";
import { PROTOCOL_VERSION, type WorldStart } from "../protocol.ts";
import { toRuntimeProject, type RuntimeProject } from "../world/runtime.ts";
import { exportBootPage } from "./bootPage.ts";

/**
 * Game export: what a standalone build of the game holds, as plain data (pure; the
 * server writes it to disk, see packages/server/src/export/). A bundle is
 *
 *   index.html        the boot page (bootPage.ts): hosts the runtime, sends it the game, starts it
 *   game.json         GameExportData: the runtime project, the start, the images to send, the controls
 *   files/<ref>       every image the runtime is sent (and no other file)
 *   runtime/index.*   the Godot web runtime, unchanged (the studio's own build)
 *   README.txt        how to host it
 *
 * Every path is relative, so the folder plays from any static host or subfolder.
 */

/** Where things live inside an export (relative to its index.html). */
export const EXPORT_PATHS = { page: "index.html", data: "game.json", files: "files", runtime: "runtime", readme: "README.txt" } as const;
/** The runtime's localStorage key prefix for a saved run (world_runtime.gd SAVE_PREFIX). */
export const RUNTIME_SAVE_PREFIX = "anomaly-save:";
export const EXPORT_FORMAT = 1;

export interface ExportControl {
  keys: string;
  action: string;
}

/** game.json: everything the boot page needs. */
export interface GameExportData {
  format: typeof EXPORT_FORMAT;
  protocolVersion: number;
  /** The game's name (the page title). */
  title: string;
  /** Safe file name (exportFileName); also the runtime project's id, so saves are kept per game. */
  name: string;
  /** localStorage key of the saved run (the runtime's own key for this game). */
  saveKey: string;
  /** Where a run begins: the world's start, with no abilities (as ▶ Play the game from its start). */
  start: WorldStart;
  /** Images to send to the runtime before it loads the game, served from files/. */
  images: FileRef[];
  /** Keyboard controls this game uses, shown briefly when it starts. */
  controls: ExportControl[];
  project: RuntimeProject;
}

export type GameExportPlan = { ok: true; data: GameExportData; page: string; readme: string } | { ok: false; error: string };

/** A safe file name from the game's name: lowercase ASCII letters, digits and dashes ("game" if nothing is left). */
export function exportFileName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "game";
}

/**
 * Every image the runtime is sent for this project (sorted, once each): the kits of biomes that dress
 * rooms or draw props, modal images, item icons, cutout rigs' images and rig part textures. The studio sends the same set.
 */
export function runtimeImageRefs(project: Pick<ProjectSpec, "world" | "art">): FileRef[] {
  const biomes = usedBiomeIds(project);
  return [
    ...new Set([
      ...project.art.assets.flatMap((a) => (a.kind === "biome" && a.kit && biomes.has(a.id) ? kitFiles(a.kit) : [])),
      ...project.world.modals.flatMap((m) => (m.image ? [m.image] : [])),
      ...project.world.items.flatMap((i) => (i.icon ? [i.icon] : [])),
      ...project.art.assets.flatMap((a) => (a.kind === "character" && a.rig ? rigFiles(a.rig) : [])),
    ]),
  ].sort();
}

function usedBiomeIds(project: Pick<ProjectSpec, "world">): Set<string> {
  return new Set(project.world.rooms.flatMap((r) => [...(r.dressing ? [r.dressing.biome] : []), ...r.props.flatMap((p) => (p.art ? [p.art.biome] : []))]));
}

/**
 * The runtime project as exported: toRuntimeProject without the Architect's plan and with only the
 * art the game draws (assets characters wear and biomes rooms or props use, their dressed rooms),
 * stripped of concepts, briefs and previews. Its id is the export's name, which keys the saves.
 */
export function exportRuntimeProject(project: ProjectSpec, name = exportFileName(project.name)): RuntimeProject {
  const runtime = toRuntimeProject(project);
  const worn = new Set(project.characters.flatMap((c) => (c.appearance ? [c.appearance] : [])));
  const biomes = usedBiomeIds(project);
  const dressed = new Set(project.world.rooms.flatMap((r) => (r.dressing ? [`${r.dressing.biome}/${r.dressing.room}`] : [])));
  const assets = runtime.art.assets.flatMap((asset): Asset[] => {
    const base = { id: asset.id, name: asset.name, brief: "", concepts: [], chosen: null };
    if (asset.kind === "character") {
      return worn.has(asset.id) && asset.rig ? [{ ...asset, ...base, preview: null, clipPreviews: {} }] : [];
    }
    if (!biomes.has(asset.id) || !asset.kit) return [];
    return [{ ...asset, ...base, rooms: asset.rooms.filter((r) => dressed.has(`${asset.id}/${r.id}`)).map((r) => ({ ...r, cost: 0 })) }];
  });
  return { ...runtime, id: name, architect: defaultArchitectPlan(), art: { direction: runtime.art.direction, assets } };
}

/** What the game export holds, or why it can't be made (no start). Deterministic: the same project gives the same plan. */
export function planGameExport(project: ProjectSpec): GameExportPlan {
  const start = project.world.start;
  if (!start || !project.world.rooms.some((r) => r.id === start.room)) {
    return { ok: false, error: "The game has no start: set one in Rooms (📍 Spot, then Set start here) before exporting." };
  }
  const name = exportFileName(project.name);
  const runtime = exportRuntimeProject(project, name);
  const data: GameExportData = {
    format: EXPORT_FORMAT,
    protocolVersion: PROTOCOL_VERSION,
    title: project.name,
    name,
    saveKey: RUNTIME_SAVE_PREFIX + name,
    start: { room: start.room, x: start.x, y: start.y, abilities: [] },
    images: runtimeImageRefs(runtime),
    controls: exportControls(project),
    project: runtime,
  };
  return { ok: true, data, page: exportBootPage(data), readme: exportReadme(data) };
}

const ABILITY_CONTROLS: Record<string, ExportControl> = {
  dash: { keys: "C / Shift / K", action: "dash" },
  double_jump: { keys: "Jump in the air", action: "jump again" },
  wall_jump: { keys: "Toward a wall, then jump", action: "wall jump" },
  glide: { keys: "Hold jump while falling", action: "glide" },
  ground_pound: { keys: "↓ + jump in the air", action: "ground pound" },
};

/** The keys this game uses: the basics, plus abilities it can grant, interacting and the map when it has them. */
export function exportControls(project: ProjectSpec): ExportControl[] {
  const granted = new Set<string>();
  const events = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "grantAbility" && typeof record.ability === "string") granted.add(record.ability);
    if (typeof record.type === "string") events.add(record.type);
    Object.values(record).forEach(walk);
  };
  walk(project.world);
  const controls: ExportControl[] = [
    { keys: "A / D or ← / →", action: "move" },
    { keys: "Space / Z", action: "jump" },
    { keys: "X / J (hold ↑ or ↓ to aim)", action: "attack" },
  ];
  for (const [ability, control] of Object.entries(ABILITY_CONTROLS)) if (granted.has(ability)) controls.push(control);
  if (events.has("interact")) controls.push({ keys: "W / ↑", action: "interact" });
  if (project.world.map.enabled) controls.push({ keys: "M / Tab", action: "map" });
  controls.push({ keys: "← / → and Enter", action: "choose in menus" });
  return controls;
}

function exportReadme(data: GameExportData): string {
  return [
    `${data.title}`,
    "",
    "A standalone web build of this game, made with Anomaly.",
    "",
    "To play it, serve this folder from any static web host (itch.io, GitHub Pages, Netlify, your own",
    "server; a subfolder works too) and open index.html. Browsers don't run it from a file:// path; to",
    "try it locally, run a static server in this folder, for example:",
    "",
    "  python3 -m http.server 8000      (then open http://localhost:8000)",
    "",
    `Saves are kept in each player's browser (localStorage, key "${data.saveKey}").`,
    "",
  ].join("\n");
}
