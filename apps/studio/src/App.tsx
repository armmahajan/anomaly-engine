import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { gridSize, newEnemyCharacter, progressionReport, snapPlacement, uniqueId, worldSceneFor, type ChangeResult, type WorldStart } from "@anomaly/core";
import type { Session } from "./session.ts";
import { Inspector } from "./Inspector.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { WikiMain, WikiSidebar, type WikiNav } from "./WikiView.tsx";
import { ProgressionMain, ProgressionSidebar, type ProgressionNav } from "./ProgressionView.tsx";
import { ArchitectMain, ArchitectSidebar } from "./architect/ArchitectView.tsx";
import { ArtPanel } from "./ArtPanel.tsx";
import { CharacterBench, NoCharacterBench } from "./CharacterBench.tsx";
import { currentWorld, WorldBench, type WorldUi } from "./WorldBench.tsx";
import { WorldPanel } from "./WorldPanel.tsx";
import { GamePanel, GameSettings } from "./GameView.tsx";
import { initialRoomsUi, RoomPainter, RoomsBench, RoomsPanel, type RoomsUi } from "./RoomsView.tsx";
import { load, save, useChatOpen, useSidebarWidth } from "./layout.ts";
import { LiveStatus } from "./LiveStatus.tsx";
import { ConfirmHost, askConfirm } from "./ui/confirm.tsx";
import { SidePanel } from "./ui/SidePanel.tsx";
import { CharacterList } from "./CharacterList.tsx";
import { ProjectMenu } from "./shell/ProjectMenu.tsx";
import { ExportGameDialog } from "./shell/ExportGame.tsx";
import { StudioTabs, type TabGroup } from "./shell/StudioTabs.tsx";
import { PlayControls } from "./shell/PlayControls.tsx";
import { SaveStatus } from "./shell/SaveStatus.tsx";
import "./shell.css";

/** Studio modes. Each puts its own workbench in the main area; the game runtime stays mounted throughout. */
type Tab = "playtest" | "characters" | "worlds" | "rooms" | "game" | "wiki" | "progression" | "architect";
const TAB_LABEL: Record<Tab, string> = { playtest: "Playtest", characters: "Characters", worlds: "Scenery", rooms: "Rooms", game: "Game", wiki: "Wiki", progression: "Progression", architect: "Architect" };
/** The tabs in the creator's order: design the game, build it, play it. */
const TAB_GROUPS: readonly TabGroup<Tab>[] = [
  { label: "Design", tabs: ["wiki", "progression", "architect"] },
  { label: "Build", tabs: ["rooms", "worlds", "characters", "game"] },
  { label: "Play", tabs: ["playtest"] },
];
/** Each tab's tooltip: what it is for. */
const TAB_HINT: Partial<Record<Tab, string>> = {
  wiki: "The game's story, characters, places and lore",
  progression: "Regions, abilities, how they connect and the story beats",
  architect: "Turns the progression into a world of rooms and proves it can be finished",
  rooms: "The game's rooms: tiles, doors, enemies, props and rules",
  worlds: "How rooms look: each look's pieces, backdrops and atmosphere, and the rooms it dresses",
  characters: "Characters' art, rigs and animation",
  game: "The whole game: check it, its art, rules, map and screens",
  playtest: "Play the playtest room and tune characters while you play",
};
/** Design documents (the director's tabs): the game is hidden and the chat is the director's. */
const DESIGN_TABS: readonly Tab[] = ["wiki", "progression"];
/** Tabs that show a document instead of the game. */
const DOCUMENT_TABS: readonly Tab[] = [...DESIGN_TABS, "architect"];

const ENEMY_COLORS = ["#5f9e6e", "#d08c3a", "#4f8fbf", "#b8577d", "#9c9a3f"];

