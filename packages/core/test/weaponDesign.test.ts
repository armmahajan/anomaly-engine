import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createDefaultProject,
  difficultyStage,
  fixtureReferenceProject,
  gameCharacterPages,
  gameControlHelp,
  gamePages,
  geometryStage,
  layoutStage,
  pageGameKind,
  planIssues,
  populationStage,
  ProjectSpec,
  screensStage,
  seedPlan,
  verifyStage,
  weaponsFromPages,
  weaponUse,
  wikiGaps,
  type ArchitectPlan,
  type RoomContent,
  type Effect,
  type StageOutcome,
  type WikiPage,
} from "../src/index.ts";

// Weapons in the design: wiki weapon pages, the Architect's weapon grants and gates, and the keys a game shows.

const op = (project: ProjectSpec, name: string, input: unknown) => {
  const result = applyOperation(project, name, input);
  if (!result.ok) throw new Error(`${name}: ${result.error.message} ${JSON.stringify(result.error.issues)}`);
  return result.project;
};

const page = (id: string, fields: Record<string, string>, extra: Partial<WikiPage> = {}): WikiPage => ({ id, kind: "character", title: id, summary: "", body: "", fields, status: "draft", ...extra });

const weapon = (id: string, name: string) => ({ id, name, description: `${name}.`, attacks: [{ id: "swing", name: "Swing", shape: { type: "arc", radius: 60 } }] });

describe("wiki weapon pages", () => {
  const project = createDefaultProject();

  it("a page is a weapon by its in_game field, its weapon link or its kind; weapons aren't characters", () => {
    expect(pageGameKind(project, page("blade", { in_game: "weapon" }))).toBe("weapon");
    expect(pageGameKind(project, page("blade", {}, { kind: "weapon" }))).toBe("weapon");
    expect(pageGameKind(project, page("blade", { in_game: "none" }, { kind: "weapon" }))).toBeNull();
    const armed = ProjectSpec.parse({ ...project, weapons: { list: [weapon("blade", "Blade")] } });
    expect(pageGameKind(armed, page("x", {}, { weaponId: "blade" }))).toBe("weapon");
    const wiki = { pages: [page("blade", { in_game: "Weapon (the hero's)" }), page("grub", { in_game: "enemy" })] };
    const both = { ...project, wiki };
    expect(gamePages(both).map((p) => [p.page.id, p.kind])).toEqual([
      ["blade", "weapon"],
      ["grub", "enemy"],
    ]);
    expect(gameCharacterPages(both).map((p) => p.page.id)).toEqual(["grub"]);
  });

  it("weaponsFromPages makes a weapon per new page (name, description, look from the page) and links it; an unlinked weapon with the page's id is linked instead", () => {
    const pages = [
      page("ember_blade", { in_game: "weapon", appearance: "a red-hot sickle" }, { title: "Ember Blade", summary: "A blade that never cools." }),
      page("old_bow", { in_game: "weapon" }, { title: "Old Bow" }),
      page("grub", { in_game: "enemy" }),
    ];
    const start = ProjectSpec.parse({ ...project, wiki: { pages }, weapons: { list: [weapon("old_bow", "Bow")] } });
    const { operations, created } = weaponsFromPages(start, ["ember_blade", "old_bow", "grub"]);
    expect(created).toEqual(["ember_blade"]);
    const next = operations.reduce((p, o) => op(p, o.name, o.input), start);
    expect(next.weapons.list.find((w) => w.id === "ember_blade")).toMatchObject({ name: "Ember Blade", description: "A blade that never cools.", attacks: [], art: { brief: "a red-hot sickle" } });
    expect(Object.fromEntries(next.wiki.pages.map((p) => [p.id, p.weaponId]))).toEqual({ ember_blade: "ember_blade", old_bow: "old_bow", grub: undefined });
    // Linked pages keep their weapon: nothing more to do.
    expect(weaponsFromPages(next, ["ember_blade", "old_bow"]).operations).toEqual([]);
    // Deleting the weapon leaves a gap on its page; unlinking clears it.
    const gone = op(next, "deleteWeapon", { weaponId: "ember_blade" });
    expect(wikiGaps(gone).filter((g) => g.code === "missing_weapon").map((g) => g.pageId)).toEqual(["ember_blade"]);
    const unlinked = op(gone, "updateWikiPage", { pageId: "ember_blade", changes: { weaponId: null } });
    expect(unlinked.wiki.pages.find((p) => p.id === "ember_blade")!.weaponId).toBeUndefined();
  });
});

