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
  edit is rejected (`stale_revision`) instead of silently overwriting.
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
    jump, hover. Conditions: playerWithin, playerBeyond, after, hitWall,
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
- **Geometry is tiles.** Rooms (and the arena) are grids of 32 px tiles
  (`packages/core/src/world/tiles.ts`): `.` empty, `#` solid, `=` ledge
  (thin and solid; thickness is one per-game setting, `world.ledgeThickness`),
  `-` one-way (jump up through it), `^` hazard, `%` breakable (a ground pound
  smashes the whole connected area). Collision rectangles are derived from
  the grid (`gridToSolids`) and sent to the runtime with the project
  (`toRuntimeProject`), never stored. The game's rooms, doors and rules live
  in `project.world` (`world/world.ts`).
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
    arena (`sandbox.playerAbilities`) for now, from the game later.
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
| `addSpawn` / `moveSpawn` / `removeSpawn` | Place, move, remove instances (spawns have stable ids like `charger_1`) |
| `createWorldRoom` / `updateWorldRoom` / `resizeWorldRoom` / `deleteWorldRoom` | Game-world rooms (`world/operations.ts`); deleting one unlinks doors to it |
| `paintTiles` | Fill a rectangle or a list of cells of a room's (or the arena's) grid with one tile kind |
| `setDoor` / `removeDoor` / `connectDoors` | Door openings and their links (right <-> left, bottom <-> top) |
| `addRoomSpawn` / `moveRoomSpawn` / `removeRoomSpawn` | Enemies in rooms |
| `setWorldStart` / `setGameRules` / `setLedgeThickness` | Where the game begins, death/saving/hazard rules, ledge thickness |

`POST /api/batch` applies several operations atomically, as one revision and
one undo step; if any step fails nothing changes and the error names the step:

```sh
curl -s -H "$H" -X POST localhost:5173/api/batch -H 'content-type: application/json' -d '{
  "baseRevision": 3, "author": "ai", "operations": [
    { "name": "duplicateCharacter", "input": { "characterId": "charger", "newId": "fast_charger" } },
    { "name": "updateBehavior", "input": { "characterId": "fast_charger", "stateId": "charge", "action": { "speed": 800 } } },
    { "name": "addSpawn", "input": { "characterId": "fast_charger", "x": 1000, "y": 660 } } ] }'
```

In the browser console, `window.studio` exposes the same operations plus
runtime control: `studio.updateCharacter(...)`, `studio.applyOperation(name, input)`,
`studio.applyBatch([...])`, `studio.undo()`,
`studio.play()`, `studio.stop()`, `await studio.getRuntimeState()`.

## Chat

The chat panel (right) follows the tab: on **Arena** it is the build
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
  The wiki is not sent to the game runtime. Later, the **Architect** agent
  will build the game from it.

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

