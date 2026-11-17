import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureReferenceProject, type ProjectSpec } from "@anomaly/core";
import { ArchitectService, defaultStageRunners, ProjectStore, type StageRunners } from "../src/index.ts";

let dir: string;
let store: ProjectStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anomaly-architect-"));
  store = await ProjectStore.open(dir, () => ({ ...fixtureReferenceProject(), architect: { ...fixtureReferenceProject().architect } }));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const project = () => store.getState().project;
const op = (name: string, input: unknown) => store.applyOperation({ name, input, baseRevision: project().revision, author: "user" });

/** Default stages, with verify passing and art skipped (the reference game is hand-built, not from a plan). */
function service(overrides: Partial<StageRunners> = {}) {
  return new ArchitectService(
    store,
    defaultStageRunners({ overrides: { verify: async ({ project }) => ({ project, issues: [], summary: "ok" }), ...overrides } }),
  );
}

describe("the Architect run", () => {
  it("runs every stage in order, one undoable revision each, and records their status", async () => {
    const architect = service();
    const seen: string[] = [];
    architect.subscribe((s) => s.running && !seen.includes(s.running.stage) && seen.push(s.running.stage));
    const start = project().revision;
    expect(await architect.start({})).toEqual({ ok: true });
    await expect(architect.start({}).then((r) => r.ok)).resolves.toBe(false); // one run at a time
    await architect.idle();
    expect(seen).toEqual(["plan", "layout", "geometry", "cast", "population", "screens", "verify", "pacing", "art"]);
    expect(architect.getState().last).toMatchObject({ outcome: "finished", stage: "art" });
    expect(project().revision).toBe(start + 9);
    expect(project().architect.rooms.length).toBeGreaterThan(0);
    expect(Object.values(project().architect.stages).map((s) => s.status)).toEqual(Array(9).fill("done"));
    expect(store.getHistory().at(-1)!.summary).toContain("architect art");
    // The project is unlocked again.
    expect((await op("setArchitectGuidance", { guidance: "later" })).ok).toBe(true);
  });

  it("pauses after the stages the plan says, then resumes from the next one", async () => {
    const architect = service();
    await op("setArchitectPause", { pauseAfter: ["plan"] });
    await architect.start({});
    await architect.idle();
    expect(architect.getState().last).toMatchObject({ outcome: "paused", stage: "plan" });
    expect(project().architect.stages.layout).toBeUndefined();
    // The creator edits the plan in between.
    const room = project().architect.rooms[0]!;
    expect((await op("updateRoomPlan", { roomId: room.id, changes: { notes: "wide and calm" } })).ok).toBe(true);
    await architect.start({}); // resumes at the first stage that isn't done
    await architect.idle();
    expect(architect.getState().last).toMatchObject({ outcome: "finished" });
    expect(project().architect.rooms[0]!.notes).toBe("wide and calm");
  });

  it("rerunning a stage marks the later ones stale; runs can cover a range and a subset of rooms", async () => {
    const architect = service();
    await architect.start({});
    await architect.idle();
    const rooms: (string[] | undefined)[] = [];
    const watching = service({ geometry: async ({ project, rooms: only }) => (rooms.push(only), { project, issues: [], summary: "rebuilt" }) });
    const id = project().architect.rooms[2]!.id;
    expect(await watching.start({ from: "geometry", to: "geometry", rooms: [id] })).toEqual({ ok: true });
    await watching.idle();
    expect(rooms).toEqual([[id]]);
    expect(project().architect.stages.geometry!.status).toBe("done");
    expect(project().architect.stages.population!.status).toBe("stale");
    expect(project().architect.stages.plan!.status).toBe("done");
    expect((await watching.start({ rooms: ["nowhere"] })).ok).toBe(false);
  });

  it("stops at a failed verify (no art for a broken game) and at a crashing stage, and undo restores the project", async () => {
    let drawn = false;
    const failing = service({
      verify: async ({ project }) => ({ project, issues: [{ stage: "geometry", code: "gate-bypassed", message: "the gate leaks" }], summary: "1 issue" }),
      art: async ({ project }) => ((drawn = true), { project, issues: [], summary: "drawn" }),
    });
    await failing.start({});
    await failing.idle();
    expect(failing.getState().last).toMatchObject({ outcome: "failed", stage: "verify", issues: [{ code: "gate-bypassed" }] });
    expect(project().architect.stages.verify!.status).toBe("failed");
    expect(drawn).toBe(false);

    const before: ProjectSpec = project();
    const crashing = service({ layout: async () => Promise.reject(new Error("boom")) });
    await crashing.start({ from: "plan", to: "geometry" });
    await crashing.idle();
    expect(crashing.getState().last).toMatchObject({ outcome: "failed", stage: "layout", error: "boom" });
    expect(project().architect.stages.layout).toMatchObject({ status: "failed", summary: "boom" });
    // Undo twice: the failed status, then the plan stage.
    for (let i = 0; i < 2; i++) expect((await store.undo({ baseRevision: project().revision, author: "user" })).ok).toBe(true);
    expect(project().architect).toEqual(before.architect);
  });

  it("cancel stops after the current stage", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const architect = service({ layout: async ({ project }) => (await gate, { project, issues: [], summary: "slow" }) });
    await architect.start({});
    while (architect.getState().running?.stage !== "layout") await new Promise((r) => setTimeout(r, 5));
    architect.cancel();
    release();
    await architect.idle();
    expect(architect.getState().last).toMatchObject({ outcome: "cancelled", stage: "layout" });
    expect(project().architect.stages.layout!.status).toBe("done");
    expect(project().architect.stages.geometry).toBeUndefined();
  });
});