// --- the Architect -------------------------------------------------------------------------

/** The reference game's design (progression undercroft -(hatch_key)-> spire <-(double_jump)-> summit) with two weapons and no world. */
function design(): ProjectSpec {
  const reference = fixtureReferenceProject();
  return ProjectSpec.parse({
    ...reference,
    world: { ...reference.world, rooms: [], start: null, playtest: null, handlers: [], modals: [], items: [] },
    weapons: { ...reference.weapons, list: [weapon("thorn_whip", "Thorn Whip"), weapon("ember_blade", "Ember Blade")] },
  });
}

const room = (plan: ArchitectPlan, id: string) => plan.rooms.find((r) => r.id === id)!;

/**
 * The seeded plan plus weapons: the Thorn Whip lies in the start room and opens the way on in the
 * undercroft; the spire's first enemy drops the Ember Blade, which opens the way deeper into the spire.
 */
function armedPlan(base: ProjectSpec, edit: (plan: ArchitectPlan) => ArchitectPlan = (p) => p): ProjectSpec {
  const plan = seedPlan(base);
  const rooms = plan.rooms.map((r) => {
    if (r.id === "undercroft_1") return { ...r, contents: [...r.contents, { kind: "pickup" as const, grants: "thorn_whip" }] };
    if (r.id === "spire_1") return { ...r, contents: r.contents.map((c) => (c.kind === "enemy" ? { ...c, count: 1, grants: [...c.grants, "ember_blade"] } : c)) };
    return r;
  });
  const links = plan.links.map((l) => (l.id === "undercroft_1_to_undercroft_2" ? { ...l, requires: ["thorn_whip"] } : l.id === "spire_2_to_spire_3" ? { ...l, requires: ["ember_blade"] } : l));
  return ProjectSpec.parse({ ...base, architect: edit({ ...plan, rooms, links }) });
}

const codes = (project: ProjectSpec) => planIssues(project).issues.map((i) => i.code);

function build(project: ProjectSpec): ProjectSpec {
  const steps: ((p: ProjectSpec) => StageOutcome)[] = [layoutStage, geometryStage, populationStage, difficultyStage, screensStage];
  return steps.reduce((current, run) => ProjectSpec.parse(run(current).project), project);
}

const effectsIn = (project: ProjectSpec): Effect[] =>
  project.world.rooms.flatMap((r) => [...r.handlers, ...r.props.flatMap((p) => p.handlers), ...r.spawns.flatMap((s) => s.handlers)]).flatMap((h) => h.do);

