# Anomaly

AI-native 2D game studio. A React workspace hosting a Godot 4 runtime that is
built entirely from a structured, validated project spec.

## Run it

Requires Node 24+ and Godot 4.7 with web export templates (`godot` on PATH,
or set `GODOT=/path/to/godot`).

```sh
npm install
npm run dev          # exports the game on first run, then serves http://localhost:5173
```

**Access token.** The API is protected by a token (generated once into
`.studio-token`, which git ignores). The dev server prints a link ending in
`?token=…`. Open that once and the browser keeps a cookie; opening the
studio without it shows a message instead. Scripts send the header
`x-studio-token: $(cat .studio-token)`. Set `STUDIO_TOKEN` to override.

**From another machine** (e.g. over VPN): Godot's web runtime only starts on
HTTPS or localhost. Either run `npm run dev:remote` (self-signed HTTPS; accept
the browser warning once) and open `https://<this-machine>:5173`, or tunnel:
`ssh -L 5173:localhost:5173 <this-machine>` and open `http://localhost:5173`.

Click **Play**, move with A/D or arrows, jump with Space/Z, attack with X/J
(hold W/Up to swing up; hold S/Down in the air to strike down and pogo).
With abilities on (tick them in the player's inspector): dash with C/Shift/K,
jump again in mid-air, press toward a wall to slide and jump off it, hold jump
while falling to glide, S/Down + jump in the air to ground pound (smashes the
cracked platform).
**Stop** resets the playtest. Edit stats in the inspector while stopped; Play again to test.
**Undo** (or Ctrl/Cmd+Z outside a text field) reverts the last change.

The project is saved in `projects/default/` (`project.json` + an append-only
`history.jsonl`). Delete that folder to start over. Set `STUDIO_DATA_DIR` to
use a different folder.

| Command | What it does |
|---|---|
| `npm test` | Unit tests (schema, operations, server, agent) plus headless Godot primitive tests (`game/test`, needs `godot` on PATH) |
| `npm run e2e` | Browser tests against the real runtime (own server on port 5199, or `E2E_PORT`; throwaway project) |
| `npm run typecheck` | TypeScript check |
| `npm run build:game` | Re-export the Godot runtime. Only needed after GDScript/engine changes, never for content edits |

## Layout

```
packages/core   Project schema (Zod), operations, undo, API + runtime protocol types. Pure.
packages/server Project store (disk, history, undo, locking) + token-protected HTTP API. Mounted in Vite.
packages/agent  AI agent: tools generated from the core schemas, turn loop, fake model for tests.
packages/art    Art pipeline: OpenRouter image/vision clients, prompts, concept -> rig -> animation stages, fakes.
apps/studio     React workspace. session.ts mirrors the server's project, drives the runtime.
game/           Godot project. Builds the scene from whatever spec it is sent.
e2e/            Playwright acceptance test.
```

## Key rules

- **The project spec is the source of truth.** It changes only through
  operations in `packages/core/src/operations.ts`: pure functions that take
  untrusted input and return `{ ok: true, project } | { ok: false, error }`.
  The UI and (later) the AI use the same operations.
- **The server owns the project.** The studio, scripts, and (later) the AI all
  edit through the same HTTP API; every change is validated, saved,
  attributed (`user`/`ai`), and pushed live to open studios.
- **Edits name the revision they're based on.** If the project moved on, the
  edit is rejected (`stale_revision`) instead of silently overwriting, unless
  everything since was a background save (art, the live cast and rooms): then
  it applies on top. Undo is always strict (see *Live* below).
- **No editing while playing.** Play takes a server-side lock and freezes a
  snapshot; Stop rebuilds the scene from the spec (= reset). Edits from
  anywhere are rejected with `locked` until then.
- **Characters are types.** Editing a character changes every spawn of it.
- **Behaviors are data.** Each enemy has a state machine: every state runs
  one *action* primitive and leaves via *transitions* guarded by *condition*
  primitives (contract: `packages/core/src/behavior.ts`; implementations:
  `game/primitives/`, one small file each). The runtime reports its
  primitive list on boot and the studio flags any mismatch.
  - Actions: patrol, wait, chase, charge, telegraph, retreat, returnHome,
    jump, hover, and the attacks strike, shoot, leap, slam, summon, teleport
    (see "Enemy combat primitives"). Conditions: playerWithin, playerBeyond, after, hitWall,
    actionDone, atLedge, onGround, airborne, playerAbove, playerBelow,
    playerLevel, playerInFront, playerBehind, canSeePlayer, wasHit,
    healthBelow, chance.
  - Combat: the player has health (HUD pips; at 0 the run restarts on the
    same seed), a sword with damage, reach and cooldown, and a pogo bounce.
    Enemies have health and contactDamage; hits flash, knock back and
    freeze the game for a few frames (hit-stop).
  - A transition can require extra conditions with `and` (e.g. the starter
    Charger: playerWithin 260 and playerLevel 60).
  - Behaviors may have *interrupts* (transitions checked from every state).
    Enemies are `ground` or `flying`. Each playtest has a seed (shown in the
    toolbar, replayable) that drives `chance`.
  - Primitive tests run the real game headless (`game/tests/simulate.gd`)
    at a fixed 60 fps and assert positions and states.
- **Geometry is tiles.** Rooms are grids of 32 px tiles
  (`packages/core/src/world/tiles.ts`): `.` empty, `#` solid, `=` ledge
  (thin and solid; thickness is one per-game setting, `world.ledgeThickness`),
  `-` one-way (jump up through it), `^` hazard, `%` breakable (a ground pound
  smashes the whole connected area). Collision rectangles are derived from
  the grid (`gridToSolids`) and sent to the runtime with the project
  (`toRuntimeProject`), never stored. The game's rooms, doors and rules live
  in `project.world` (`world/world.ts`). There is no separate test arena:
  the starter project's arena is an ordinary room, and `world.playtest`
  (room, spot, abilities) is what ▶ Play tests.
- **Terrain is drawn from the grid, as one mass** (`game/scripts/terrain.gd`):
  every cell is filled with one material (flat color, or the biome's ground
  texture sampled in world space), darkened by its distance from the nearest
  exposed edge. Lit rims run along exposed tops only, fine edges along exposed
  sides, darkening inside exposed undersides; nothing is drawn between two
  solid cells or outside them. Ledges are planks, one-ways a board on posts
  with a dashed rim, hazards spikes, breakables cracked; a smash clears its
  cells. `describe()` reports what was drawn, for the headless probe
  (`game/tests/terrain_probe.gd`, `game/test/terrain.test.ts`).
- **Movement is exact and modelled.** The player moves with its own
  box-against-rectangles code (not Godot's `move_and_slide`), mirrored line
  for line by `packages/core/src/movement/` in TypeScript. On top of that
  simulation, `movementModel(params, abilities)` searches jump, double-jump,
  dash and glide timings to say how high the player reaches, the widest gap
  it can cross for any height difference, and whether it can climb walls or
  smash floors. Level checks (and later the Architect) rely on it.
  `game/test/movement.test.ts` runs the same inputs through both and requires
  them to agree to 0.001 px, and replays the model's best jumps in the
  runtime to confirm its predicted gaps are exactly crossable.
  - Abilities: dash, double jump, wall jump (with wall slide), glide, ground
    pound; each tunable on the player. Coyote time, jump buffering and
    short hops are built in. Which abilities the player has comes from the
    playtest (`world.playtest.abilities`) or the run's start for now, from
    pickups later.
- **Schema changes ship with a migration** (`packages/core/src/migrations.ts`);
  older project files are upgraded when loaded.
- **The protocol speaks project terms, not Godot terms**, so the runtime is
  replaceable. See `packages/core/src/protocol.ts`.

## Programmatic API

The HTTP API (contract in `packages/core/src/api.ts`) is what the AI will use.
Edit from a terminal while the studio is open and watch it update:

```sh
export H="x-studio-token: $(cat .studio-token)"
curl -s -H "$H" localhost:5173/api/project | jq .project.revision        # current revision, e.g. 3
curl -s -H "$H" -X POST localhost:5173/api/ops -H 'content-type: application/json' -d '{
  "name": "updateCharacter",
  "input": { "characterId": "crawler", "changes": { "stats": { "knockback": 500 } } },
  "baseRevision": 3, "author": "ai" }'
curl -s -H "$H" -X POST localhost:5173/api/undo -H 'content-type: application/json' -d '{"baseRevision": 4}'
curl -s -H "$H" localhost:5173/api/history
curl -s -H "$H" -X POST localhost:5173/api/chat -H 'content-type: application/json' -d '{"message": "make the Crawler faster"}'
curl -s -H "$H" localhost:5173/api/chat | jq '.entries[-1]'                # the reply, once done
```

(With `npm run dev:remote`, use `curl -k https://…`.)

Operations (all in `packages/core/src/operations.ts`):

| Operation | Does |
|---|---|
| `createCharacter` | Add an enemy type (`{ character }`); not placed until spawned |
| `duplicateCharacter` | Copy a type under a new id (`{ characterId, newId, name? }`), e.g. for variants |
| `deleteCharacter` | Remove a type and all its spawns (the player can't be deleted) |
| `updateCharacter` | Name, color, size, stats |
| `updateBehavior` | Targeted edit of one state, e.g. `{"characterId":"charger","stateId":"windup","transitions":[{"index":0,"when":{"seconds":1.2}}]}` |
| `setBehavior` | Replace a whole state machine |
| `createWorldRoom` / `updateWorldRoom` / `resizeWorldRoom` / `deleteWorldRoom` | Game-world rooms (`world/operations.ts`); deleting one unlinks doors to it |
| `paintTiles` | Fill a rectangle or a list of cells of a room's grid with one tile kind |
| `setDoor` / `removeDoor` / `connectDoors` | Door openings and their links (right <-> left, bottom <-> top) |
| `addRoomSpawn` / `moveRoomSpawn` / `removeRoomSpawn` | Enemies in rooms (spawns have stable ids like `charger_1`) |
| `setWorldStart` / `setPlaytest` / `setGameRules` / `setLedgeThickness` | Where the game begins, what ▶ Play tests (room, spot, abilities), death/saving/hazard rules, ledge thickness |

`POST /api/batch` applies several operations atomically, as one revision and
one undo step; if any step fails nothing changes and the error names the step:

```sh
curl -s -H "$H" -X POST localhost:5173/api/batch -H 'content-type: application/json' -d '{
  "baseRevision": 3, "author": "ai", "operations": [
    { "name": "duplicateCharacter", "input": { "characterId": "charger", "newId": "fast_charger" } },
    { "name": "updateBehavior", "input": { "characterId": "fast_charger", "stateId": "charge", "action": { "speed": 800 } } },
    { "name": "addRoomSpawn", "input": { "roomId": "arena", "characterId": "fast_charger", "x": 1000, "y": 672 } } ] }'
```

In the browser console, `window.studio` exposes the same operations plus
runtime control: `studio.updateCharacter(...)`, `studio.applyOperation(name, input)`,
`studio.applyBatch([...])`, `studio.undo()`,
`studio.play()`, `studio.stop()`, `await studio.getRuntimeState()`.

Exporting the game (see *Exporting a game*): `POST /api/export` with `{}` builds it and answers
`{ ok, export: { name, title, zip, zipBytes, folderBytes, files: [{ path, bytes, kind }], revision } }`
(`invalid_input` without a start, `unavailable` if the runtime isn't built); `GET /api/export/<zip>`
downloads the zip:

```sh
curl -s -H "$H" -X POST localhost:5173/api/export -H 'content-type: application/json' -d '{}' | jq .export.zip
curl -s -H "$H" -o game.zip localhost:5173/api/export/descent-slice.zip
```

## Chat

The chat panel (right) follows the tab: on **Playtest** it is the build
assistant, which changes the game from plain-language requests; on **Wiki**
and **Progression** it is the director (see below). Each agent keeps its own
conversation.

- **Backend:** your local Claude Code login, through the Claude Agent SDK
  (`packages/agent/src/claudeCode.ts`). The AI can only call the game tools:
  Claude Code's built-in tools, settings and MCP servers are all switched
  off. This is for personal local use; anything other people use needs an
  API key (OpenRouter, later).
- **Settings:** `STUDIO_CHAT_MODEL` (default `claude-sonnet-5-5`);
  `STUDIO_CHAT_BACKEND=fake` swaps in a scripted model (used by e2e).
- **Turns:** one at a time across both agents. Each turn's changes are saved as one AI change
  (one Undo). While a turn runs, user edits and playtests are locked; sending
  during a playtest stops it first. Cancel saves nothing.
- **Storage:** conversations and per-turn token/cost estimates live in
  `<project>/chat.jsonl` (build) and `<project>/narrative-chat.jsonl`; the
  server logs one `[chat:<agent>]` line per turn. The API picks an agent with
  `?agent=build|narrative` (default build).
- **Reset…** backs up the project folder to `<project>/backups/<time>/`, then
  starts from the starter project and an empty chat.
- **Live tests:** `ANOMALY_LIVE_CLAUDE=1 npx vitest run claudeCode.live narrative.live`
  (uses your Claude plan).

## Live: the studio fills in as you design

While the director (or you) writes the wiki and the progression, the studio
builds from them in the background (`packages/server/src/live/service.ts`):

- **Characters from the wiki.** A wiki page that describes a game character
  becomes one: an enemy page gets a new enemy (the page's id, linked to the
  page), the player page is linked to the player (who takes its title). New
  enemies get a behavior from their page (one build-assistant turn on a
  private copy, at first-region strength), then each gets its art (an `auto`
  art job briefed from the page). Which pages are game characters is read from
  the page (core `gameCharacterPages`): its `in_game` field (`player`, `enemy`,
  `enemy (boss)`, or `none` for story-only people; the director writes it),
  else its link to a character, the progression's region enemy and boss lists,
  or a `role` that starts with a character kind. Each page is handled once:
  undoing or deleting what it made doesn't bring it back.
- **Rooms from the progression.** Once the progression has regions and a
  start, the Architect's code stages build rooms for it with no model and no art
  (core `buildPreview`: the plan seeded from the progression, then layout,
  geometry and population; in a worker thread) and rebuild them when the
  progression changes. Not done: difficulty variants and the screens stage,
  and your playtest spot is kept. The preview owns the plan only until someone
  shapes it: a plan edit, a pinned room, an Architect run, an edited or dressed
  room (fingerprints in `architect.preview`). From then on a progression change
  marks the Architect's done stages stale instead; you rebuild from the
  Architect tab. **Build game** treats an untouched preview as a fresh plan.
- **Concurrency.** A chat turn or an Architect run holds the project (only the
  AI's edits pass; the creator's wait, as before); a playtest refuses all edits.
  Background work (art jobs, the live cast's saves and its behavior turn, the
  live rooms) holds no lock and never locks the studio: its results are saved
  through `ProjectStore.commitBackground`, each as its own AI revision applied
  to the project as it is at that moment, and wait while a chat turn, an
  Architect run or a playtest is underway (the toolbar says so). A reset stops
  it. An edit you based on a revision that only background saves have moved on
  from still applies.
- **Undo** stays linear: it takes back the latest revision, whoever made it, so
  after a background save Undo takes back that save first (each is one step).
  An Undo based on a stale view is refused with a note rather than undoing
  something you haven't seen; a chat turn's own "Undo this" shows only while
  the turn is the latest change.
- **Studio:** the toolbar's *Live* menu shows what runs (`drawing Moth Knight
  (rig) · 2 art jobs queued`) and turns each half on or off; the character list
  tags characters being written or drawn; the Rooms and Architect sidebars say
  what the live rooms did.
- **Settings:** `STUDIO_LIVE` = `on` (default), `off`, `cast` or `rooms` for a
  project with no `<project>/live.json` yet (that file keeps the switches, the
  pages handled and the progression followed). Turning it on for an existing
  project counts what is already there as done. API: `GET /api/live`,
  `POST /api/live {cast?, rooms?}`; SSE `live` events.

## Wiki and the director

The **Wiki** tab is the game's bible: overview, characters, places,
factions, lore, story beats, and any other kind you need (kinds are open:
type a new one, e.g. `deity`, and it gets its own group). Pages have a
summary, free-form fields, a Markdown body with `[[page_id]]` links, and can
link to an in-game character (the inspector then shows "Wiki page →").

- **Canon vs draft:** pages you write or edit are canon. The director's
  pages are drafts until you **Accept** (or **Discard**) them.
- **The director** (`packages/agent/src/narrative/`) builds around your
  direction: it fills small gaps itself, asks before major decisions
  (antagonist, ending, twists), flags contradictions, and can't change or
  delete canon unless you asked for that change (enforced in its tools).
- **Gaps** (`packages/core/src/wiki/gaps.ts`): missing overview, broken links,
  in-game characters without a page, pages for deleted characters. Shown in
  the sidebar and given to the director.
- Wiki edits are ordinary project operations (`createWikiPage`,
  `updateWikiPage`, `acceptWikiPage`, `deleteWikiPage`), so Undo covers them.
  The wiki is not sent to the game runtime.
- **The build assistant reads it** (`packages/agent/src/domains/design.ts`):
  `getWikiPage` and `getProgression`, plus a **Design** section in its project
  summary (regions with their rooms in the world and where their abilities are
  given, abilities, gates, the cast's pages). Ask it to "build region X from
  the wiki" and it puts the rooms in that region and places its pickups and
  gates as the progression says.
- **Character art briefs:** with no brief given, a character's concepts are
  drawn from its wiki page (title, summary, looks fields such as
  `appearance`, then the body; ~600 chars). An explicit brief wins.

## Progression

The **Progression** tab is the game's structure (`project.progression`,
`packages/core/src/progression/`): **regions** (rooms, enemies, boss, wiki
place page), **abilities** and key items (a mechanic from a fixed list, or
`key`; where each is found and what you need to get it), **connections**
between regions (two-way or one-way, gated by abilities), **story beats**
(a wiki story page placed in a region), and the start and ending.

- **Checks** (`report.ts`, `progressionReport`): sphere 0 is what's reachable
  from the start with nothing; collecting what's there opens sphere 1, and so
  on. From that: whether the game is finishable, the **critical path**
  (abilities the ending can't be reached without), and issues. Errors:
  unbeatable, soft-locks (somewhere you can reach at some sphere that the
  ending can't be reached from, e.g. a one-way drop), unobtainable
  abilities, no start or ending. Warnings: unreachable regions and beats,
  unplaced abilities, abilities that gate nothing, everything available at
  once, story beats out of the wiki's `order`, links to missing wiki pages.
  Issues never block an edit.
- **The graph** lays regions out in one column per sphere: drafts dashed,
  errors red, one-way connections with arrows, gates labelled; critical
  abilities in gold. Click anything to edit it; the creator's edits are canon.
- **Operations:** create/update for each kind, `setProgressionEnds`,
  `acceptProgressionItem`, `deleteProgressionItem` (ids are unique across
  kinds; deletes clean up references, as does deleting an enemy).
- **The director** designs it with you: same canon/draft rules, asks before
  the big structure (how many regions and abilities, what opens the ending),
  and checks for errors before replying. Not sent to the game runtime; the
  ability mechanics come next.
- **Against the world** (`progression/lint.ts`, project lint warnings, static):
  silent until some room is in a region (Rooms' **Region** picker or
  `updateWorldRoom regionId`), then: every region has a room; an ability
  obtained in a region is given by a handler on a room, prop or spawn of that
  region: `grantAbility <mechanic>`, or for a `key`, `giveItem` of an item whose
  id is the ability's id or its last words (`hatch_key` ← `key`; `swim` isn't
  checked); every connection has a door between rooms of its two regions.

## Agent internals

`packages/agent`:

- **Agents** (`profile.ts`): the build assistant and the director (id
  `narrative`), each an instruction builder plus a tool set.
- **Tools** (`tools.ts`): every core operation except the wiki's and
  progression's (the director's, in `narrative/`) is a build tool with the same name;
  parameter schemas are generated from the core Zod schemas (with field
  descriptions), plus read tools `getProjectSummary`, `getCharacter`,
  `listPrimitives`. Errors list valid ids; writes report lint warnings
  (`packages/core/src/lint.ts`).
- **Turns** (`turn.ts`): any backend stages writes on a draft and saves them
  as **one batch** at the end (author `ai`). Step limits, cancellation and
  model errors save nothing.
- **Backends:** `claudeCode.ts` (Agent SDK runs the tool loop) and `loop.ts`
  (our own loop over an OpenAI-style `ModelClient`, ready for OpenRouter).
  `FakeModel` replays scripted replies for tests.

## Studio modes

The toolbar groups the modes in the creator's order: **Design** — **Wiki**, **Progression** (design
documents, with the director's chat) and **Architect** (the world plan and its build); **Build** —
**Rooms** (the game world), **Scenery** and **Characters** (art workbenches) and **Game** (the whole
game's check, art, rules, map and screens); **Play** — **Playtest** (play and tune in the playtest room).
The project menu (the game's name) renames the game, loads the example game or starts over (the
starter project, or from scratch: the player alone in an empty arena). The game runtime stays mounted the whole time; modes
only move it between named grid areas and send it a `stage` message (the playtest room,
one character, a dressing or a game-world room). The sidebar resizes from its left edge and the
chat collapses to a strip (both remembered per browser); the stage has a
full-screen button. Leaving the mode a playtest runs in stops it; Play returns to the playtest room.

## Rooms (the game world)

**Rooms** mode edits `project.world`: a world map of the rooms (by `at`, with
lines for connected doors, colored by progression region; the **Region** picker
sets the selected room's), the selected room live in the runtime (stage
`room`) with a tile painter over it (pick a kind, click or drag: one stroke is
one undoable `paintTiles`), doors (add, connect, disconnect), enemy spawns, the
start and the rules. **📍 Spot** marks a point for **Set start here**, **Playtest
here** (where ▶ Play in **Playtest** starts), **+ Enemy at spot** and **▶ Play from
here** (with the chosen abilities); **▶ From start** and **Continue** (the run saved
in this browser) play from the world's start. While playing, the sidebar follows the
player from room to room (`roomEntered`).

World play (`play` with `world: { room, x, y, abilities, continue? }`;
`game/scripts/world_runtime.gd`): leaving through a door opening enters the
door it leads to at the matching place along it, keeping velocity (falling
through a floor keeps falling; going up through a ceiling gets enough lift to
land beside the opening). Enemies respawn on entering. On death the player
comes back where they entered the room (moved to the first ground they stood
on) or at the world's start (`rules.onDeath`); a hazard tile costs
`rules.hazardDamage` and puts them back on the last safe ground (both feet on
solid, ledge or one-way). With `rules.save: "room"` the web build saves the run
(room, entry, abilities, visited) to localStorage on entering each room.
The rules are thin event handlers over small effects in `world_runtime.gd`
(`respawn_at`, `restore_health`, `apply_damage`, `return_to_safe_ground`,
`save_run`), ready to be bound to events directly later.
`fixtureWorld()` (`world/fixture.ts`) is a six-room test world; `game/test/world.test.ts`
plays doors, rules and a full start-to-end route in the headless runtime.

## Game logic (handlers)

Game logic is data, made of generic primitives (`packages/core/src/events/events.ts`,
run by `game/scripts/events.gd`). A **handler** is `{ on, when, do }`: when the
event happens and every condition holds, the effects run in order.

- **Events:** gameStarted, roomEntered, roomSettled (first safe ground in a room),
  roomCleared, enemyKilled (any, a spawn, or a character), playerDied,
  hazardTouched, timer, and a prop's touch, interact (Up / W), hit and destroyed.
- **Conditions:** flag, item (at least n), ability, visited, and all / any / not.
- **Effects:** setFlag, giveItem, takeItem, grantAbility, heal, damage, respawn
  (at entry, start or checkpoint), returnToSafeGround, setCheckpoint, saveRun,
  startTimer; showModal, endGame, revealMap (modal.gd); shake, flash, hitStop,
  slowMotion (fx.gd).
- **Conditional spawns:** a spawn's `when` (setSpawnCondition) keeps an enemy out of
  the room while it fails, e.g. `not flag x_beaten` for an enemy that stays beaten.
- **Where handlers live:** the world (any event), a room (its own events), a prop
  (its own touch / interact / hit / destroyed, plus room events) or an enemy spawn
  (its own death). Handlers may only name items, modals, rooms and spawns that exist.
- **Run state:** flags, items, abilities, the checkpoint and visited rooms. All of it is
  saved with the run (headless runs save in memory) and reported in the runtime's state.
- **Rules are presets.** `world.rules` (onDeath, save, hazardDamage) compiles to
  handlers (`ruleHandlers`) that `toRuntimeProject` sends before the world's own,
  so the runtime only knows handlers.
- **Conditions are judged when the event happens,** before any handler for it runs, so "with
  the item: open" and "without it: say it's locked" never both fire.
- **The fixture slice** (`world/fixtureSlice.ts`) is the fixture world turned into a small game
  from these primitives alone:
  - a title modal, then an item on a ledge that opens a hatch over the shaft;
  - a save spot, then a sanctum sealed while its guardian (a heavy enemy with a health bar) lives;
  - beating it unseals the sanctum and grants double jump (the guardian stays beaten: a conditional spawn);
  - a summit only that ability reaches (checked by the traversal checker), whose altar ends the game.
  `game/test/slice.test.ts` plays it from the title to the ending with scripted input. In the
  studio, **Example…** (toolbar) replaces the project with it (backing up first); ▶ Play starts it.
  `game/test/readiness.test.ts` has the build assistant (a scripted model) build a lock-and-key
  through its tools alone, then plays it.
- **No roles in code.** Keys, locked barriers, switches, save spots and boss
  fights are recipes: props, flags, items, enemies and handlers.
  `game/test/genericity.test.ts` fails if runtime or gameplay code names a role.
- **Studio:** the **Game** tab holds the rules, game handlers, items, modals and the
  map. **Rooms** holds each room's handlers, its props (the ▭ Prop tool) and each
  enemy spawn's health bar and handlers. All of these are edited with the shared
  `HandlerEditor`, whose forms come from the core schemas.

## Checking a game

`checkGame(project, { abilities?, withoutAbilities?, maxStates? })` (`packages/core/src/world/logic/check.ts`)
proves, without any model and with the same answer every time, that a game can be finished and
has no dead states: `{ hasEnding, beatable, route, deadStates: [{ path, why, fromSave }], reachableRooms, stats }`.
A dead state is one from which no ending can be reached; each is reported once per place the player
ends up stuck, with the shortest way in (readable steps) and a sentence naming what is missing
("Lock post (hall) needs item key; no key is left anywhere reachable from here", "stuck in pit: the
way out of pit needs double_jump", "after Continue: stuck in entrance, hall: Barrier blocks the way
(solid while flag hall_shut)"). `withoutAbilities` makes grantAbility of those do nothing (gate checks:
is a room in `reachableRooms` without it?).

- **The search** is breadth-first over states: the room, a traversal node (a standing surface, a door
  entry or a point the player is put at), what conditions read (flags they check, item counts up to
  the largest they check plus the largest single take, rooms in `visited`), abilities, the checkpoint,
  the visit (enemies alive, props hit or destroyed, where the player entered, settled), open modals
  and running timers.
- **Logic** runs through `world/logic/interpret.ts`, the runtime's engine mirrored in TypeScript
  (events.gd matching and scoping, conditions judged when the event happens, the run's effects,
  props, modals, saving and loading). `game/test/logic.test.ts` runs one scripted sequence through
  both (the runtime via `game/tests/logic_probe.gd`) and requires identical flags, items, abilities,
  checkpoint, modals and saves after every step.
- **Movement** is the traversal graph (simulated with the runtime's physics) of the room with the
  abilities and the props solid in that state, plus walking off open ends onto what is below (the
  traversal's steered drops miss a floor running on under a ledge).
- **Moves of the game:** moves and doors; touch (forced when a move's simulated path overlaps the
  prop; a choice when standing on a surface or jumping in place from it overlaps it); interact
  (standing or jumping in place); hit (the sword's reach from a surface, standing or jumping);
  killing any enemy alive in the room (fights count as winnable), each firing enemyKilled and the
  last roomCleared; touching hazards (from surfaces beside them); dying where it can happen (near a
  living enemy that can hurt, after any damage effect, a hazard's included); timers (any later time, outside modals);
  each modal button; endGame (with or without a modal) is the ending.
- **Saves:** the last saveRun of each step is a save; every distinct one is a Continue start (as
  `load_run` does: that room at its entry point, gameStarted again) that must also reach an ending.
  Quitting is not a way out of a dead state.
- **Approximations** (what it may miss or treat as possible): health is not tracked (any damage may
  kill); a surface is "anywhere on it", so standing touches are choices even where walking past
  would force them; events during a move don't change where it ends; door entries use the
  traversal's entry point, not the exact spot along the opening; a room settles on the first
  landing; enemies don't block; timers ignore their seconds; summoned enemies don't hold back
  roomCleared; props that solidify around the player at an entry are left out of that point's moves
  (props.gd waits until the player steps out). Truncated searches (`maxStates`, default 100k) count
  unexplored states as able to finish.

The build assistant has it as the read tool `checkGame` (`packages/agent/src/domains/logic.ts`,
a compact verdict); the **Game** tab's **Check the game** runs it in the studio and lists each dead
end with how to get stuck. Tests: `packages/core/test/logic.test.ts` (the slice and the reference
game beatable with no dead states, six mutations each caught with a readable counterexample, gate
checks, determinism and speed: the slice in well under a second, a 30-room game in about one),
`game/test/logic.test.ts` (the mirror) and `e2e/check.spec.ts`.

## Exporting a game

Project menu ▸ **Export game…** turns the project into a standalone web game anyone can play in a
browser, with no studio, server or editor. It runs **Check the game** first: a game that isn't proven
beatable (no ending, dead ends, a partial check) is said so in the page, with the reasons, and
exports only on **Export anyway**. The server then builds the export and the browser downloads its
zip; the dialog shows its size and what's in it.

- **What's in it** (`<project>/exports/<name>/` and `<name>.zip`, `<name>` a safe file name from the
  game's name): `index.html` (the boot page; the game's name is its title), `game.json` (the runtime
  project: `toRuntimeProject` without the Architect's plan and with only the art the game draws,
  stripped of concepts, briefs and previews; the start; the images; the controls), `files/<ref>` for
  every image the runtime is sent (`runtimeImageRefs`, the same set the studio sends) and nothing
  else, `runtime/index.*` (the Godot web runtime as built by `npm run build:game`) and `README.txt`.
  No wiki, progression, chats, history, plan, unused art, backups, `.env` or tokens. About 40 MB
  unzipped (the runtime's wasm), about 10 MB zipped; the same project gives the same zip, byte for byte.
- **Playing:** every URL is relative, so the folder works from any static host or subfolder (itch.io,
  GitHub Pages, `python3 -m http.server`), not from `file://`. The boot page
  (`packages/core/src/export/bootPage.ts`) hosts the unchanged runtime full window in an iframe and
  speaks the studio's side of the protocol: on `ready` it sends the images and the game, on `loaded`
  it plays from the world's start with no abilities (as *Play the game from its start*), resuming the
  run saved in this browser if there is one. The game's own rules decide death and saving; saves are
  the runtime's localStorage save, keyed `anomaly-save:<name>`. The controls show for a few seconds
  (and again from the corner **?**, with **Start over** when a save exists). For tests and embedders,
  `await window.game.state()` returns the runtime's `state`; `<body data-status>` is
  `loading | playing | error` and `data-room` the player's room.
- **Code:** `packages/core/src/export/` (the plan and boot page, pure), `packages/server/src/export/`
  (folder + zip builder, a dependency-free zip writer), `apps/studio/src/shell/ExportGame.tsx`.
  Tests: `packages/core/test/gameExport.test.ts`, `packages/server/test/gameExport.test.ts`,
  `e2e/export.spec.ts` (exports the example, serves the unzipped folder from a plain static server at
  the root and in a subfolder, and plays it).

## Props and items

A **prop** (`world.rooms[].props`, schema in `world/world.ts`) is a rectangle in a
room: drawn as its color or a biome kit piece (`art`), `solid` and `visible` each
always, never or while a condition holds, `health` (sword hits until it fires
`destroyed`), `bounce` (a downward strike bounces the player), a `prompt` and its
handlers. An **item** (`world.items`) is something the player carries, counted.
Operations (`props/operations.ts`): addProp, updateProp, removeProp, createItem,
updateItem, deleteItem (refused, naming the uses, while anything still names the
item). Lint (`props/lint.ts`): props outside their room, never visible (and so
handlers that never run), solid over the start or the playtest spot.

Runtime (`game/scripts/props.gd`, one node per built room):

- **Present** = visible holds and not destroyed this visit. Hidden props are gone: not
  drawn, not solid, no events. `refresh()` re-checks every prop when flags, items or
  abilities change (same frame) and on every room build.
- **Solid** props add `{x, y, w, h, kind: "solid", group: null, body}` to the room's
  `solids` (the player collides exactly as with a tile solid) and a StaticBody2D on
  layer 1 (enemies). A prop turning solid around the player waits until they have
  stepped out of it, so nobody is trapped.
- **Events:** touch when the player starts overlapping (touching an edge counts, so
  standing on it does); interact on Up / W while overlapping a prop with an interact
  handler (its prompt, or an arrow, shows above it meanwhile; the runtime state
  reports it as `prompt`); hit when the sword strikes it (each prop is a
  `player.targets` entry); destroyed when its health runs out, after which it is
  gone until the room is built again.
- Edit mode and the Rooms stage draw every prop, faded if it depends on the run.

Roles are recipes. `game/test/props.test.ts` plays each in the headless runtime:
a pickup (touch: giveItem + setFlag; visible while the flag is not set) gone for
good after re-entering, dying and Continue; a barrier that opens on interact while
holding an item; a switch in one room opening a barrier in another; a save spot
(interact: setCheckpoint, heal, saveRun, with onDeath "checkpoint"); a wall broken
by three hits that stays broken (destroyed: setFlag; visible while not set); and a
pickup that grants an ability.

Studio: with **▭ Prop** in Rooms, drag on empty space to draw a prop (8 px snap),
click to select, drag to move, drag the corner handle to resize (one edit each);
the sidebar edits the selected prop (name, rect, color or art, solid, visible,
health, bounce, prompt, handlers). Items are in the **Game** tab.

Art: **🎨 Draw props** (Rooms) picks a kit piece of the room's biome for each prop
without art, or paints the missing ones into the kit (`propArt`, see Scenery); a piece is
drawn fitted to the prop's rectangle (stretched at most 1.5x one way, else kept in shape,
standing at its bottom centre). **🎨 Draw icons** (Game tab) draws every item's icon from
one sheet (`itemArt`); in play the HUD shows the items held under the health pips (icon,
or a swatch of the item's color, and the count).

## Modals and the map

A **modal** (`world.modals`) is a screen over the game: a title, text, an optional
image (one already in the project) and up to 4 buttons, each a list of effects
(none = one "Continue"). Operations: `createModal`, `updateModal`, `deleteModal`
(refused, naming the places, while a handler or another modal's button shows it)
and `setMap` (`packages/core/src/modals/`).

- **Runtime** (`game/scripts/modal.gd`): `showModal` queues a modal; while one is
  open gameplay pauses (the room, doors and timers). Left / right (or up / down)
  choose a button, Enter / Space / Z press it (the mouse works too); its effects
  run, the modal closes, then the next queued one opens or play resumes once the
  keys are let go. `endGame {modal?}` shows the modal, then starts a fresh game from
  the same start (save cleared, gameStarted fires again).
- **Screens are data.** A title screen is a modal a gameStarted handler shows; an
  ending is `endGame` with a modal; credits are a modal another modal's button
  shows. There is no screen type in code.
- **The map** (`world.map.enabled`, off by default): M / Tab opens it over the paused
  game (`map_view.gd`): rooms the player visited plus those revealed by `revealMap`
  (default: all), at their world-map position, doors between them as lines, the
  current room highlighted. Revealed rooms are saved with the run.
- **Lint:** a modal nothing shows (info), a modal every button of which shows it
  again (it can never close), the map on with fewer than 2 rooms.
- **Studio:** the Game tab's **Modals** (edit, live **Preview** in the runtime,
  buttons' effects with the shared `EffectList`) and **Map** switch. **🎨 Illustrate**
  paints a modal's image from its title and text in the art direction (`modalArt`, one
  low-quality image, about $0.01); an image that reaches the runtime after its modal
  opened is shown as it arrives. Tests:
  `game/test/modals.test.ts` (headless, through `game/tests/modal_probe.gd`) and
  `e2e/modals.spec.ts`.

## Enemy combat primitives

Any enemy fights with the same behavior primitives (`behavior.ts`,
`game/primitives/actions/`); a hard fight is just an enemy that uses more of
them, and a "phase" is a set of states entered through `healthBelow`.

- **Attacks:** `strike` (a melee hitbox: width x height, offsetX ahead; windup,
  active, recovery; optional lunge), `shoot` (count projectiles in a fan, aimed at
  the player or at an angle from facing; speed, gravity, lifetime; they break on
  solids or the player; `pogo` ones bounce a downward strike), `leap` (lands where
  the player stood, up to maxDistance), `slam` (hop, crash down, a shockwave runs
  along the ground both ways: waveSpeed, waveReach, waveHeight; jump it; flyers
  drop), `summon` (`count` of another enemy beside itself, at most `max` alive),
  `teleport` (home, random within range, or past the player; untouchable while a
  marker shows where it will appear). Attack damage is per action; knockback is
  the enemy's `knockback` stat. Projectiles and shockwaves live in
  `game/scripts/combat/`.
- **Fair by construction:** every attack has a `windup` of at least 0.25 s
  (`MIN_WARNING`; the schema rejects less) in which it flashes its `color` like a
  telegraph (strikes also outline their hitbox, slams shake). `lintCombat`
  (`packages/core/src/combat/lint.ts`) flags the rest: a charge entered without a
  telegraph of at least 0.25 s, a behavior with no state the player can hit back in
  (`no_opening`), a leap / jump / teleport reaching further than a room it spawns in
  is wide, summons that summon (caps multiply) or name no enemy, and contact damage
  with knockback 0.
- **Armor** (enemy stat, 0..1, default 0) resists the push of sword hits.
- **Deaths** (`enemy.gd`): the killing hit makes it harmless at once (no touch, no
  attacks, no collision; `dead`, so the room, the HUD and the sword are done with
  it) and fires `killed` → enemyKilled / roomCleared in that same frame, as before.
  The body is thrown up and along the push, falls (flyers too) and plays its
  `death` clip, held on its last frame; without one (no art, or an older rig) a
  fallback: a white flash, a pop, a collapse that flattens and darkens it, and a
  particle burst (`fx.gd` `burst`). Then it lingers and fades (the character's
  optional `death {linger, fade}`, default 0.6 s and 0.4 s) and is gone (hidden, still
  listed with health 0). The body runs on room time, so hit-stops freeze it; a
  rebuilt room has no corpses. `game/test/death.test.ts`.
- **Difficulty by region** (`packages/core/src/combat/difficulty.ts`, the Architect's
  cast stage): a region's depth is its place in the progression (spheres, then
  connections from the start; the start is 0). An enemy as written is its depth-0
  self; where it spawns deeper, those spawns point at a variant `<id>_d<depth>`
  (`variantOf` the original: same look, art and behavior) with health ×(1 + 0.3·depth)
  rounded up (at most ×2.5), contact and attack damage ×(1 + 0.3·depth) rounded (at
  most ×2), and its own movement speed ×(1 + 0.05·depth) (at most ×1.2); windups,
  reach, knockback and projectiles stay, so `lintCombat` has nothing new to say.
  Summoned enemies follow their summoner's depth; enemyKilled handlers naming the
  original follow its variants. Variants are derived: each run folds them back first,
  so it is idempotent and edits to the original carry over; art drawn for the
  original is drawn for its variants; pinned rooms are left alone.
- **Health bars:** any spawn can show one (`spawn.healthBar {title}`,
  `setSpawnHealthBar`): a titled bar at the top of the screen while it lives in the
  current room, stacked in spawn order (runtime state `healthBars`).
- **Feedback effects** (`game/scripts/fx.gd`), from any handler: shake (camera),
  flash (a full-screen color above the HUD, below modals), hitStop (frames) and
  slowMotion. Slow motion skips physics frames (only `scale` of them run) instead of
  scaling time, so every step stays the fixed 1/60 s: headless runs are
  deterministic and movement still matches the model.
- **Studio:** Rooms → each enemy spawn → *Health bar & handlers* (e.g. on its
  enemyKilled: shake, slowMotion, setFlag). The Inspector edits the new params.
- **Tests:** `game/test/combat_primitives.test.ts` plays each primitive and three
  heavy enemies built from data only (`game/test/fixtures/combatShowcase.ts`): each
  attack hits a player who stands still, the intended dodge avoids it, and a scripted
  fight kills it in a stated time.

## Characters (art)

**Characters** mode makes a character's look with AI, in stages. The main area
shows the stage (stepper: Concepts / Rig / Animation) large, next to the *live*
rig on the runtime's stage; the sidebar holds the inputs and actions. The AI loops
within a stage on its own, and you pick between stages (or tick **Auto** to take
its picks all the way):

1. **Concepts**: a brief becomes a 2x2 concept sheet (cheap raster sketches,
   inspiration only). The AI marks its pick; click a design to choose it, or
   ask for **Variations** of the chosen one. Left-facing designs are mirrored.
2. **Rig**: the design becomes a *rig*, pure data on bones
   (`packages/core/src/art/rig.ts`), in one of two modes (pick **Vector** or
   **Cutout** in the sidebar; default: the art direction's `rigMode`, else vector):
   - **Vector**: a vision model traces the design as flat shapes (blobs,
     ellipses, tapered strokes), in the concept's own pixels over a grid.
   - **Cutout**: the design itself, cut into pieces (`packages/art/src/cutout.ts`).
     Code removes the flat background (estimated from the border, flooded in
     from the edges) and stores the character as a transparent PNG, the rig's
     `source`. The model only plans the skeleton and a *rough* region per part;
     code gives every opaque pixel to a part (inside its region, else the nearest
     one through the character's own pixels; stray bits join the part they touch)
     and traces each part's `image` polygon around its pixels (≤128 points). Each
     polygon reaches a few px past its pixels and, where it meets another bone's
     part, covers a disk about its pivot, so turning limbs open no gaps at joints.
     The rest pose is the design, pixel for pixel.

   Either way the pipeline renders each attempt in the real runtime and measures
   its **match** to the design (`match.ts`: silhouette overlap and color where both
   are drawn, 0-1); the critic scores and revises (3 rounds: vector shapes; or
   cutout pivots, regions and draw order, judged from the split and the bones
   bent ±25°). The attempt that looks most like the design is kept (the critic's
   score breaks ties) and its match is shown in the workbench. The **Onion**
   slider draws the design behind the live rig, aligned with the rig's frame;
   **Bones** shows the skeleton.
3. **Animation**: exactly the clips the character's characters need (core
   `wantedClipSlots`: idle, walk, run, windup, attack, hurt, death (every enemy;
   plays once and holds), jump, fall, fly, and
   for attacks a clip per phase: strike / shoot / leap / slam / cast, then
   recover), as keyframe tracks plus motion primitives (sway, bob, shift, pulse,
   squash, shake) (`clip.ts`), reviewed once from filmstrips. Pick a clip to play
   it on the stage; scrub the timeline, change the speed. Enemies pick a clip
   from their behavior's action and, for attacks, its phase: every attack
   primitive reports `phase` windup / active / recovery (entity state `phase`),
   so a strike plays windup → strike → recover (`ACTION_PHASE_SLOTS`, mirrored in
   `character_art.gd`).

One generic GDScript renderer (`game/scripts/art/rig_view.gd`) draws every
rig: ink outlines, shading, glow, hand-drawn line boil, bending between
bones; cutout parts are the source image drawn through their polygon (no
outline, fill or boil). The runtime gets the source like other images (the
studio's `images` message; `renderRig` carries it in `images`). The art
direction (style words, palette, outline) is project-wide.

Any vector part may also carry a **texture** (`texture {file, rect, uv, opacity}`: the image
region `uv` stretched over the rest-pose rectangle `rect`, drawn inside the part's shape over its
fill and under its outline and the parts in front; it moves, turns and scales with the bone, and
transparent texels show the flat fill), and a part may be **clipped** to another part on the same
bone(s) (`clipTo`: shading bands, highlights and patterns that never leave their part). A rig's
textures travel like a cutout's source (`rigFiles`: sent with `images`, bundled by the game
export); until one arrives its parts show their flat fill.

**Rig looks on trial** (`dressRig {look}` in `packages/art/src/dress.ts`, opt-in, no default flow
calls it; compared blind by `node scripts/rig-ab4.ts <round3> <out>` then
`node scripts/rig-ab4-page.ts <out>`): the same shapes, bones and clips, dressed from the design.
- *detail*: the vision model adds vector detail shapes per part (shading bands, highlights, folds,
  seams, patterns, small accessories), clipped to their part and drawn right above it, then reviews
  renders and fixes them (3 rounds, best score kept); never past `MAX_PARTS`.
- *projected*: each part shows the design's own pixels: the design lined up with the rig's
  silhouette, then each bone group by its outline and by its drawing (luminance correlation, so a
  recoloured design still lines up); hidden stretches keep the flat fill (retinted to the texture).
- *paintover*: the rest pose with its bone groups pulled apart (nothing overlaps) is painted over
  by one image edit in the design's style; the paint is lined up again per group and baked per part.
- *combo*: detail shapes over a paint-over of the detailed rig at 60% strength.
Textures are baked per part over its whole shape and packed into one atlas per character (≤512 px).

**Rig strategies on trial** (opt-in stage options, off by default; compared blind by
`node scripts/rig-ab3.ts <out>` then `node scripts/rig-ab3-page.ts <out>`):
- *Rig-ready concepts* (`concepts {rigReady}`, `choose {rigReady}`): the sheet asks for a neutral
  side pose with limbs apart, distinct colours for adjacent parts and the whole figure inside its
  cell; a transparent sheet gets a flat background; cells whose figure runs off the edge are never
  picked (one redraw when none fits); the chosen design keeps only its main figure
  (`isolateFigure`: neighbours leaking in, sparks and specks painted out).
- *Elbows and knees* (`rig {limbJoints}`, `animate {limbJoints, jointLimits}`): two bones per limb;
  joint limits count only the overlap around each joint (`motionLimits(rig, {joint})`), so a leg lying
  along the other leg isn't held to the minimum swing.
- *Flat redraw* (`redrawFlat`, one image edit): the chosen design redrawn as clean flat art before rigging.
- *Clean tracer* (`rig {cleanTrace, review}`, traced.ts `clean`): edge-preserving smoothing before the
  colours are reduced, small dark details and the plan's feature points kept, stray specks dropped,
  outlines fitted as smooth curves with sharp corners; the critic also compares the drawn rig with the
  design and adds feature points for lost details.
- *Puppet* (`rig {puppet}`, `puppet.ts`): one image edit draws the character's pieces apart on a parts
  sheet; each piece is traced and placed on the design's joints by two anchor points; parts without
  a usable piece are traced from the design.

Tests: `packages/art/test/rigStrategies.test.ts` (figure isolation, the clean tracer, puppet
assembly), `packages/art/test/cutout.test.ts` (background removal, pixel assignment,
both modes from one concept, the critique loops keep the best match),
`packages/server/test/cutoutRender.test.ts` (in the runtime: the rest pose
matches a drawn test creature, no gaps at joints turned ±30°),
`game/test/art_phases.test.ts` (heavy enemies play windup → strike → recover),
`packages/art/test/look.test.ts` (detail shapes, baking, the atlas, lining up, pulling apart),
`packages/server/test/rigRenderer.test.ts` (textures drawn inside the shape and turning with the
bone, clipped details, the flat fill until a texture arrives).

## Scenery

**Scenery** mode makes how places look. In the studio a biome is a **look** and each of its
rooms is a **dressing**; every dressing names the game room it dresses (Rooms shows it the
other way round), so "room" alone always means a game room. A **biome** (an art asset) is paid for once: a
painted backdrop made seamless, a 3x3 sheet of large structures and one of props
(transparent, sliced and labelled automatically) and a ground texture (about
$0.017 at **draft** quality; **final** spends more on the backdrop and pieces,
about $0.035-0.05). A **room** is cheap data composed from the kit (about $0.004,
including its review):
placements on five parallax layers (far, mid, back, play, front), palette, fog,
lights, light shafts and dust. The runtime adds the depth for free
(`game/scripts/art/world_view.gd`): distant layers washed into the fog, 2D lights
with halos, fog between layers, dust, foreground silhouettes that fade when the
player is behind them.

- **Workbench:** the live room full size (drag to pan, wheel to zoom; click a
  piece to select it, drag it to move it: saved as an undoable edit; a dropped
  piece comes to rest on the surface under it, hold Alt to place it freely), a layer bar
  (show/hide layers, fog, lights, an **Exploded** view that tilts the layers
  apart), and the kit shelf (click a piece to place it in the view). The sidebar
  paints kits, repaints one part (or the whole kit at the other quality; the
  biome's rooms are recomposed to fit new pieces), composes rooms, edits the
  room's atmosphere and the selected piece.
- **Snapping** (`packages/core/src/art/worldSnap.ts`): standing pieces rest on
  the surface under them, hanging ones on the ceiling or a ledge's underside,
  and *spans* (beams, lintels, logs: a piece kind of their own) across two
  supports: structures in their layer, ledges, or walls they're set into.
  Projects saved before snapping (schema < 4) get pieces that sit wholly
  outside their room snapped back in when loaded; the rest stay put.
- **Look and fix:** a composed room's pieces are snapped, then the room is rendered with each
  piece's id written on it and the vision model scores it and names small edits
  (move, rescale, re-layer, remove, add), which are snapped again. Both renders
  are in the job log. A fix that scores worse is undone with more rounds
  (`roomRounds`, default 1).
- **Dressing rooms:** a biome room *dresses* a world room (`room.dressing`; new art
  dresses the playtest room while it is plain): Play happens inside it, with the
  room's own tiles textured and nothing drawn outside its walls (breakable ones keep their
  cracked look; smashing one also clears the pieces and lights standing on it). Rooms never change
  collision; **Suggest layout** stores new platforms on the room, which you can
  preview and accept (`applyRoomLayout`, one undo step).
- **Every room around its own tiles:** composing with `dressRoom` composes for that
  world room's grid and doors (and names the biome room after it); recomposing a biome
  room (`roomId`) composes it around the world room it dresses *now* and records the
  tiles again (`dressing.tiles`, `roomFingerprint`), so lint and the game-art plan stop
  calling it out of date. A biome room dressing several world rooms isn't reshaped for
  one of them: the one whose tiles changed gets a room of its own. **↻** next to a room
  whose world room's tiles changed recomposes it.
- **Doors and passages stay readable** (`clearPassages` in `worldSnap.ts`, after
  snapping and again after the review): nothing in the play or front layer, and no big
  back-layer piece, may cover a door's opening or the 4 tiles in front of it (parallax
  layers are checked where they are seen with the camera at the door); offenders are
  pushed away along x and snapped again, or dropped. A hanging play piece must leave 3
  tiles above the surface under it (it is shortened, or dropped). The job log says what
  moved; the compose and review prompts name the door openings.
- **Region biomes:** the game-art plan (`gameArtPlan`) paints one biome per room group
  (progression region, else the whole world) with `worldKit` from the region's name, wiki
  summary and the art direction; it needs no world room, and the group's rooms are then
  composed with it one by one (`worldCompose` with `dressRoom`).
- **Props** (`propArt`, about $0.002, plus about $0.005 when pieces are painted): one
  text call gets each prop without art as data (name, size, color, solid/visible,
  handlers in one line each, items they name) and the kit's pieces, and picks a piece
  for each, or describes one to paint. Those are painted on one small transparent sheet
  (2x2 or 3x3, cut like the kit's), added to the kit as `prop_*` pieces (kept when the
  kit's sheets are repainted) and set as the props' `art`. A cell that comes back empty
  is painted again on its own. Item icons (`itemArt`) are cut from a sheet the same way.
- **Chat:** the build assistant can queue `generateCharacterArt`,
  `generateWorld` and `composeWorldRoom`; they start after its turn, each saved
  as its own AI change, and its reply lists them as "queued: ...". It can also
  edit rooms and placements directly.

## Art jobs, settings and storage

- **Models:** images are painted by `openai/gpt-image-1-mini` (low quality) on
  OpenRouter. Everything else (picks, facing checks, rigs, critiques, clips, kit
  labels, room composing and reviews) is the *vision model*, which by default
  runs on your local Claude Code login with `claude-opus-5-5`, like the chat
  agents (`packages/server/src/art/claudeCodeVision.ts`): one Claude Code turn
  per call with only the stage's system prompt and one user message (images as
  base64 image blocks), no tools, MCP, settings or session file. Those calls
  cost nothing beyond the subscription (shown as $0); the studio's art header
  shows `claude-code/<model>`. As with chat, this is for personal local use.
- **Cost:** with the defaults only images cost money: about $0.003 per
  character (concept sheet) and $0.06 per draft biome kit (measured
  2026-11-17). Vision on OpenRouter (`anthropic/claude-haiku-5.5`) adds about
  $0.01 per character. On Claude Code a call takes about 2 s of overhead plus
  the model's time (a rig build or review about 20 s, a room review about
  10 s, a whole character concept-to-animated about 2.5 min); calls the
  pipeline makes in parallel run in parallel, each in its own Claude Code
  process, and count against the subscription's usage limits. Each job has a budget
  (`STUDIO_ART_BUDGET`, default $0.25) and the sidebars show what was spent.
- **Settings** (`.env`): `OPENROUTER_API_KEY` (required, for images),
  `STUDIO_ART_IMAGE_MODEL`, `STUDIO_ART_IMAGE_QUALITY`,
  `STUDIO_ART_VISION_BACKEND` (`claude-code` or `openrouter`; default
  `claude-code`, but `openrouter` when `STUDIO_CHAT_BACKEND=fake` or
  `STUDIO_ART_VISION_MODEL` is an OpenRouter id like `anthropic/claude-haiku-5.5`),
  `STUDIO_ART_VISION_MODEL` (default `claude-opus-5-5` on Claude Code,
  `anthropic/claude-haiku-5.5` on OpenRouter), `STUDIO_ART_VISION_EFFORT`
  (Claude Code only: `low`..`max`), `STUDIO_ART_BUDGET`;
  `STUDIO_ART_BACKEND=fake` uses scripted models (e2e).
- **Background work:** art jobs hold no lock: the creator keeps editing and
  chatting while one runs. One job runs at a time; a job started meanwhile
  (from a workbench, a chat turn or the live cast) queues behind it. Each
  finished stage is saved onto the project as it is then (its operations applied
  again); a stage whose changes no longer apply (its character was deleted)
  fails the job cleanly. Saves wait while a playtest or an AI turn runs. The
  Architect's game-art job is the exception: it runs inside the Architect's run
  and stops a background job in its way (it draws whatever is missing).
- **Storage:** images live in `<project>/files/` under content hashes; the
  project only references them, so undo is exact. Each finished stage is one
  AI change (one undo step). The job log is `<project>/art-jobs.jsonl`.
- **API:** `POST /api/art/jobs {stage, characterId? | biomeId?, brief?, feedback?, ...}`
  (character stages `concepts`, `choose`, `rig`, `animate`, `auto`; world
  stages `worldKit`, `worldCompose`, `worldRepaint`; game stages `propArt {worldRoomId}`,
  `modalArt {modalId}`, `itemArt`), `GET /api/art`,
  `POST /api/art/cancel`, `GET /api/files/<ref>`.
- **Rendering** for critics and kit slicing runs the web export in headless
  Chromium (`packages/server/src/art/renderer.ts`); `node scripts/render-rig.ts out.png`
  renders the example rig, `node scripts/screenshot-mode.ts <url> <Mode> <out>`
  screenshots a studio mode.
- **Extending:** assets share one store and job runner and differ by kind
  (`asset.ts`): characters are rigs, biomes are kits + rooms; props and tiles are
  meant to plug in the same way.
