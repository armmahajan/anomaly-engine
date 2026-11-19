import type { Character, EnemyCharacter, ProjectSpec } from "../../schema.ts";
import { newEnemyCharacter } from "../../defaultProject.ts";
import type { Effect, GameCondition, Handler } from "../../events/events.ts";
import { movementParams, type MovementAbility, type MovementParams } from "../../movement/params.ts";
import { progressionReport } from "../../progression/report.ts";
import { gridCols, gridRows, TILE } from "../../world/tiles.ts";
import { Prop, type Door, type Item, type Modal, type RoomSpawn, type World, type WorldRoom } from "../../world/world.ts";
import { linkDoorId, roomLinks, type RoomContent, type RoomPlan } from "../plan.ts";
import { roomBuildStamp } from "../fingerprint.ts";
import { stageRooms, type StageIssue, type StageOptions, type StageOutcome } from "../stages.ts";
import { abilityName, ENDING_MODAL, endingModal, grantEffect, grantItem, grantScreens, hasCondition, isHeldGrant, isItemGrant, isMovement, messageModalId, safeId, withMissing } from "./grants.ts";
import { roomSpots, type RoomSpots } from "./spots.ts";

/**
 * The population stage: each unpinned plan room's `contents` become the built
 * world room's spawns, props and handlers (replacing them: geometry clears a
 * room it rebuilds, and population puts its contents back). Only generic
 * primitives; what a piece is for lives in its conditions and handlers:
 *
 * - enemy: spawns spread over reachable surfaces, away from the doors (spots.ts).
 *   With `grants` or `lockRoom` the entry is tracked by a flag `<room>_<enemy>_beaten`:
 *   its spawns appear while it is unset; when the last of them falls (each spawn's
 *   enemyKilled; with several, per-visit `_down` flags say which already fell, reset
 *   on roomEntered) the flag is set, the grants are given, each with its message
 *   modal, and the run is saved. `lockRoom`: on roomEntered, while any locking entry
 *   is unbeaten, the flag `<room>_sealed` is set, and a seal prop over every door is
 *   solid and visible while sealed and unbeaten. Dying, leaving by respawn, saving
 *   and continuing all come back through roomEntered with the spawns rebuilt, so
 *   the fight is always there to win and winning always opens the doors.
 * - pickup: a small prop, visible until taken (`got_<id>` flag); touching it gives
 *   the ability, key or weapon (giveWeapon) with its message.
 * - save: a prop whose interact sets the checkpoint, heals and saves the run.
 * - start: the world start and the playtest spot.
 * - ending: a prop whose touch runs endGame with the ending modal.
 * - links needing keys or weapons (not movement abilities): a barrier prop over the link's
 *   door in its `a` room, solid and visible while the player lacks any of them.
 *   (Movement gates are geometry's.)
 *
 * The modals and items its handlers use are created here when missing (grants.ts),
 * so the result is valid on its own; the screens stage adds the title, the map and
 * messages for anything else the player can get. Characters the plan names that
 * don't exist yet get a placeholder enemy for the cast stage to replace.
 */

const SEAL_COLOR = "#6a4a8c";
const GATE_COLOR = "#8a6a3a";
const PICKUP = { width: 24, height: 24, lift: 4 };
const SAVE = { width: TILE, height: 2 * TILE };
const ENDING = { width: 2 * TILE, height: 2 * TILE };
/** Enemies keep at least this far from where the player enters (px), when the room allows. */
const ENEMY_DOOR_DISTANCE = 5 * TILE;
const MAX_LIST = 10;

const flag = (name: string, is = true): GameCondition => ({ type: "flag", flag: name, is });

/** All of them, nested so no list passes the schema's 10. */
export function allOf(list: GameCondition[]): GameCondition {
  if (list.length === 1) return list[0]!;
  if (list.length <= MAX_LIST) return { type: "all", of: list };
  return allOf(chunk(list, MAX_LIST).map(allOf));
}

export function anyOf(list: GameCondition[]): GameCondition {
  if (list.length === 1) return list[0]!;
  if (list.length <= MAX_LIST) return { type: "any", of: list };
  return anyOf(chunk(list, MAX_LIST).map(anyOf));
}

