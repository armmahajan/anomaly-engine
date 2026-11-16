import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultProject, type ChangeResult, type ProjectSpec } from "@anomaly/core";
import { ProjectStore } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anomaly-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const open = () => ProjectStore.open(dir, createDefaultProject);

const speedOp = (runSpeed: unknown, baseRevision: number, author: "user" | "ai" = "user") => ({
  name: "updateCharacter",
  input: { characterId: "player", changes: { stats: { runSpeed } } },
  baseRevision,
  author,
});

function speed(project: ProjectSpec): number {
  const c = project.characters.find((c) => c.id === "player");
  if (c?.kind !== "player") throw new Error("no player");
  return c.stats.runSpeed;
}

function expectOk(result: ChangeResult): ProjectSpec {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.project;
}

async function diskProject(): Promise<ProjectSpec> {
  return JSON.parse(await readFile(join(dir, "project.json"), "utf8"));
}

describe("ProjectStore", () => {
  it("creates the default project on first open", async () => {
    const store = await open();
    expect(store.getState()).toEqual({ project: createDefaultProject(), canUndo: false });
    expect(await diskProject()).toEqual(createDefaultProject());
  });

  it("persists operations and history across reopen", async () => {
    const store = await open();
    expect(speed(expectOk(await store.applyOperation(speedOp(150, 0, "ai"))))).toBe(150);
    expect(speed(await diskProject())).toBe(150);

    const reopened = await open();
    expect(reopened.getState().project.revision).toBe(1);
    expect(speed(reopened.getState().project)).toBe(150);
    expect(reopened.getHistory()).toMatchObject([{ revision: 1, author: "ai", summary: "updateCharacter" }]);
    expect(reopened.getState().canUndo).toBe(true);
  });

  it("rejects stale revisions without writing", async () => {
    const store = await open();
    expectOk(await store.applyOperation(speedOp(150, 0)));
    const stale = await store.applyOperation(speedOp(200, 0));
    expect(stale).toMatchObject({ ok: false, error: { code: "stale_revision" } });
    expect(speed(await diskProject())).toBe(150);
    expect(store.getHistory()).toHaveLength(1);
  });

  it("serializes concurrent edits: one wins, the other is stale", async () => {
    const store = await open();
    const results = await Promise.all([store.applyOperation(speedOp(150, 0)), store.applyOperation(speedOp(200, 0))]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(speed(await diskProject())).toBe(150);
  });

  it("rejects invalid operations and malformed requests without writing", async () => {
    const store = await open();
    expect(await store.applyOperation(speedOp(-5, 0))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await store.applyOperation({ name: "deleteEverything", input: {}, baseRevision: 0 })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(await store.applyOperation({ name: "updateCharacter" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(await diskProject()).toEqual(createDefaultProject());
    expect(store.getHistory()).toEqual([]);
  });

  it("undoes linearly, recording each undo as a new revision", async () => {
    const store = await open();
    expectOk(await store.applyOperation(speedOp(150, 0)));
    expectOk(await store.applyOperation(speedOp(200, 1)));

    let project = expectOk(await store.undo({ baseRevision: 2 }));
    expect([speed(project), project.revision]).toEqual([150, 3]);

    // A new edit after an undo, then undo twice: back past the earlier edit.
    expectOk(await store.applyOperation(speedOp(90, 3)));
    project = expectOk(await store.undo({ baseRevision: 4 }));
    expect(speed(project)).toBe(150);
    project = expectOk(await store.undo({ baseRevision: 5 }));
    expect([speed(project), project.revision]).toEqual([320, 6]);

    expect(store.getState().canUndo).toBe(false);
    expect(await store.undo({ baseRevision: 6 })).toMatchObject({ ok: false, error: { code: "nothing_to_undo" } });
    expect(store.getHistory().map((e) => e.summary)).toEqual([
      "updateCharacter",
      "updateCharacter",
      "undo revision 2",
      "updateCharacter",
      "undo revision 4",
      "undo revision 1",
    ]);

    // Undo state survives a restart.
    const reopened = await open();
    expect(speed(reopened.getState().project)).toBe(320);
    expect(reopened.getState().canUndo).toBe(false);
  });

  it("blocks edits and undo during a playtest, only for the lock holder to release", async () => {
    const store = await open();
    expectOk(await store.applyOperation(speedOp(150, 0)));
    expect(await store.setPlaytest({ active: true, clientId: "tab_a" })).toEqual({ ok: true, revision: 1 });

    expect(await store.applyOperation(speedOp(200, 1))).toMatchObject({ ok: false, error: { code: "locked" } });
    expect(await store.undo({ baseRevision: 1 })).toMatchObject({ ok: false, error: { code: "locked" } });
    expect(await store.setPlaytest({ active: true, clientId: "tab_b" })).toMatchObject({ ok: false });

    await store.setPlaytest({ active: false, clientId: "tab_b" }); // not the owner: no effect
    expect(await store.applyOperation(speedOp(200, 1))).toMatchObject({ ok: false, error: { code: "locked" } });

    store.releasePlaytest("tab_a"); // e.g. the tab disconnected
    expectOk(await store.applyOperation(speedOp(200, 1)));
  });

  it("notifies subscribers with the cause of each change", async () => {
    const store = await open();
    const events: unknown[] = [];
    store.subscribe((e) => events.push(e));
    expectOk(await store.applyOperation(speedOp(150, 0, "ai")));
    expect(events).toMatchObject([
      { type: "project", canUndo: true, cause: { revision: 1, author: "ai", summary: "updateCharacter" } },
    ]);
  });

  it("discards history entries that were never committed (crash between writes)", async () => {
    const store = await open();
    expectOk(await store.applyOperation(speedOp(150, 0)));
    // Simulate a crash after appending history but before replacing project.json.
    const orphan = { revision: 2, at: "", author: "user", change: { kind: "operation", name: "x", input: {} }, before: {} };
    await writeFile(join(dir, "history.jsonl"), (await readFile(join(dir, "history.jsonl"), "utf8")) + JSON.stringify(orphan) + "\n");

    const reopened = await open();
    expect(reopened.getHistory().map((e) => e.revision)).toEqual([1]);
    expectOk(await reopened.applyOperation(speedOp(200, 1)));
  });

  it("refuses to open an invalid project file", async () => {
    await writeFile(join(dir, "project.json"), JSON.stringify({ name: "broken" }));
    await expect(open()).rejects.toThrow(/not a valid project/);
  });
});

describe("ProjectStore migrations", () => {
  it("upgrades a v1 project on open and can undo into migrated snapshots", async () => {
    const v1 = {
      ...createDefaultProject(),
      schemaVersion: 1,
      revision: 1,
      characters: [
        createDefaultProject().characters[0],
        { id: "crawler", kind: "enemy", name: "Crawler", color: "#c0504d", size: { width: 40, height: 28 }, stats: { patrolSpeed: 99, patrolDistance: 300 } },
      ],
      sandbox: { ...createDefaultProject().sandbox, spawns: createDefaultProject().sandbox.spawns.slice(0, 2) },
    };
    const v1Before = { ...v1, revision: 0 };
    await writeFile(join(dir, "project.json"), JSON.stringify(v1));
    await writeFile(
      join(dir, "history.jsonl"),
      JSON.stringify({ revision: 1, at: "", author: "user", change: { kind: "operation", name: "updateCharacter", input: {} }, before: v1Before }) + "\n",
    );

    const store = await open();
    const crawler = store.getState().project.characters[1];
    expect(store.getState().project.schemaVersion).toBe(3);
    expect(crawler).toMatchObject({ behavior: { states: { patrol: { action: { speed: 99 } } } } });

    const undone = expectOk(await store.undo({ baseRevision: 1 }));
    expect(undone.schemaVersion).toBe(3);
    expect(undone.revision).toBe(2);
  });
});

describe("ProjectStore batches", () => {
  const batch = (baseRevision: number, x: unknown = 900) => ({
    baseRevision,
    author: "ai",
    operations: [
      { name: "duplicateCharacter", input: { characterId: "charger", newId: "charger_b" } },
      { name: "addSpawn", input: { characterId: "charger_b", x, y: 660 } },
    ],
  });

  it("records a batch as one history entry that undoes in one step", async () => {
    const store = await open();
    const project = expectOk(await store.applyBatch(batch(0)));
    expect(project.revision).toBe(1);
    expect(project.sandbox.spawns.map((s) => s.id)).toContain("charger_b_1");
    expect(store.getHistory()).toMatchObject([{ revision: 1, author: "ai", summary: "batch: duplicateCharacter, addSpawn" }]);

    const undone = expectOk(await store.undo({ baseRevision: 1 }));
    expect(undone.characters.map((c) => c.id)).not.toContain("charger_b");
    expect(undone.sandbox.spawns.map((s) => s.id)).not.toContain("charger_b_1");
  });

  it("writes nothing when any step fails", async () => {
    const store = await open();
    const result = await store.applyBatch(batch(0, "far left"));
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await diskProject()).toEqual(createDefaultProject());
    expect(store.getHistory()).toEqual([]);
  });

  it("applies the same staleness and playtest rules as single operations", async () => {
    const store = await open();
    expect(await store.applyBatch(batch(5))).toMatchObject({ ok: false, error: { code: "stale_revision" } });
    await store.setPlaytest({ active: true, clientId: "tab" });
    expect(await store.applyBatch(batch(0))).toMatchObject({ ok: false, error: { code: "locked" } });
    expect(await store.applyBatch({ operations: [] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });
});

describe("loadOrCreateToken", () => {
  it("creates a private token once and reuses it", async () => {
    const { loadOrCreateToken } = await import("../src/index.ts");
    const { stat } = await import("node:fs/promises");
    const path = join(dir, ".studio-token");
    const first = await loadOrCreateToken(path);
    expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await loadOrCreateToken(path)).toBe(first);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
