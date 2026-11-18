import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EXPORT_PATHS, fail, planGameExport, type ExportedFile, type ExportResult, type ProjectSpec } from "@anomaly/core";
import type { FileStore } from "../art/files.ts";
import { zipFiles, type ZipEntry } from "./zip.ts";

/** Files the web runtime needs (the Godot export names everything index.*); the rest of index.* comes along. */
const REQUIRED_RUNTIME_FILES = ["index.html", "index.js", "index.wasm", "index.pck"];
const ZIP_NAME = /^[a-z0-9-]+\.zip$/;

export interface GameExportOptions {
  /** The Godot web export the studio plays (apps/studio/public/game). */
  runtimeDir: string;
  /** Where exports are written: <outDir>/<name>/ and <outDir>/<name>.zip. */
  outDir: string;
  /** The project's image store (only the images the game is sent are copied). */
  files: FileStore;
}

/**
 * Build the standalone web game for `project` (see core export/gameExport.ts for the layout):
 * the folder <outDir>/<name>/ and <outDir>/<name>.zip of the same files (index.html at its root).
 * Holds only the boot page, game.json, README.txt, the referenced images and the runtime: nothing
 * else of the project (wiki, chats, history, plan, concepts, backups, tokens) is ever read.
 * The same project and runtime always give the same zip, byte for byte.
 */
export async function buildGameExport(project: ProjectSpec, options: GameExportOptions): Promise<ExportResult> {
  const plan = planGameExport(project);
  if (!plan.ok) return fail("invalid_input", plan.error);
  const { data } = plan;

  let runtimeNames: string[];
  try {
    runtimeNames = (await readdir(options.runtimeDir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.startsWith("index.")).map((e) => e.name);
  } catch {
    runtimeNames = [];
  }
  const missing = REQUIRED_RUNTIME_FILES.filter((f) => !runtimeNames.includes(f));
  if (missing.length > 0) return fail("unavailable", `the game runtime is not built (missing ${missing.join(", ")}): run npm run build:game`);

  const entries: (ZipEntry & { kind: ExportedFile["kind"] })[] = [
    { path: EXPORT_PATHS.page, data: Buffer.from(plan.page, "utf8"), kind: "page" },
    { path: EXPORT_PATHS.data, data: Buffer.from(JSON.stringify(data), "utf8"), kind: "data" },
    { path: EXPORT_PATHS.readme, data: Buffer.from(plan.readme, "utf8"), kind: "readme" },
  ];
  for (const ref of data.images) {
    try {
      entries.push({ path: `${EXPORT_PATHS.files}/${ref}`, data: await options.files.get(ref), kind: "art" });
    } catch {
      return fail("not_found", `the game uses the image ${ref}, which is missing from the project's files`);
    }
  }
  for (const name of runtimeNames) {
    entries.push({ path: `${EXPORT_PATHS.runtime}/${name}`, data: await readFile(join(options.runtimeDir, name)), kind: "runtime" });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Write next to the old export, then swap, so a failed build never leaves half a folder.
  await mkdir(options.outDir, { recursive: true });
  const folder = join(options.outDir, data.name);
  const tmp = join(options.outDir, `.${data.name}.${randomUUID()}.tmp`);
  try {
    for (const entry of entries) {
      const path = join(tmp, entry.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.data);
    }
    const zip = zipFiles(entries);
    await writeFile(join(tmp, ".zip"), zip);
    await rm(folder, { recursive: true, force: true });
    await rename(join(tmp, ".zip"), join(options.outDir, `${data.name}.zip`));
    await rename(tmp, folder);
    const files = entries.map((e) => ({ path: e.path, bytes: e.data.length, kind: e.kind }));
    return {
      ok: true,
      export: {
        name: data.name,
        title: data.title,
        zip: `${data.name}.zip`,
        zipBytes: zip.length,
        files,
        folderBytes: files.reduce((sum, f) => sum + f.bytes, 0),
        revision: project.revision,
      },
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Builds exports one at a time from the project as it is when each starts, and finds their zips. */
export class GameExporter {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly project: () => ProjectSpec;
  private readonly options: GameExportOptions;

  constructor(project: () => ProjectSpec, options: GameExportOptions) {
    this.project = project;
    this.options = options;
  }

  build(): Promise<ExportResult> {
    const run = this.queue.then(() => buildGameExport(this.project(), this.options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The zip of an export by its file name ("<name>.zip"), or null (unknown name or not built). */
  async zip(file: string): Promise<Buffer | null> {
    if (!ZIP_NAME.test(file)) return null;
    try {
      return await readFile(join(this.options.outDir, file));
    } catch {
      return null;
    }
  }
}