describe("the Architect's weapon grants", () => {
  it("a plan may give weapons (a pickup, a guardian's drop) and gate links with them; it must name weapons that exist", () => {
    const armed = armedPlan(design());
    expect(codes(armed)).toEqual([]);
    const unknown = ProjectSpec.safeParse({ ...armed, architect: { ...armed.architect, links: armed.architect.links.map((l, i) => (i === 0 ? { ...l, requires: ["no_such_weapon"] } : l)) } });
    expect(unknown.success).toBe(false);
    expect(JSON.stringify(unknown.error?.issues)).toContain('unknown progression ability, key or weapon \\"no_such_weapon\\"');
  });

  it("plan checks catch a weapon nothing gives, one given only past the gate that needs it, one given out of reach, a gate it doesn't hold and a weapon given twice", () => {
    const base = design();
    const without = (id: string) => (plan: ArchitectPlan): ArchitectPlan => ({
      ...plan,
      rooms: plan.rooms.map((r) => ({ ...r, contents: r.contents.flatMap((c): RoomContent[] => (c.kind === "pickup" && c.grants === id ? [] : c.kind === "enemy" ? [{ ...c, grants: c.grants.filter((g) => g !== id) }] : [c])) })),
    });
    expect(codes(armedPlan(base, without("thorn_whip")))).toContain("weapon-ungranted");
    // The whip lies past the link that needs it.
    const behind = armedPlan(base, (plan) => {
      const p = without("thorn_whip")(plan);
      return { ...p, rooms: p.rooms.map((r) => (r.id === "undercroft_2" ? { ...r, contents: [...r.contents, { kind: "pickup", grants: "thorn_whip" }] } : r)) };
    });
    expect(planIssues(behind).issues).toContainEqual(expect.objectContaining({ code: "weapon-behind-gate", roomId: "undercroft_2" }));
    // A vault only left by a drop: never entered.
    const vault = armedPlan(base, (plan) => ({
      ...plan,
      rooms: [...plan.rooms, { ...room(plan, "undercroft_2"), id: "vault", contents: [{ kind: "pickup", grants: "ember_blade" }] }],
      links: [...plan.links, { id: "vault_drop", a: { room: "vault" }, b: { room: "undercroft_1" }, requires: [], oneWay: true }],
    }));
    expect(planIssues(vault).issues).toContainEqual(expect.objectContaining({ code: "weapon-unreachable", roomId: "vault" }));
    expect(codes(vault)).toContain("granted-twice");
    // A second, open way past the whip's gate.
    const around = armedPlan(base, (plan) => ({ ...plan, links: [...plan.links, { id: "side_way", a: { room: "undercroft_1" }, b: { room: "undercroft_2" }, requires: [], oneWay: false }] }));
    expect(planIssues(around).issues).toContainEqual(expect.objectContaining({ code: "weapon-gate-bypass", roomId: "undercroft_1" }));
    // A weapon the loadout starts with needs no grant.
    const starting = ProjectSpec.parse({ ...base, weapons: { ...base.weapons, loadout: { slots: [{ id: "main", label: "Main", action: "attack", start: "thorn_whip" }], cycle: false } } });
    expect(codes(armedPlan(starting, without("thorn_whip")))).toEqual([]);
    // Verify sends weapon problems back to the plan.
    expect(verifyStage(armedPlan(base, without("thorn_whip"))).issues).toContainEqual(expect.objectContaining({ stage: "plan", code: "weapon-ungranted" }));
  });

  it("a weapon nothing gives, the loadout doesn't start with and no enemy wields is flagged (the player would never get it)", () => {
    const base = design();
    const plain = (plan: ArchitectPlan): ArchitectPlan => ({
      ...plan,
      rooms: plan.rooms.map((r) => ({ ...r, contents: r.contents.flatMap((c): RoomContent[] => (c.kind === "pickup" && c.grants === "ember_blade" ? [] : c.kind === "enemy" ? [{ ...c, grants: c.grants.filter((g) => g !== "ember_blade") }] : [c])) })),
      links: plan.links.map((l) => ({ ...l, requires: l.requires.filter((r) => r !== "ember_blade") })),
    });
    const ungiven = armedPlan(base, plain);
    expect(planIssues(ungiven).issues).toContainEqual(expect.objectContaining({ code: "unused-weapon", message: expect.stringContaining('"ember_blade"') }));
    // Not an issue the run blocks or verify sends back: the creator may keep a weapon for later.
    expect(verifyStage(ungiven).issues.map((i) => i.code)).not.toContain("unused-weapon");
    // An enemy wielding it, or the loadout starting with it, uses it.
    const enemy = ungiven.characters.find((c) => c.kind === "enemy")!;
    if (enemy.kind !== "enemy") throw new Error("the reference project has an enemy");
    const wielded = ProjectSpec.parse({
      ...ungiven,
      characters: ungiven.characters.map((c) => (c.id === enemy.id && c.kind === "enemy" ? { ...c, behavior: { ...c.behavior, states: { ...c.behavior.states, [c.behavior.initial]: { ...c.behavior.states[c.behavior.initial]!, action: { type: "useWeapon", weapon: "ember_blade" } } } } } : c)),
    });
    expect(codes(wielded)).not.toContain("unused-weapon");
    const starting = ProjectSpec.parse({ ...ungiven, weapons: { ...ungiven.weapons, loadout: { slots: [{ id: "main", label: "Main", action: "attack", start: "ember_blade" }], cycle: false } } });
    expect(codes(starting)).not.toContain("unused-weapon");
    expect(codes(armedPlan(base))).not.toContain("unused-weapon");
  });

  it("population gives weapons with giveWeapon and a message, and bars a weapon gate's door until the player has it", () => {
    const built = build(armedPlan(design()));
    const start = built.world.rooms.find((r) => r.id === "undercroft_1")!;
    const pickup = start.props.find((p) => p.handlers.some((h) => h.do.some((e) => e.type === "giveWeapon")))!;
    expect(pickup).toMatchObject({ name: "Thorn Whip", handlers: [{ on: { type: "touch" }, do: expect.arrayContaining([{ type: "giveWeapon", weapon: "thorn_whip", slot: null }, { type: "showModal", modal: "got_thorn_whip" }]) }] });
    const gate = start.props.find((p) => p.id.startsWith("gate_"))!;
    expect(gate.solid).toEqual({ type: "not", of: { type: "weapon", weapon: "thorn_whip" } });
    expect(effectsIn(built)).toContainEqual({ type: "giveWeapon", weapon: "ember_blade", slot: null });
    // It says how to use it: the control of the loadout slot it lands in (the first empty one).
    expect(built.world.modals.find((m) => m.id === "got_ember_blade")).toMatchObject({ title: "You got Ember Blade", body: "Ember Blade.\n\nUse it with Attack (X/J/Left click), toward where you aim." });
    const sidearm = ProjectSpec.parse({
      ...built,
      weapons: { ...built.weapons, loadout: { slots: [{ id: "main", label: "Main", action: "attack", start: "thorn_whip" }, { id: "alt", label: "Alt", action: "alt_attack", start: null }], cycle: false } },
    });
    expect(weaponUse(sidearm, "ember_blade")).toBe("Use it with Alt attack (V/N/Right click), toward where you aim.");
    const full = ProjectSpec.parse({ ...sidearm, weapons: { ...sidearm.weapons, loadout: { slots: [sidearm.weapons.loadout.slots[0]!], cycle: true } } });
    expect(weaponUse(full, "ember_blade")).toBe("Switch to it with Switch weapon (Q/I).");
    expect(weaponUse({ ...full, weapons: { ...full.weapons, loadout: { ...full.weapons.loadout, cycle: false } } }, "ember_blade")).toBeNull();
    // Weapons are not items.
    expect(built.world.items.map((i) => i.id)).not.toContain("thorn_whip");
  });

  it("end to end: a route gated by two weapons (a pickup and a guardian's drop) is proven beatable, with no dead states", () => {
    const built = build(armedPlan(design()));
    const verdict = verifyStage(built);
    expect(verdict.issues).toEqual([]);
    expect(verdict.verdict).toMatchObject({ beatable: true, deadStates: 0, gatesHold: true });
  }, 120_000);
});