describe("repairs and the model stages", () => {
  it("routes verify failures to the stage that fixes them, with new seeds for rebuilt rooms", async () => {
    const { repairFor, reseed } = await import("../src/index.ts");
    await op("seedArchitectPlan", {});
    const p = project();
    const [a, b] = p.architect.rooms;
    const link = p.architect.links[0]!;
    expect(repairFor(p, [{ stage: "geometry", code: "gate-bypassed", message: "", linkId: link.id }])).toEqual({ from: "geometry", rooms: [link.a.room], reseed: [link.a.room] });
    expect(repairFor(p, [{ stage: "population", code: "dead-state", message: "", roomId: b!.id }, { stage: "geometry", code: "lint:unstandable_platform", message: "", roomId: a!.id }])).toEqual({ from: "geometry", rooms: [a!.id], reseed: [a!.id] });
    expect(repairFor(p, [{ stage: "population", code: "no-ending", message: "" }])).toEqual({ from: "population", rooms: undefined, reseed: [] });
    expect(repairFor(p, [{ stage: "verify", code: "check-crashed", message: "" }])).toBeNull();
    expect(reseed(p, [a!.id]).architect.rooms[0]!.seed).not.toBe(a!.seed);
  });

  it("a failed verify sends the run back, then succeeds", async () => {
    let verifies = 0;
    const geometry: (string[] | undefined)[] = [];
    await op("seedArchitectPlan", {});
    const target = project().architect.rooms[1]!;
    const architect = service({
      geometry: async ({ project, rooms }) => (geometry.push(rooms), { project, issues: [], summary: "built" }),
      verify: async ({ project }) =>
        ++verifies === 1
          ? { project, issues: [{ stage: "geometry", code: "lint:unstandable_platform", message: "a ledge under the ceiling", roomId: target.id }], summary: "1 issue" }
          : { project, issues: [], summary: "ok" },
    });
    await architect.start({});
    await architect.idle();
    expect(architect.getState().last).toMatchObject({ outcome: "finished" });
    expect(geometry).toEqual([undefined, [target.id]]);
    expect(project().architect.rooms[1]!.seed).not.toBe(target.seed);
    expect(architect.getState().log.map((l) => l.text)).toContain(`repair 1/3: back to geometry for ${target.id} (new seeds for 1 room(s))`);
  });

  it("the plan stage is an Architect turn on a private copy; the cast stage asks the build assistant for missing enemies", async () => {
    const { callTools, FakeModel, runAgentTurn, say, toolCall } = await import("@anomaly/agent");
    const { modelStageRunners } = await import("../src/index.ts");
    const messages: string[] = [];
    const runners = modelStageRunners((request) => {
      messages.push(`${request.agent!.id}: ${request.userMessage.slice(0, 40)}`);
      const script =
        request.agent!.id === "architect"
          ? [callTools(toolCall("updateRoomPlan", { roomId: request.project.architect.rooms[0]!.id, changes: { notes: "the first room", contents: [{ kind: "start" }, { kind: "enemy", characterId: "moth" }] } })), say("Shaped the plan.")]
          : [callTools(toolCall("createCharacter", { character: { ...request.project.characters.find((c) => c.kind === "enemy")!, id: "moth", name: "Moth" } })), say("Made the moth.")];
      return runAgentTurn({ ...request, model: new FakeModel(script) });
    });
    const ctx = { signal: new AbortController().signal, log: () => {} };
    const planned = await runners.plan({ ...ctx, project: project() });
    expect(planned.project.architect.rooms[0]!.notes).toBe("the first room");
    expect(planned.blocking).toBe(false);
    expect(project().architect.rooms).toEqual([]); // the store is untouched: the run commits the result
    const cast = await runners.cast({ ...ctx, project: planned.project });
    expect(cast.project.characters.some((c) => c.id === "moth")).toBe(true);
    expect(cast.blocking).toBe(false);
    expect(messages).toEqual(["architect: Plan the game world now. The plan has be", "build: Create these enemy characters for the wo"]);
  });
});