const chunk = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** A rectangle over a door's opening, one tile deep inside the room. */
export function doorRect(door: Door, room: WorldRoom): { x: number; y: number; width: number; height: number } {
  const cols = gridCols(room.grid);
  const rows = gridRows(room.grid);
  switch (door.side) {
    case "left":
      return { x: 0, y: door.offset * TILE, width: TILE, height: door.size * TILE };
    case "right":
      return { x: (cols - 1) * TILE, y: door.offset * TILE, width: TILE, height: door.size * TILE };
    case "top":
      return { x: door.offset * TILE, y: 0, width: door.size * TILE, height: TILE };
    case "bottom":
      return { x: door.offset * TILE, y: (rows - 1) * TILE, width: door.size * TILE, height: TILE };
  }
}

interface Context {
  project: ProjectSpec;
  params: MovementParams;
  enemies: Map<string, EnemyCharacter>;
  /** Movement abilities the player surely has on arriving in each region (earlier spheres). */
  arrival: (regionId: string) => MovementAbility[];
  saves: boolean;
  issues: StageIssue[];
  /** Grants given here (they need message modals, and items for keys). */
  grants: Set<string>;
  /** Keys conditions read (they need items). */
  keys: Set<string>;
}

interface Built {
  room: WorldRoom;
  start: { room: string; x: number; y: number } | null;
  ending: boolean;
  counts: { enemies: number; pickups: number; saves: number; locks: number; gates: number };
}

export function populationStage(project: ProjectSpec, options: StageOptions = {}): StageOutcome {
  const ids = stageRooms(project, options);
  if (!ids.length) return { project, issues: [], summary: "population: no unpinned plan rooms to fill" };
  const player = project.characters.find((c) => c.kind === "player");
  if (!player || player.kind !== "player") {
    return { project, issues: [{ stage: "population", code: "no-player", message: "the project has no player character" }], summary: "population: no player character" };
  }
  const issues: StageIssue[] = [];
  const plans = new Map(project.architect.rooms.map((r) => [r.id, r]));

  // Enemies the plan names that don't exist yet: placeholders, for the cast stage.
  const characters: Character[] = [...project.characters];
  for (const id of ids) {
    for (const c of plans.get(id)!.contents) {
      if (c.kind !== "enemy" || characters.some((ch) => ch.id === c.characterId)) continue;
      const page = project.wiki.pages.find((p) => p.characterId === c.characterId || p.id === c.characterId);
      characters.push(newEnemyCharacter(c.characterId, (page?.title ?? abilityName(project, c.characterId)).slice(0, 80)));
      issues.push({ stage: "cast", code: "placeholder-character", message: `"${c.characterId}" doesn't exist yet: placed a placeholder enemy for the cast stage to make`, roomId: id });
    }
  }
  const enemies = new Map(characters.filter((c): c is EnemyCharacter => c.kind === "enemy").map((c) => [c.id, c]));

  const report = progressionReport(project);
  const ctx: Context = {
    project,
    params: movementParams(player, project.world.gravity),
    enemies,
    arrival: (regionId) => {
      const k = report.regionSphere[regionId];
      if (k === undefined) return [];
      const have = project.progression.abilities.filter((a) => (report.abilitySphere[a.id] ?? Infinity) < k).map((a) => a.mechanic);
      return [...new Set(have.filter(isMovement))].sort();
    },
    saves: project.world.rules.save !== "never",
    issues,
    grants: new Set(),
    keys: new Set(),
  };

  const found: { start: Built["start"]; ending: boolean } = { start: null, ending: false };
  const totals = { rooms: 0, enemies: 0, pickups: 0, saves: 0, locks: 0, gates: 0 };
  const rooms = project.world.rooms.map((room) => {
    if (!ids.includes(room.id)) return room;
    const built = populateRoom(ctx, plans.get(room.id)!, room);
    if (built.start) found.start ??= built.start;
    found.ending ||= built.ending;
    totals.rooms++;
    for (const k of ["enemies", "pickups", "saves", "locks", "gates"] as const) totals[k] += built.counts[k];
    return built.room;
  });
  for (const id of ids) {
    if (!project.world.rooms.some((r) => r.id === id)) issues.push({ stage: "geometry", code: "missing-room", message: `plan room "${id}" has no world room yet (run geometry)`, roomId: id });
  }

  const { start, ending } = found;
  let world: World = { ...project.world, rooms };
  if (start) world = { ...world, start, playtest: { ...start, abilities: [] } };
  const screens = grantScreens(project, ctx.grants);
  const keyItems: Item[] = [...ctx.keys].map((id) => grantItem(project, id));
  const modals: Modal[] = [...screens.modals, ...(ending ? [endingModal(project)] : [])];
  world = withMissing(world, modals, [...screens.items, ...keyItems]);

  const parts = [
    `${totals.rooms} room(s)`,
    `${totals.enemies} enemies`,
    totals.locks ? `${totals.locks} locked fight(s)` : "",
    totals.pickups ? `${totals.pickups} pickup(s)` : "",
    totals.gates ? `${totals.gates} key gate(s)` : "",
    totals.saves ? `${totals.saves} save point(s)` : "",
    start ? "the start" : "",
    ending ? "the ending" : "",
  ].filter(Boolean);
  // Each room filled now records the plan it was built from (the studio flags one whose plan changes after).
  const filled = new Set(ids.filter((id) => project.world.rooms.some((r) => r.id === id)));
  const architect = { ...project.architect, rooms: project.architect.rooms.map((r) => (filled.has(r.id) ? { ...r, built: roomBuildStamp(project.architect, r) } : r)) };
  return {
    project: { ...project, characters, world, architect },
    issues,
    summary: `populated ${parts.join(", ")}${issues.length ? ` (${issues.length} issue(s))` : ""}`,
  };
}