// --- controls ------------------------------------------------------------------------------

describe("the keys a game with weapons shows", () => {
  const bindings = createDefaultProject().controls.bindings;
  const armed = (loadout: object, extra: object = {}) =>
    ProjectSpec.parse({ ...createDefaultProject(), ...extra, weapons: { list: [weapon("blade", "Blade"), weapon("bow", "Long Bow"), weapon("bomb", "Bomb")], loadout } });

  it("weapon actions show only when the loadout uses them, each saying what it does here", () => {
    const loadout = {
      slots: [
        { id: "main", label: "Main", action: "attack", start: "blade" },
        { id: "ranged", label: "Ranged", action: "alt_attack", start: "bow" },
        { id: "spare", label: "Spare", action: "special_attack", start: null },
      ],
      cycle: true,
    };
    const { help, actions } = gameControlHelp(armed(loadout));
    expect(help.map((h) => [h.action, h.template])).toEqual(
      expect.arrayContaining([
        ["attack (Blade)", "{attack}, toward the mouse (or hold {aim_up} or {aim_down} to aim)"],
        ["ranged: Long Bow", "{alt_attack}"],
        ["switch weapon", "{weapon_cycle}"],
      ]),
    );
    expect(actions).toEqual(expect.arrayContaining(["alt_attack", "weapon_cycle"]));
    // The empty special slot gets nothing until the game gives a weapon into it.
    expect(actions).not.toContain("special_attack");
    const given = armed(loadout, {});
    const world = { ...given.world, handlers: [...given.world.handlers, { on: { type: "gameStarted" }, when: [], do: [{ type: "giveWeapon", weapon: "bomb", slot: "spare" }] }] };
    const withBomb = gameControlHelp(ProjectSpec.parse({ ...given, world }));
    expect(withBomb.help).toContainEqual({ action: "spare", template: "{special_attack}" });
    expect(withBomb.actions).toContain("special_attack");
    expect(bindings.special_attack.length).toBeGreaterThan(0);
  });

  it("without weapons, or cycling with one weapon, nothing extra shows", () => {
    expect(gameControlHelp(createDefaultProject()).actions).not.toEqual(expect.arrayContaining(["alt_attack"]));
    const one = gameControlHelp(armed({ slots: [{ id: "main", label: "Main", action: "attack", start: "blade" }], cycle: true }));
    expect(one.actions.filter((a) => ["alt_attack", "special_attack", "weapon_cycle"].includes(a))).toEqual([]);
  });
});
