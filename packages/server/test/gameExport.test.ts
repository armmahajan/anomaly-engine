import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnRunner } from "@anomaly/agent";
import type { GameExportData } from "@anomaly/core";
import { buildGameExport, createProjectServer, FileStore, zipFiles } from "../src/index.ts";
import { artfulGame, UNUSED_REFS, USED_REFS } from "../../core/test/fixtures/exportGame.ts";

let dir: string;
let projectDir: string;
let runtimeDir: string;
let outDir: string;
let files: FileStore;

/** Entries of a zip, by path (reads the central directory; checks each entry's CRC). */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(dataAt, dataAt + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return out;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => relative(root, join(e.parentPath, e.name))).sort();
}

const RUNTIME = ["index.html", "index.js", "index.wasm", "index.pck", "index.audio.worklet.js", "index.icon.png"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anomaly-export-"));
  projectDir = join(dir, "project");
  runtimeDir = join(dir, "runtime");
  outDir = join(projectDir, "exports");
  await mkdir(runtimeDir, { recursive: true });
  for (const name of RUNTIME) await writeFile(join(runtimeDir, name), `runtime ${name} `.repeat(200));
  await writeFile(join(runtimeDir, "notes.txt"), "not part of the runtime");
  files = new FileStore(projectDir);
  await mkdir(files.dir, { recursive: true });
  for (const r of [...Object.values(USED_REFS), ...Object.values(UNUSED_REFS)]) await writeFile(files.path(r), `image ${r}`);
  // Everything else a project folder holds, none of which may be exported.
  await writeFile(join(projectDir, "project.json"), JSON.stringify(artfulGame()));
  await writeFile(join(projectDir, "history.jsonl"), "");
  await writeFile(join(projectDir, "design-notes.md"), "the-secret-wiki-sentence");
  await writeFile(join(projectDir, ".env"), "OPENROUTER_API_KEY=sk-secret");
  await writeFile(join(projectDir, ".studio-token"), "token-secret");
  await mkdir(join(projectDir, "backups", "old"), { recursive: true });
  await writeFile(join(projectDir, "backups", "old", "project.json"), "{}");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const build = (project = artfulGame()) => buildGameExport(project, { runtimeDir, outDir, files });

describe("game export builder", () => {
  it("writes the folder and its zip: the page, the data, the referenced art and the runtime, nothing else", async () => {
    const result = await build();
    if (!result.ok) throw new Error(result.error.message);
    const summary = result.export;
    const expected = [
      "README.txt",
      ...Object.values(USED_REFS)
        .sort()
        .map((r) => `files/${r}`),
      "game.json",
      "index.html",
      ...RUNTIME.map((n) => `runtime/${n}`).sort(),
    ].sort();
    expect(summary.files.map((f) => f.path)).toEqual(expected);
    expect(summary).toMatchObject({ name: "descent-the-return", title: "Descent: The Return!", zip: "descent-the-return.zip" });

    const folder = join(outDir, "descent-the-return");
    expect(await listFiles(folder)).toEqual(expected);
    const zip = await readFile(join(outDir, summary.zip));
    expect(summary.zipBytes).toBe(zip.length);
    const entries = unzip(zip);
    expect([...entries.keys()]).toEqual(expected);
    for (const path of expected) expect(entries.get(path)).toEqual(await readFile(join(folder, path)));

    // Sizes add up; every path is relative and inside the folder.
    expect(summary.folderBytes).toBe(summary.files.reduce((s, f) => s + f.bytes, 0));
    for (const f of summary.files) {
      expect(f.bytes).toBe((await stat(join(folder, f.path))).size);
      expect(f.path).not.toMatch(/^\/|\.\.|\\/);
    }
    // No secrets, design documents or unused art, by name or content.
    const all = Buffer.concat([...entries.values()]).toString("utf8");
    for (const secret of ["sk-secret", "token-secret", "the-secret-wiki-sentence", ...Object.values(UNUSED_REFS)]) expect(all).not.toContain(secret);
    const data = JSON.parse(entries.get("game.json")!.toString("utf8")) as GameExportData;
    expect(data.images).toEqual(Object.values(USED_REFS).sort());
    expect(entries.get("index.html")!.toString("utf8")).toContain("<title>Descent: The Return!</title>");
    // Not in the export: notes.txt beside the runtime.
    expect(summary.files.some((f) => f.path.includes("notes"))).toBe(false);
  });

  it("gives the same bytes for the same project, and replaces the previous export", async () => {
    const first = await build();
    const zip1 = await readFile(join(outDir, "descent-the-return.zip"));
    await writeFile(join(outDir, "descent-the-return", "stale.txt"), "left over");
    const second = await build();
    const zip2 = await readFile(join(outDir, "descent-the-return.zip"));
    expect(second).toEqual(first);
    expect(zip2.equals(zip1)).toBe(true);
    expect(await listFiles(join(outDir, "descent-the-return"))).not.toContain("stale.txt");
    // No temporary folders left behind.
    expect((await readdir(outDir)).sort()).toEqual(["descent-the-return", "descent-the-return.zip"]);
  });

  it("refuses without a start, a built runtime or a referenced image", async () => {
    const project = artfulGame();
    expect(await build({ ...project, world: { ...project.world, start: null } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    await rm(files.path(USED_REFS.pillar));
    expect(await build()).toMatchObject({ ok: false, error: { code: "not_found", message: expect.stringContaining(USED_REFS.pillar) } });
    await rm(join(runtimeDir, "index.wasm"));
    expect(await build()).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("build:game") } });
  });

  it("zips deterministically, storing what doesn't compress", () => {
    const entries = [
      { path: "b/two.txt", data: Buffer.from("two ".repeat(100)) },
      { path: "a.bin", data: Buffer.from([1, 2, 3]) },
    ];
    const zip = zipFiles(entries);
    expect(zipFiles([...entries].reverse()).equals(zip)).toBe(true);
    expect([...unzip(zip).keys()]).toEqual(["a.bin", "b/two.txt"]);
    expect(() => zipFiles([{ path: "../evil", data: Buffer.alloc(1) }])).toThrow();
  });
});

describe("export HTTP API", () => {
  let server: Server;
  let base: string;
  const TOKEN = "test-token";
  const runner: TurnRunner = async () => {
    throw new Error("no turns in this test");
  };

  beforeEach(async () => {
    // Opens the example game with its art (project.json, written above).
    const created = await createProjectServer(projectDir, { token: TOKEN, runner, runtimeDir });
    server = createServer((req, res) => created.handler(req, res, () => res.end()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("builds on POST /api/export and serves the zip, behind the token", async () => {
    const headers = { "x-studio-token": TOKEN, "content-type": "application/json" };
    expect((await fetch(`${base}/api/export`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/api/export`, { method: "POST", headers, body: '{"x":1}' })).status).toBe(400);
    const res = await fetch(`${base}/api/export`, { method: "POST", headers, body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; export: { zip: string; zipBytes: number } };
    expect(body).toMatchObject({ ok: true, export: { zip: "descent-the-return.zip" } });

    expect((await fetch(`${base}/api/export/${body.export.zip}`)).status).toBe(401);
    const zip = await fetch(`${base}/api/export/${body.export.zip}`, { headers });
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-disposition")).toBe('attachment; filename="descent-the-return.zip"');
    expect(Buffer.from(await zip.arrayBuffer()).length).toBe(body.export.zipBytes);
    expect((await fetch(`${base}/api/export/..%2Fproject.json`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/api/export/nothing.zip`, { headers })).status).toBe(404);
  });
});