const ORDER: Record<RoomContent["kind"], number> = { start: 0, ending: 1, save: 2, pickup: 3, enemy: 4 };

function populateRoom(ctx: Context, plan: RoomPlan, room: WorldRoom): Built {
  const { project, params, issues } = ctx;
  const ledge = project.world.ledgeThickness;
  const spots: RoomSpots = roomSpots(room, params, ctx.arrival(plan.regionId), ledge);
  const props: Prop[] = [];
  const spawns: RoomSpawn[] = [];
  const handlers: Handler[] = [];
  const counts = { enemies: 0, pickups: 0, saves: 0, locks: 0, gates: 0 };
  let start: Built["start"] = null;
  let ending = false;
  let endOnGuardian = false;
  const used = new Set<string>();
  const unique = (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = safeId(base, String(n));
    used.add(id);
    return id;
  };
  const issue = (code: string, message: string, stage: StageIssue["stage"] = "population") => issues.push({ stage, code, message, roomId: room.id });
  const prop = (p: Record<string, unknown>) => props.push(Prop.parse(p));

  // Key gates: links leaving this room (its `a` end) that need keys.
  for (const { link, here } of roomLinks(project.architect, room.id)) {
    if (here !== "a") continue;
    const keys = link.requires.filter((id) => isHeldGrant(project, id));
    if (!keys.length) continue;
    const door = room.doors.find((d) => d.id === linkDoorId(link.id, "a"));
    if (!door) {
      issue("missing-door", `no door "${linkDoorId(link.id, "a")}" for the link ${link.id}, so its key gate isn't built`, "geometry");
      continue;
    }
    keys.filter((k) => isItemGrant(project, k)).forEach((k) => ctx.keys.add(k));
    const lacking = anyOf(keys.map((k) => ({ type: "not", of: hasCondition(project, k) }) as GameCondition));
    const names = keys.map((k) => abilityName(project, k)).join(" and ");
    prop({ id: unique(safeId("gate", link.id)), name: `Lock (${names})`.slice(0, 80), ...doorRect(door, room), color: GATE_COLOR, solid: lacking, visible: lacking });
    counts.gates++;
  }

  const contents = plan.contents.map((c, i) => ({ c, i })).sort((a, b) => ORDER[a.c.kind] - ORDER[b.c.kind] || lockFirst(a.c, b.c) || a.i - b.i);
  const tracked: { beaten: string; lock: boolean; downs: string[] }[] = [];
  // Each tracked spawn's victory: when it fires (its handler's conditions) and the fight it wins.
  const victories: { spawn: string; beaten: string; when: GameCondition[] }[] = [];
  const victoryFx = (beaten: string, grants: string[], lock: boolean): Effect[] => [
    { type: "setFlag", flag: beaten, value: true },
    ...grants.map((g) => grantEffect(project, g)),
    ...(lock ? ([{ type: "shake", strength: 10, seconds: 0.5 }, { type: "slowMotion", scale: 0.3, seconds: 0.8 }] as Effect[]) : []),
    ...grants.map((g): Effect => ({ type: "showModal", modal: messageModalId(g) })),
    ...(ctx.saves ? ([{ type: "saveRun" }] as Effect[]) : []),
  ];
  const giveFx = (got: string, g: string): Effect[] => [{ type: "setFlag", flag: got, value: true }, grantEffect(project, g), { type: "showModal", modal: messageModalId(g) }];

  for (const { c } of contents) {
    switch (c.kind) {
      case "start": {
        const spot = spots.pick({ width: params.width, height: params.height });
        if (!spot) issue("no-spot", "no reachable spot for the start", "geometry");
        else start = { room: room.id, x: spot.x, y: spot.y };
        break;
      }
      case "ending": {
        if (c.after === "guardian") {
          // No marker: the room's guardians' victory ends the game (added once the fights are built, below).
          endOnGuardian = true;
          ending = true;
          break;
        }
        const spot = spots.pick(ENDING);
        if (!spot) {
          issue("no-spot", "no reachable spot for the ending", "geometry");
          break;
        }
        const region = project.progression.regions.find((r) => r.id === project.progression.ending);
        prop({ id: unique("ending"), name: region ? `The end: ${region.name}`.slice(0, 80) : "The end", x: spot.x - ENDING.width / 2, y: spot.y - ENDING.height, ...size(ENDING), color: "#f2e6c0", handlers: [{ on: { type: "touch" }, do: [{ type: "endGame", modal: ENDING_MODAL }] }] });
        ending = true;
        break;
      }
      case "save": {
        const spot = spots.pick(SAVE);
        if (!spot) {
          issue("no-spot", "no reachable spot for the save point", "geometry");
          break;
        }
        const effects: Effect[] = [{ type: "setCheckpoint" }, { type: "heal", amount: null }, ...(ctx.saves ? ([{ type: "saveRun" }] as Effect[]) : [])];
        prop({ id: unique("save"), name: "Save point", x: spot.x - SAVE.width / 2, y: spot.y - SAVE.height, ...size(SAVE), color: "#5aa8d0", prompt: "Rest", handlers: [{ on: { type: "interact" }, do: effects }] });
        counts.saves++;
        break;
      }
      case "pickup": {
        const spot = spots.pick({ width: PICKUP.width, height: PICKUP.height + PICKUP.lift });
        if (!spot) {
          issue("no-spot", `no reachable spot for the ${c.grants} pickup`, "geometry");
          break;
        }
        const got = safeId("got", c.grants);
        ctx.grants.add(c.grants);
        prop({
          id: unique(safeId("pickup", c.grants)),
          name: abilityName(project, c.grants).slice(0, 80),
          x: spot.x - PICKUP.width / 2,
          y: spot.y - PICKUP.height - PICKUP.lift,
          ...size(PICKUP),
          color: "#e8c547",
          visible: flag(got, false),
          handlers: [{ on: { type: "touch" }, do: giveFx(got, c.grants) }],
        });
        counts.pickups++;
        break;
      }
      case "enemy": {
        const character = ctx.enemies.get(c.characterId);
        if (!character) {
          issue("not-an-enemy", `"${c.characterId}" is not an enemy character`, "cast");
          break;
        }
        const placed = Array.from({ length: c.count }, () => spots.pick({ width: character.size.width, height: character.size.height, awayFromDoors: ENEMY_DOOR_DISTANCE })).filter((s) => s !== null);
        if (placed.length < c.count) issue("no-spot", `room for ${placed.length} of ${c.count} ${c.characterId}`, "geometry");
        if (!placed.length) break;
        const track = c.lockRoom || c.grants.length > 0;
        const key = unique(safeId(room.id, c.characterId));
        const beaten = safeId(key, "beaten");
        const ids = placed.map((_, i) => unique(safeId(c.characterId, String(spawns.length + i + 1))));
        const downs = placed.length > 1 && track ? ids.map((id) => safeId(key, id, "down")) : [];
        c.grants.forEach((g) => ctx.grants.add(g));
        placed.forEach((spot, i) => {
          const victory = victoryFx(beaten, c.grants, c.lockRoom);
          const victoryWhen: GameCondition[] = downs.length ? [allOf(downs.filter((_, j) => j !== i).map((d) => flag(d)))] : [];
          const own: Handler[] = !track
            ? []
            : downs.length
              ? [
                  { on: { type: "enemyKilled" }, when: [], do: [{ type: "setFlag", flag: downs[i]!, value: true }] },
                  { on: { type: "enemyKilled" }, when: victoryWhen, do: victory },
                ]
              : [{ on: { type: "enemyKilled" }, when: [], do: victory }];
          if (track) victories.push({ spawn: ids[i]!, beaten, when: victoryWhen });
          spawns.push({
            id: ids[i]!,
            characterId: c.characterId,
            x: spot.x,
            y: spot.y,
            when: track ? flag(beaten, false) : null,
            healthBar: c.healthBar ? { title: (project.wiki.pages.find((p) => p.characterId === character.id)?.title ?? character.name).slice(0, 60) } : null,
            handlers: own,
          });
        });
        counts.enemies += placed.length;
        if (track) tracked.push({ beaten, lock: c.lockRoom, downs });
        if (placed.length < c.count && track) issue("partial-fight", `${c.characterId}: only ${placed.length} of ${c.count} placed; the fight is won when those fall`);
        break;
      }
    }
  }

  // An ending after the guardian: when the last of the room's tracked fights is won, the game ends (each
  // tracked spawn checks after its own victory, so whichever falls last ends it).
  if (endOnGuardian) {
    if (!tracked.length) {
      issue("ending-no-guardian", "the ending waits on this room's guardian, but the room has none (an enemy that locks the room or gives something)", "plan");
    } else {
      // Conditions are read as the kill happens (before its effects): the end waits on this fight's own
      // victory condition and on every other fight already won.
      for (const v of victories) {
        const others = [...new Set(tracked.map((t) => t.beaten).filter((b) => b !== v.beaten))].map((b) => flag(b));
        const when = [...v.when, ...(others.length ? [allOf(others)] : [])];
        spawns.find((sp) => sp.id === v.spawn)?.handlers.push({ on: { type: "enemyKilled" }, when, do: [{ type: "endGame", modal: ENDING_MODAL }] });
      }
    }
  }

  // Per-visit kill tracking starts over on every entry (the spawns are rebuilt with it).
  const downs = tracked.flatMap((t) => t.downs);
  for (const part of chunk(downs, 20)) handlers.push({ on: { type: "roomEntered" }, when: [], do: part.map((d): Effect => ({ type: "setFlag", flag: d, value: false })) });

  const locks = tracked.filter((t) => t.lock);
  if (locks.length) {
    const sealed = safeId(room.id, "sealed");
    const unbeaten = anyOf(locks.map((t) => flag(t.beaten, false)));
    handlers.push({ on: { type: "roomEntered" }, when: [unbeaten], do: [{ type: "setFlag", flag: sealed, value: true }] });
    const closed = allOf([flag(sealed), unbeaten]);
    for (const door of room.doors) {
      prop({ id: unique(safeId("seal", door.id)), name: "Sealed door", ...doorRect(door, room), color: SEAL_COLOR, solid: closed, visible: closed });
    }
    counts.locks += locks.length;
  }

  // A prop rebuilt in its old place (the same id: the same pickup, save point, gate or ending) keeps its drawn art.
  const drawn = new Map(room.props.flatMap((p) => (p.art ? [[p.id, p.art] as const] : [])));
  const kept = props.map((p) => (!p.art && drawn.has(p.id) ? { ...p, art: drawn.get(p.id)! } : p));
  return { room: { ...room, spawns, props: kept, handlers }, start, ending, counts };
}

const size = (s: { width: number; height: number }) => ({ width: s.width, height: s.height });
const lockFirst = (a: RoomContent, b: RoomContent) => (a.kind === "enemy" && b.kind === "enemy" ? Number(b.lockRoom) - Number(a.lockRoom) || b.grants.length - a.grants.length : 0);

