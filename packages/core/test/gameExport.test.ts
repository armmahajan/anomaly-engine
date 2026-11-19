import { describe, expect, it } from "vitest";
import { applyOperation, exportFileName, fixtureSliceProject, planGameExport, PROTOCOL_VERSION, runtimeImageRefs, type GameExportData } from "../src/index.ts";
import { artfulGame, SECRET_TEXT, UNUSED_REFS, USED_REFS } from "./fixtures/exportGame.ts";

function plan(project = artfulGame()) {
  const result = planGameExport(project);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("game export plan", () => {
  it("names the export safely from the game's name", () => {
    expect(exportFileName("Descent: The Return!")).toBe("descent-the-return");
    expect(exportFileName("  Été à Paris  ")).toBe("ete-a-paris");
    expect(exportFileName("../../etc/passwd")).toBe("etc-passwd");
    expect(exportFileName("???")).toBe("game");
    const long = exportFileName("a very long name ".repeat(10));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("bundles exactly the images the game draws", () => {
    const { data } = plan();
    expect(data.images).toEqual(Object.values(USED_REFS).sort());
    for (const unused of Object.values(UNUSED_REFS)) expect(JSON.stringify(data)).not.toContain(unused);
    // The same set the studio sends its runtime.
    expect(runtimeImageRefs(data.project)).toEqual(data.images);
  });

  it("leaves the design documents, the plan, unused art and art notes out of the data", () => {
    const { data } = plan();
    const text = JSON.stringify(data);
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain("a brief nobody should ship");
    expect(text).not.toContain("concept prompt");
    expect(data.project.wiki.pages).toEqual([]);
    expect(data.project.progression.regions).toEqual([]);
    expect(data.project.art.assets.map((a) => a.id)).toEqual(["hero_art", "caves"]);
    const caves = data.project.art.assets.find((a) => a.id === "caves");
    expect(caves?.kind === "biome" && caves.rooms.map((r) => r.id)).toEqual(["hall"]);
    // What the runtime plays is still all there.
    const source = artfulGame();
    expect(data.project.world.rooms.map((r) => r.id)).toEqual(source.world.rooms.map((r) => r.id));
    expect(data.project.world.rooms.every((r) => r.solids.length > 0 && r.width > 0)).toBe(true);
    expect(data.project.characters).toEqual(source.characters);
    expect(data.project.world.modals).toEqual(source.world.modals);
  });

  it("starts at the world's start with no abilities, keyed by the game for saves", () => {
    const source = artfulGame();
    const { data } = plan(source);
    expect(data).toMatchObject<Partial<GameExportData>>({
      title: "Descent: The Return!",
      name: "descent-the-return",
      saveKey: "anomaly-save:descent-the-return",
      protocolVersion: PROTOCOL_VERSION,
      start: { ...source.world.start!, abilities: [] },
    });
    expect(data.project.id).toBe("descent-the-return");
  });

  it("lists the keys the game uses", () => {
    const { controls } = plan().data;
    const actions = controls.help.map((c) => c.action);
    // The example grants double jump, has an interact prop and the map.
    expect(actions).toEqual(expect.arrayContaining(["move", "jump", "attack", "jump again", "map", "choose in menus"]));
    expect(actions).not.toContain("dash");
    // With the game's keys, and what the page needs to let players change them.
    expect(controls.help.find((c) => c.action === "move")).toEqual({ action: "move", template: "{move_left} and {move_right}", keys: "A/← and D/→" });
    expect(controls.actions.map((a) => a.id)).toEqual(["move_left", "move_right", "jump", "attack", "aim_up", "aim_down", "interact", "map"]);
    expect(controls.actions.find((a) => a.id === "jump")).toEqual({ id: "jump", label: "Jump", keys: ["Space", "Z"], context: "play", shares: [] });
    expect(controls.storageKey).toBe("anomaly-controls:descent-the-return");
    expect(controls.browserCodes).toMatchObject({ KeyK: "K", Space: "Space", ArrowLeft: "Left", ShiftRight: "Shift" });
    // Mouse buttons: what a click on the page binds, how it is shown, and the attack line's mouse wording.
    expect(controls.browserButtons).toEqual({ 0: "MouseLeft", 1: "MouseMiddle", 2: "MouseRight" });
    expect(controls.keyLabels).toMatchObject({ MouseLeft: "Left click", MouseRight: "Right click", MouseMiddle: "Middle click" });
    expect(controls.help.find((c) => c.action.startsWith("attack"))?.keys).toBe("X/J/Left click, toward the mouse (or hold W/↑ or S/↓ to aim)");
  });

  it("lets players bind mouse buttons, and keeps the browser menu off the game", () => {
    const { page } = plan();
    const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    expect(script).toContain('window.addEventListener("mousedown"');
    expect(script).toContain("keys.browserButtons[String(event.button)]");
    expect(script).toContain('window.addEventListener("contextmenu"');
    expect(script).toContain('frame.contentDocument.addEventListener("contextmenu", noMenu)');
    expect(page).toContain("press a key or click here…");
  });

  it("exports the game's own keys, and the page fills in the player's", () => {
    const source = artfulGame();
    const rebound = applyOperation(source, "setControlKeys", { action: "jump", keys: ["L"] });
    if (!rebound.ok) throw new Error(rebound.error.message);
    const { data, page } = plan(rebound.project);
    expect(data.project.controls.bindings.jump).toEqual(["L"]);
    expect(data.controls.actions.find((a) => a.id === "jump")?.keys).toEqual(["L"]);
    expect(data.controls.help.find((c) => c.action === "jump")?.keys).toBe("L");
    expect(page).toContain("<dt>L</dt><dd>jump</dd>");
    expect(page).toContain("Change keys");
    expect(page).toContain("Reset to the game's defaults");
    // The inline script is valid JavaScript, and sends the player's keys before the game loads.
    const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('h.template.replace(/\\{([a-z_]+)\\}/g');
    expect(script.indexOf('post({ type: "controls"')).toBeGreaterThan(-1);
    expect(script.indexOf("sendControls(); // before the game loads")).toBeLessThan(script.indexOf('post({ type: "load"'));
  });

  it("refuses a game with no start", () => {
    const project = fixtureSliceProject();
    const result = planGameExport({ ...project, world: { ...project.world, start: null } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("no start") });
  });

  it("is deterministic", () => {
    expect(plan()).toEqual(plan());
    expect(JSON.stringify(plan().data)).toBe(JSON.stringify(plan().data));
  });

  it("boot page: the game's title, relative URLs only, nothing from elsewhere", () => {
    const { page } = plan(artfulGame("<Tom & Jerry>"));
    expect(page).toContain("<title>&lt;Tom &amp; Jerry&gt;</title>");
    expect(page).not.toContain("<Tom");
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(/(src|href)="\//);
    expect(page).not.toMatch(/fetch\("\//);
    for (const url of ["runtime/index.html", "game.json", '"files/"']) expect(page).toContain(url);
  });
});
