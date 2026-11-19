import type { ProjectSpec } from "../schema.ts";
import type { Asset } from "../art/asset.ts";
import type { FileRef } from "../art/fileRef.ts";
import { kitFiles } from "../art/world.ts";
import { rigFiles } from "../art/rig.ts";
import { defaultArchitectPlan } from "../architect/plan.ts";
import { PROTOCOL_VERSION, type WorldStart } from "../protocol.ts";
import { toRuntimeProject, type RuntimeProject } from "../world/runtime.ts";
import { exportBootPage } from "./bootPage.ts";
import { BROWSER_KEY_CODES, BROWSER_MOUSE_BUTTONS, controlAction, gameControlHelp, KEY_LABELS, MAX_KEYS_PER_ACTION, renderHelp } from "../controls/controls.ts";

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
/** localStorage key prefix for a player's own keys in an exported game (the boot page's). */
export const PLAYER_CONTROLS_PREFIX = "anomaly-controls:";
export const EXPORT_FORMAT = 1;

export interface ExportControl {
  /** With the game's keys. */
  keys: string;
  action: string;
  /** `keys` with {action_id} where an action's keys go: the page fills in the player's keys. */
  template: string;
}

/** What the boot page needs to show the keys and let players change them. */
export interface ExportControls {
  /** localStorage key of the player's own keys for this game ({ action: [key names] }). */
  storageKey: string;
  /** Shown when the game starts and from the ? button. */
  help: ExportControl[];
  /** The actions this game uses, which players can rebind; `keys` are the game's (project.controls). */
  actions: { id: string; label: string; keys: string[]; context: string; shares: string[] }[];
  maxKeys: number;
  /** Key name -> how it is shown; browser KeyboardEvent.code -> key name; browser MouseEvent.button -> key name. */
  keyLabels: Record<string, string>;
  browserCodes: Record<string, string>;
  browserButtons: Record<string, string>;
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
  /** Keyboard controls this game uses (shown briefly when it starts) and what players may rebind. */
  controls: ExportControls;
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
 * rooms or draw props, modal images, item icons, the images of every rig (characters and objects:
 * cutout sources, part textures), and weapon and projectile sprites. The studio sends the same set.
 */
export function runtimeImageRefs(project: Pick<ProjectSpec, "world" | "art"> & Partial<Pick<ProjectSpec, "weapons">>): FileRef[] {
  const biomes = usedBiomeIds(project);
  return [
    ...new Set([
      ...project.art.assets.flatMap((a) => (a.kind === "biome" && a.kit && biomes.has(a.id) ? kitFiles(a.kit) : [])),
      ...project.world.modals.flatMap((m) => (m.image ? [m.image] : [])),
      ...project.world.items.flatMap((i) => (i.icon ? [i.icon] : [])),
      ...project.art.assets.flatMap((a) => (a.kind === "character" && a.rig ? rigFiles(a.rig) : [])),
      ...(project.weapons?.list ?? []).flatMap(weaponFiles),
    ]),
  ].sort();
}

/** The images a weapon draws: its held sprite and its attacks' projectile sprites. */
export function weaponFiles(weapon: ProjectSpec["weapons"]["list"][number]): FileRef[] {
  return [
    ...(weapon.art.sprite ? [weapon.art.sprite] : []),
    ...weapon.attacks.flatMap((a) => (a.shape.type === "projectile" && a.shape.projectile.sprite ? [a.shape.projectile.sprite] : [])),
  ];
}

function usedBiomeIds(project: Pick<ProjectSpec, "world">): Set<string> {
  return new Set(project.world.rooms.flatMap((r) => [...(r.dressing ? [r.dressing.biome] : []), ...r.props.flatMap((p) => (p.art && "biome" in p.art ? [p.art.biome] : []))]));
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
    controls: exportControls(project, PLAYER_CONTROLS_PREFIX + name),
    project: runtime,
  };
  return { ok: true, data, page: exportBootPage(data), readme: exportReadme(data) };
}

/**
 * The keys this game uses (the basics, plus abilities it can grant, interacting and the map when it has
 * them; core gameControlHelp) with the game's keys, and the actions players may rebind.
 */
export function exportControls(project: ProjectSpec, storageKey = PLAYER_CONTROLS_PREFIX + exportFileName(project.name)): ExportControls {
  const { bindings } = project.controls;
  const { help, actions } = gameControlHelp(project);
  return {
    storageKey,
    help: help.map((h) => ({ action: h.action, template: h.template, keys: renderHelp(h.template, bindings) })),
    actions: actions.map((id) => {
      const info = controlAction(id)!;
      return { id, label: info.label, keys: [...bindings[id]], context: info.context, shares: [...(info.shares ?? [])] };
    }),
    maxKeys: MAX_KEYS_PER_ACTION,
    keyLabels: KEY_LABELS,
    browserCodes: BROWSER_KEY_CODES,
    browserButtons: BROWSER_MOUSE_BUTTONS,
  };
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
    `Saves are kept in each player's browser (localStorage, key "${data.saveKey}"), and so are the keys`,
    `a player changes from the ? button ("Change keys"; key "${data.controls.storageKey}").`,
    "",
  ].join("\n");
}