The toolbar switches modes in one window: **Arena** (play and tune), **Characters**
and **Worlds** (art workbenches), **Rooms** (the game world), **Wiki** and **Progression** (design documents,
with the director's chat). The game runtime stays mounted the whole time; modes
only move it between named grid areas and send it a `stage` message (the arena,
one character, a biome room or a game-world room). The sidebar resizes from its left edge and the
chat collapses to a strip (both remembered per browser); the stage has a
full-screen button. Leaving the mode a playtest runs in stops it; Play returns to the arena.

## Rooms (the game world)

**Rooms** mode edits `project.world`: a world map of the rooms (by `at`, with
lines for connected doors), the selected room live in the runtime (stage
`room`) with a tile painter over it (pick a kind, click or drag: one stroke is
one undoable `paintTiles`), doors (add, connect, disconnect), enemy spawns, the
start and the rules. **📍 Spot** marks a point for **Set start here**, **+ Enemy at
spot** and **▶ Play from here** (with the chosen abilities); **▶ From start** and
**Continue** (the run saved in this browser) play from the world's start.

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

## Characters (art)

**Characters** mode makes a character's look with AI, in stages. The main area
shows the stage (stepper: Concepts / Rig / Animation) large, next to the *live*
rig on the runtime's stage; the sidebar holds the inputs and actions. The AI loops
within a stage on its own, and you pick between stages (or tick **Auto** to take
its picks all the way):

1. **Concepts**: a brief becomes a 2x2 concept sheet (cheap raster sketches,
   inspiration only). The AI marks its pick; click a design to choose it, or
   ask for **Variations** of the chosen one. Left-facing designs are mirrored.
2. **Rig**: a vision model traces the design as a *rig*: flat shapes
   (blobs, ellipses, tapered strokes) on bones, pure data
   (`packages/core/src/art/rig.ts`). It works in the concept's own pixels over
   a grid; the pipeline renders the rig in the real runtime, lays it over the
   concept, and lets the critic score and fix it (3 rounds, best kept). The
   workbench's **Onion** slider draws the design behind the live rig, aligned
   with the frame the rig was traced in; **Bones** shows the skeleton.
3. **Animation**: clips per slot (idle, walk, run, windup, attack, hurt,
   jump, fall, fly) as keyframe tracks plus motion primitives (sway, bob,
   shift, pulse, squash, shake) (`clip.ts`), reviewed once from filmstrips.
   Pick a clip to play it on the stage; scrub the timeline, change the speed.
   Enemies pick a clip from their behavior's action.

One generic GDScript renderer (`game/scripts/art/rig_view.gd`) draws every
rig: ink outlines, shading, glow, hand-drawn line boil, bending between
bones. The art direction (style words, palette, outline) is project-wide.

## Worlds

**Worlds** mode makes places. A **biome** (an art asset) is paid for once: a
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
- **The arena:** a room *dresses* the arena (`sandbox.dressing`): Play happens
  inside it, with the arena's own platforms textured (breakable ones keep their
  cracked look; smashing one also clears the pieces and lights standing on it). Rooms never change
  collision; **Suggest layout** stores new platforms on the room, which you can
  preview and accept (`applyRoomLayout`, one undo step).
- **Chat:** the build assistant can queue `generateCharacterArt`,
  `generateWorld` and `composeWorldRoom`; they start after its turn, each saved
  as its own AI change, and its reply lists them as "queued: ...". It can also
  edit rooms and placements directly.

## Art jobs, settings and storage

- **Cost:** about $0.015-0.02 per character and $0.017 per draft biome with the
  defaults (`openai/gpt-image-1-mini` at low quality for images,
  `anthropic/claude-haiku-5.5` for everything else). Each job has a budget
  (`STUDIO_ART_BUDGET`, default $0.25) and the sidebars show what was spent.
- **Settings** (`.env`): `OPENROUTER_API_KEY` (required),
  `STUDIO_ART_IMAGE_MODEL`, `STUDIO_ART_IMAGE_QUALITY`,
  `STUDIO_ART_VISION_MODEL`, `STUDIO_ART_BUDGET`; `STUDIO_ART_BACKEND=fake`
  uses scripted models (e2e).
- **Storage:** images live in `<project>/files/` under content hashes; the
  project only references them, so undo is exact. Each finished stage is one
  AI change (one undo step). The job log is `<project>/art-jobs.jsonl`.
- **API:** `POST /api/art/jobs {stage, characterId? | biomeId?, brief?, feedback?, ...}`
  (character stages `concepts`, `choose`, `rig`, `animate`, `auto`; world
  stages `worldKit`, `worldCompose`, `worldRepaint`), `GET /api/art`,
  `POST /api/art/cancel`, `GET /api/files/<ref>`.
- **Rendering** for critics and kit slicing runs the web export in headless
  Chromium (`packages/server/src/art/renderer.ts`); `node scripts/render-rig.ts out.png`
  renders the example rig, `node scripts/screenshot-mode.ts <url> <Mode> <out>`
  screenshots a studio mode.
- **Extending:** assets share one store and job runner and differ by kind
  (`asset.ts`): characters are rigs, biomes are kits + rooms; props and tiles are
  meant to plug in the same way.
