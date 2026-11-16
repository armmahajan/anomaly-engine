import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeImageModel, FakeRenderer, FakeVisionModel } from "@anomaly/art";
import type { ArtState, ChangeResult, ProjectState } from "@anomaly/core";
import type { TurnRunner } from "@anomaly/agent";
import { createProjectServer, type ArtService } from "../src/index.ts";

const TOKEN = "test-token";
const headers = { "x-studio-token": TOKEN, "content-type": "application/json" };
const noChat: TurnRunner = async () => {
  throw new Error("chat is not used here");
};

let dir: string;
let server: Server;
let base: string;
let art: ArtService;
let vision: FakeVisionModel;

async function start(options: { budget?: number; models?: boolean } = {}) {
  dir = await mkdtemp(join(tmpdir(), "anomaly-art-"));
  vision = new FakeVisionModel();
  const created = await createProjectServer(dir, {
    token: TOKEN,
    runner: noChat,
    art: {
      models: options.models === false ? null : { image: new FakeImageModel(), vision },
      renderer: new FakeRenderer(),
      budget: options.budget ?? 0.25,
      unavailableReason: "needs a key",
    },
  });
  art = created.art!;
  server = createServer((req, res) => created.handler(req, res, () => res.end()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => start());
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const post = async (path: string, body: unknown) =>
  (await (await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })).json()) as { ok: boolean; error?: { code: string; message: string } };
const get = async <T>(path: string) => (await (await fetch(base + path, { headers })).json()) as T;

describe("art jobs over HTTP", () => {
  it("runs an auto job: one saved AI change per stage, files stored and served, costs logged", async () => {
    expect(await post("/api/art/jobs", { stage: "auto", characterId: "charger", brief: "a horned beetle" })).toMatchObject({ ok: true });
    await art.idle();

    const state = await get<ArtState>("/api/art");
    const job = state.jobs.at(-1)!;
    expect(job).toMatchObject({ outcome: "committed", stage: "auto", characterId: "charger" });
    expect(job.revisions).toHaveLength(4);
    expect(job.cost).toBeGreaterThan(0);
    expect(state.totalCost).toBeCloseTo(job.cost);
    expect(state.running).toBeNull();

    const { project } = await get<ProjectState>("/api/project");
    const asset = project.art.assets[0]!;
    expect(project.characters.find((c) => c.id === "charger")?.appearance).toBe(asset.id);
    expect(asset.kind === "character" && asset.rig?.parts.length).toBeGreaterThan(0);
    expect(asset.kind === "character" && Object.keys(asset.clips).sort()).toEqual(["attack", "idle", "walk", "windup"]);

    const stored = await readdir(join(dir, "files"));
    expect(stored.length).toBeGreaterThan(3);
    const res = await fetch(`${base}/api/files/${asset.concepts[0]!.file}`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${base}/api/files/..%2Fproject.json`, { headers })).status).toBe(404);

    // The job log survives a restart.
    expect((await readFile(join(dir, "art-jobs.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);

    // Each stage is its own undo step: undo removes the animations only.
    const undone = (await post("/api/undo", { baseRevision: project.revision })) as unknown as ChangeResult;
    expect(undone.ok && undone.project.art.assets[0]).toMatchObject({ clips: {} });
  });

  it("locks edits while a job runs, and cancel saves nothing more", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = vision.complete.bind(vision);
    vision.complete = async (request) => {
      await gate;
      return original(request);
    };
    expect(await post("/api/art/jobs", { stage: "concepts", characterId: "charger" })).toMatchObject({ ok: true });
    const { project } = await get<ProjectState>("/api/project");
    const blocked = await post("/api/ops", {
      name: "moveSpawn",
      input: { spawnId: "crawler_1", x: 10 },
      baseRevision: project.revision,
    });
    expect(blocked.error?.code).toBe("locked");
    expect((await post("/api/art/jobs", { stage: "concepts", characterId: "charger" })).error?.code).toBe("locked");

    await post("/api/art/cancel", {});
    release();
    await art.idle();
    expect((await get<ArtState>("/api/art")).jobs.at(-1)?.outcome).toBe("cancelled");
    expect((await get<ProjectState>("/api/project")).project.art.assets).toEqual([]);
  });

  it("reports stage order problems and unknown characters clearly", async () => {
    expect(await post("/api/art/jobs", { stage: "rig", characterId: "charger" })).toMatchObject({ ok: true });
    await art.idle();
    const job = (await get<ArtState>("/api/art")).jobs.at(-1)!;
    expect(job.outcome).toBe("failed");
    expect(job.error).toMatch(/no art yet/);
    expect((await post("/api/art/jobs", { stage: "rig", characterId: "ghost" })).error?.code).toBe("not_found");
  });

  it("stops a job that goes over budget", async () => {
    await rm(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await start({ budget: 0.0025 });
    await post("/api/art/jobs", { stage: "auto", characterId: "charger" });
    await art.idle();
    const job = (await get<ArtState>("/api/art")).jobs.at(-1)!;
    expect(job.outcome).toBe("over_budget");
  });

  it("refuses jobs without models, with the reason", async () => {
    await rm(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await start({ models: false });
    expect((await get<ArtState>("/api/art")).available).toBe(false);
    expect(await post("/api/art/jobs", { stage: "concepts", characterId: "charger" })).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: "needs a key" },
    });
  });
});