export function App({ session }: { session: Session }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>("crawler");
  // The studio reopens on the tab it was left on (per browser).
  const [tab, setTab] = useState<Tab>(() => {
    const saved = load<string>("anomaly.tab", "playtest");
    return Object.hasOwn(TAB_LABEL, saved) ? (saved as Tab) : "playtest";
  });
  useEffect(() => save("anomaly.tab", tab), [tab]);
  const [wikiNav, setWikiNav] = useState<WikiNav>({ pageId: null, editing: null });
  const [progressionNav, setProgressionNav] = useState<ProgressionNav>({ selected: null, creating: null });
  const [sidebarWidth, startResize, setSidebarWidth] = useSidebarWidth();
  const sideResize = { width: sidebarWidth, startResize, setWidth: setSidebarWidth };
  const [characterQuery, setCharacterQuery] = useState("");
  const [exporting, setExporting] = useState(false);
  const [chatOpen, setChatOpen] = useChatOpen();
  const [worldUi, setWorldUi] = useState<WorldUi>({
    biomeId: null,
    roomId: null,
    hidden: [],
    fog: true,
    lights: true,
    exploded: false,
    previewLayout: false,
  });
  const [worldSelected, setWorldSelected] = useState<string | null>(null);
  const [roomsUi, setRoomsUi] = useState<RoomsUi>(initialRoomsUi);
  // A click on a piece in the runtime selects it here; another room means nothing is selected.
  useEffect(() => setWorldSelected(state.worldPick), [state.worldPick]);
  const shownRoom = currentWorld(state.project, worldUi);
  const shownRoomKey = `${shownRoom.biome?.id}/${shownRoom.room?.id}`;
  useEffect(() => setWorldSelected(null), [shownRoomKey]);

  useEffect(() => session.attachRuntime(frameRef.current!), [session]);

  // Ctrl/Cmd+Z undoes project changes (text fields keep their native undo).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      if (session.getState().canUndo) void session.undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [session]);

  const playing = state.mode === "play";
  const aiBusy = Object.values(state.chats).some((c) => c.running !== null);
  const locked = playing || aiBusy;
  const { project } = state;
  // The chosen character, else the player (or the first): something is always selected while there is anything.
  const selected = project.characters.find((c) => c.id === selectedId) ?? project.characters.find((c) => c.kind === "player") ?? project.characters[0] ?? null;
  const characterIds = project.characters.map((c) => c.id);
  const { playtest } = project.world;
  const testRoom = project.world.rooms.find((r) => r.id === playtest?.room) ?? null;
  /** Where new things appear: the playtest room's centre, on the player's floor. */
  const defaultSpawn = testRoom && playtest ? { x: Math.round(gridSize(testRoom.grid).width / 2), y: playtest.y } : null;
  /** The playtest room's shape: the stage hugs it in Playtest and Game, with the panel under it (content.css). */
  const roomAspect = testRoom ? gridSize(testRoom.grid).width / gridSize(testRoom.grid).height : 16 / 9;
  const spawnHere = (characterId: string, at: { x: number; y: number } | null) =>
    testRoom && at ? [{ name: "addRoomSpawn", input: { roomId: testRoom.id, characterId, ...at } }] : [];

  const report = (result: ChangeResult) => {
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };

  // Each action is one batch: one revision, one undo step.
  const addEnemy = async () => {
    const id = uniqueId("enemy", characterIds);
    const name = id === "enemy" ? "Enemy" : `Enemy ${id.split("_").pop()}`;
    const color = ENEMY_COLORS[project.characters.length % ENEMY_COLORS.length];
    const ok = report(
      await session.applyBatch([
        { name: "createCharacter", input: { character: newEnemyCharacter(id, name, color) } },
        ...spawnHere(id, defaultSpawn),
      ]),
    );
    if (ok) setSelectedId(id);
  };

  const duplicateSelected = async () => {
    if (!selected) return;
    const newId = uniqueId(`${selected.id}_copy`, characterIds);
    const source = testRoom?.spawns.find((s) => s.characterId === selected.id) ?? defaultSpawn;
    const ok = report(
      await session.applyBatch([
        { name: "duplicateCharacter", input: { characterId: selected.id, newId } },
        ...spawnHere(newId, source && { x: source.x + 80, y: source.y }),
      ]),
    );
    if (ok) setSelectedId(newId);
  };

  const deleteSelected = async () => {
    if (!selected) return;
    const spawnCount = project.world.rooms.flatMap((r) => r.spawns).filter((s) => s.characterId === selected.id).length;
    const ok = await askConfirm({
      title: `Delete ${selected.name}?`,
      message: spawnCount === 0 ? "Undo can restore it." : `${spawnCount === 1 ? "Its spawn goes" : `Its ${spawnCount} spawns go`} with it. Undo can restore them.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    if (report(await session.applyOperation("deleteCharacter", { characterId: selected.id }))) setSelectedId("player");
  };

  const loadExample = async () => {
    if (report(await session.resetProject("example"))) setSelectedId("player");
  };

  const resetProject = async () => {
    if (report(await session.resetProject())) setSelectedId("crawler");
  };

  const startBlank = async () => {
    if (report(await session.resetProject("blank"))) setSelectedId("player");
  };

  const renameProject = async (name: string) => report(await session.applyOperation("renameProject", { name }));

  /** The playtest room plays in Playtest mode and the world in Rooms mode: opening another mode ends a playtest. */
  const openTab = (next: Tab) => {
    if (next !== tab && playing) session.stop();
    setTab(next);
  };

  // Tell the runtime what to show for this mode (workbenches drive their own stage).
  useEffect(() => {
    if (tab === "playtest" || tab === "game" || tab === "wiki") session.setStage({ mode: "game" });
  }, [session, tab, state.runtimeStatus]);

  // While playing the world, the Rooms sidebar follows the player from room to room.
  useEffect(() => {
    if (playing && state.room) setRoomsUi((ui) => (ui.roomId === state.room ? ui : { ...ui, roomId: state.room, spot: null }));
  }, [playing, state.room]);

  const openWikiPage = (pageId: string) => {
    setWikiNav({ pageId, editing: null });
    openTab("wiki");
  };

  /** Scenery <-> Rooms: a game room in Rooms, or a look and dressing (and the room to dress) in Scenery. */
  const openGameRoom = (roomId: string) => {
    setRoomsUi((ui) => ({ ...ui, roomId, spot: null, propId: null }));
    openTab("rooms");
  };
  const openScenery = ({ lookId, dressingId, room }: { lookId: string | null; dressingId: string | null; room: string }) => {
    setWorldUi((ui) => ({ ...ui, biomeId: lookId, roomId: dressingId, previewLayout: false, target: room }));
    openTab("worlds");
  };

  const openCharacter = (characterId: string) => {
    setSelectedId(characterId);
    setTab("playtest");
  };

  /** Kit shelf click: put the piece in the middle of the current view, standing on the surface there. */
  const placePiece = async (pieceId: string) => {
    const { biome, room } = currentWorld(project, worldUi);
    if (!biome || !room) return;
    const scene = worldSceneFor(project, biome.id, room.id, worldUi.previewLayout && room.layout !== null);
    if (!scene) return;
    const x = Math.round(state.worldCameraX ?? scene.width / 2);
    const piece = scene.pieces.find((p) => p.id === pieceId);
    // Dropped from the middle of the view's height: standing pieces fall onto the surface below, hanging ones rise.
    const dropped = { piece: pieceId, layer: "play" as const, x, y: scene.height / 2, scale: 1, flip: false };
    const placement = snapPlacement(dropped, piece, scene, { placements: scene.placements, pieces: scene.pieces }).placement;
    const result = await session.applyOperation("addPlacement", { assetId: biome.id, roomId: room.id, placement });
    if (!result.ok) session.reportProblem(result.error.message);
  };

  const progression = project.progression;
  const drafts: Record<Tab, number> = {
    playtest: 0,
    characters: 0,
    worlds: 0,
    rooms: 0,
    game: 0,
    wiki: project.wiki.pages.filter((p) => p.status === "draft").length,
    progression: [...progression.regions, ...progression.abilities, ...progression.connections, ...progression.beats].filter((i) => i.status === "draft").length,
    architect: 0,
  };
  const checks = tab === "progression" ? progressionReport(project) : null;
  const design = DESIGN_TABS.includes(tab);
  const documentTab = DOCUMENT_TABS.includes(tab);
  const agent = design ? "narrative" : tab === "architect" ? "architect" : "build";
  const problem = state.lastProblem && (
    <div className="problem" role="alert">
      {state.lastProblem}
      <button type="button" onClick={() => session.dismissProblem()}>
        dismiss
      </button>
    </div>
  );

  const onPlay = async (seed?: number) => {
    setTab("playtest");
    if (await session.play(seed)) {
      frameRef.current?.focus();
      frameRef.current?.contentWindow?.focus();
    }
  };

  const onPlayWorld = async (start: WorldStart) => {
    if (await session.play(undefined, start)) {
      frameRef.current?.focus();
      frameRef.current?.contentWindow?.focus();
    }
  };

  const openRoom = (roomId: string) => {
    setRoomsUi((ui) => ({ ...ui, roomId, spot: null, propId: null }));
    openTab("rooms");
  };

  return (
    <div
      className={`studio mode-${tab}${chatOpen ? "" : " chat-closed"}${playing ? " playing" : ""}`}
      style={{ "--side-w": `${sidebarWidth}px`, "--room-aspect": roomAspect } as React.CSSProperties}
    >
      <header className="toolbar">
        <ProjectMenu
          name={project.name}
          locked={locked}
          onRename={renameProject}
          onExample={() => void loadExample()}
          onReset={() => void resetProject()}
          onBlank={() => void startBlank()}
          onExport={() => setExporting(true)}
        />
        <StudioTabs groups={TAB_GROUPS} labels={TAB_LABEL} hints={TAB_HINT} counts={drafts} countHint="Drafts awaiting your review" active={tab} onOpen={openTab} />
        <div className="toolbar-end">
          <PlayControls
            project={project}
            playing={playing}
            canPlay={session.canPlay()}
            seed={state.seed}
            status={aiBusy ? "AI is editing…" : statusText(state.runtimeStatus, state.mode)}
            statusClass={aiBusy ? "status-busy" : `status-${state.runtimeStatus} status-${state.mode}`}
            onPlay={(seed) => void onPlay(seed)}
            onStop={session.stop}
            onPlayFromStart={(start) => {
              openTab("rooms");
              void onPlayWorld(start);
            }}
            onOpenRoom={openRoom}
          />
          <button type="button" onClick={() => void session.undo()} disabled={locked || !state.canUndo} title="Undo (Ctrl/Cmd+Z)">
            ↶ Undo
          </button>
          <LiveStatus project={project} art={state.art} live={state.live} session={session} />
          <SaveStatus connected={state.serverConnected} revision={project.revision} />
        </div>
      </header>
      <ConfirmHost />
      {exporting && <ExportGameDialog project={project} onClose={() => setExporting(false)} />}

      {/* The game stays mounted (and sized) in every mode so it never reboots; modes only move it. */}
      <main className={`viewport${documentTab ? " offstage" : ""}`} aria-hidden={documentTab}>
        {/* No browser menu on right click over the game: right click can be a game action (alt attack). */}
        <iframe ref={frameRef} src="/game/index.html" title="Game" className="game-frame" onLoad={(e) => e.currentTarget.contentDocument?.addEventListener("contextmenu", noMenu)} />
        {tab === "playtest" && !playing && state.runtimeStatus === "ready" && (
          <div className="edit-badge" data-testid="edit-badge">
            Editing <b>{testRoom?.name ?? "the playtest room"}</b> · ▶ Play to try it
          </div>
        )}
        {tab === "rooms" && !playing && state.runtimeStatus === "ready" && (
          <RoomPainter project={project} session={session} ui={roomsUi} setUi={setRoomsUi} locked={locked} />
        )}
        <button
          type="button"
          className="fullscreen-button"
          title="Full screen"
          aria-label="Full screen"
          onClick={() => void frameRef.current?.requestFullscreen?.()}
        >
          ⛶
        </button>
      </main>
      {/* Under the stage (Playtest, Game): the selected character's inspector, the game's settings. */}
      {tab === "playtest" && selected && (
        <section className="stage-dock" data-testid="stage-dock">
          <Inspector
            key={selected.id}
            character={selected}
            roomId={testRoom?.id ?? null}
            spawns={testRoom?.spawns.filter((s) => s.characterId === selected.id) ?? []}
            defaultSpawn={defaultSpawn}
            session={session}
            locked={locked}
            lockHint={aiBusy ? "The AI is editing. Wait for it or cancel." : "Stop the playtest to edit."}
            wikiPageId={project.wiki.pages.find((p) => p.characterId === selected.id)?.id}
            playtest={playtest}
            onOpenWiki={openWikiPage}
          />
        </section>
      )}
      {tab === "game" && (
        <section className="stage-dock" data-testid="stage-dock">
          <GameSettings project={project} session={session} locked={locked} onOpenWiki={openWikiPage} />
        </section>
      )}
      {tab === "characters" &&
        (selected ? (
          <CharacterBench key={`${selected.id}:${state.runtimeStatus}`} character={selected} project={project} art={state.art} session={session} locked={locked} />
        ) : (
          <NoCharacterBench />
        ))}
      {tab === "worlds" && (
        <WorldBench
          project={project}
          session={session}
          ui={worldUi}
          setUi={setWorldUi}
          selected={worldSelected}
          locked={locked}
          onPlacePiece={(pieceId) => void placePiece(pieceId)}
          onOpenRoom={openGameRoom}
        />
      )}
      {tab === "rooms" && (
        <RoomsBench
          project={project}
          session={session}
          ui={roomsUi}
          setUi={setRoomsUi}
          playing={playing}
          ready={session.canPlay()}
          onPlay={(start) => void onPlayWorld(start)}
        />
      )}
      {tab === "wiki" && (
        <main className="wiki-pane">
          <WikiMain project={project} session={session} nav={wikiNav} setNav={setWikiNav} locked={locked} onOpenCharacter={openCharacter} />
        </main>
      )}
      {checks && (
        <main className="wiki-pane">
          <ProgressionMain
            project={project}
            report={checks}
            session={session}
            nav={progressionNav}
            setNav={setProgressionNav}
            locked={locked}
            onOpenWiki={openWikiPage}
          />
        </main>
      )}

      {tab === "architect" && (
        <main className="wiki-pane architect-pane">
          <ArchitectMain
            project={project}
            architect={state.architect}
            session={session}
            locked={locked}
            onOpenRoom={(id) => {
              setRoomsUi((ui) => ({ ...ui, roomId: id, spot: null, propId: null }));
              openTab("rooms");
            }}
          />
        </main>
      )}

      {tab === "architect" ? (
        <SidePanel label="Architect" resize={sideResize} footer={problem}>
          <ArchitectSidebar project={project} architect={state.architect} session={session} locked={locked} live={state.live} />
        </SidePanel>
      ) : tab === "wiki" ? (
        <SidePanel label="Wiki pages" resize={sideResize} footer={problem}>
          <WikiSidebar project={project} session={session} nav={wikiNav} setNav={setWikiNav} locked={locked} />
        </SidePanel>
      ) : tab === "worlds" ? (
        <SidePanel label="Scenery" resize={sideResize} footer={problem}>
          <WorldPanel
            project={project}
            art={state.art}
            session={session}
            ui={worldUi}
            setUi={setWorldUi}
            selected={worldSelected}
            setSelected={setWorldSelected}
            locked={locked}
            onOpenRoom={openGameRoom}
          />
        </SidePanel>
      ) : tab === "rooms" ? (
        <SidePanel label="Rooms" resize={sideResize} footer={problem}>
          <RoomsPanel project={project} session={session} ui={roomsUi} setUi={setRoomsUi} locked={locked} live={state.live} onOpenScenery={openScenery} />
        </SidePanel>
      ) : tab === "game" ? (
        <SidePanel label="Game" resize={sideResize} footer={problem}>
          <GamePanel project={project} session={session} art={state.art} locked={locked} />
        </SidePanel>
      ) : checks ? (
        <SidePanel label="Progression" resize={sideResize} footer={problem}>
          <ProgressionSidebar project={project} session={session} report={checks} nav={progressionNav} setNav={setProgressionNav} locked={locked} />
        </SidePanel>
      ) : (
      <SidePanel label="Characters" resize={sideResize} footer={problem}>
        <CharacterList
          project={project}
          art={state.art}
          live={state.live}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          query={characterQuery}
          setQuery={setCharacterQuery}
          actions={
            <div className="list-actions">
              <button type="button" onClick={() => void addEnemy()} disabled={locked}>
                + Enemy
              </button>
              <button
                type="button"
                onClick={() => void duplicateSelected()}
                disabled={locked || selected?.kind !== "enemy"}
              >
                Duplicate
              </button>
              <button type="button" onClick={() => void deleteSelected()} disabled={locked || selected?.kind !== "enemy"}>
                Delete
              </button>
            </div>
          }
        />
        {selected && tab === "characters" && (
          <ArtPanel key={selected.id} character={selected} project={project} art={state.art} session={session} locked={playing || Object.values(state.chats).some((c) => c.running !== null)} />
        )}
      </SidePanel>
      )}

      <ChatPanel
        key={agent}
        session={session}
        agent={agent}
        chat={state.chats[agent]}
        revision={project.revision}
        canUndo={state.canUndo}
        playing={playing}
        connected={state.serverConnected}
        open={chatOpen}
        onToggle={() => setChatOpen(!chatOpen)}
        onSwitchAgent={(a) => openTab(a === "narrative" ? "wiki" : a === "architect" ? "architect" : "playtest")}
      />
    </div>
  );
}

const noMenu = (e: Event) => e.preventDefault();

function statusText(status: string, mode: string): string {
  if (status === "booting") return "Loading game…";
  if (status === "unavailable") return "Game unavailable";
  return mode === "play" ? "Playing" : "Editing";
}
