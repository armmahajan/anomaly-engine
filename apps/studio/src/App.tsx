import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { newEnemyCharacter, progressionReport, snapPlacement, uniqueId, worldSceneFor, type ChangeResult } from "@anomaly/core";
import type { Session } from "./session.ts";
import { Inspector } from "./Inspector.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { WikiMain, WikiSidebar, type WikiNav } from "./WikiView.tsx";
import { ProgressionMain, ProgressionSidebar, type ProgressionNav } from "./ProgressionView.tsx";
import { ArtPanel } from "./ArtPanel.tsx";
import { CharacterBench } from "./CharacterBench.tsx";
import { currentWorld, WorldBench, type WorldUi } from "./WorldBench.tsx";
import { WorldPanel } from "./WorldPanel.tsx";
import { fileUrl } from "./api.ts";
import { useChatOpen, useSidebarWidth } from "./layout.ts";

/** Studio modes. Each puts its own workbench in the main area; the game runtime stays mounted throughout. */
type Tab = "arena" | "characters" | "worlds" | "wiki" | "progression";
const TAB_LABEL: Record<Tab, string> = { arena: "Arena", characters: "Characters", worlds: "Worlds", wiki: "Wiki", progression: "Progression" };
/** Design documents (the director's tabs): the game is hidden and the chat is the director's. */
const DESIGN_TABS: readonly Tab[] = ["wiki", "progression"];

const ENEMY_COLORS = ["#5f9e6e", "#d08c3a", "#4f8fbf", "#b8577d", "#9c9a3f"];

export function App({ session }: { session: Session }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>("crawler");
  const [tab, setTab] = useState<Tab>("arena");
  const [wikiNav, setWikiNav] = useState<WikiNav>({ pageId: null, editing: null });
  const [progressionNav, setProgressionNav] = useState<ProgressionNav>({ selected: null, creating: null });
  const [sidebarWidth, startResize] = useSidebarWidth();
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
  const selected = project.characters.find((c) => c.id === selectedId) ?? null;
  const characterIds = project.characters.map((c) => c.id);
  const playerSpawn = project.sandbox.spawns.find((s) => s.characterId === "player");
  /** Where new things appear: arena centre, on the player's floor. */
  const defaultSpawn = { x: Math.round(project.sandbox.width / 2), y: playerSpawn?.y ?? 0 };

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
        { name: "addSpawn", input: { characterId: id, ...defaultSpawn } },
      ]),
    );
    if (ok) setSelectedId(id);
  };

  const duplicateSelected = async () => {
    if (!selected) return;
    const newId = uniqueId(`${selected.id}_copy`, characterIds);
    const source = project.sandbox.spawns.find((s) => s.characterId === selected.id) ?? defaultSpawn;
    const ok = report(
      await session.applyBatch([
        { name: "duplicateCharacter", input: { characterId: selected.id, newId } },
        { name: "addSpawn", input: { characterId: newId, x: source.x + 80, y: source.y } },
      ]),
    );
    if (ok) setSelectedId(newId);
  };

  const deleteSelected = async () => {
    if (!selected) return;
    const spawnCount = project.sandbox.spawns.filter((s) => s.characterId === selected.id).length;
    if (!window.confirm(`Delete ${selected.name} and its ${spawnCount} spawn(s)? (Undo can restore it.)`)) return;
    if (report(await session.applyOperation("deleteCharacter", { characterId: selected.id }))) setSelectedId("player");
  };

  const resetProject = async () => {
    if (!window.confirm("Start over from the starter project? The current project and chat are backed up first.")) return;
    if (report(await session.resetProject())) setSelectedId("crawler");
  };

  /** Only the arena plays: opening any other mode ends a playtest. */
  const openTab = (next: Tab) => {
    if (next !== "arena" && playing) session.stop();
    setTab(next);
  };

  // Tell the runtime what to show for this mode (workbenches drive their own stage).
  useEffect(() => {
    if (tab === "arena" || tab === "wiki") session.setStage({ mode: "game" });
  }, [session, tab, state.runtimeStatus]);

  const openWikiPage = (pageId: string) => {
    setWikiNav({ pageId, editing: null });
    openTab("wiki");
  };

  const openCharacter = (characterId: string) => {
    setSelectedId(characterId);
    setTab("arena");
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
    const placement = snapPlacement({ piece: pieceId, layer: "play" as const, x, y: scene.height / 2, scale: 1, flip: false }, piece, scene).placement;
    const result = await session.applyOperation("addPlacement", { assetId: biome.id, roomId: room.id, placement });
    if (!result.ok) session.reportProblem(result.error.message);
  };

  const progression = project.progression;
  const drafts: Record<Tab, number> = {
    arena: 0,
    characters: 0,
    worlds: 0,
    wiki: project.wiki.pages.filter((p) => p.status === "draft").length,
    progression: [...progression.regions, ...progression.abilities, ...progression.connections, ...progression.beats].filter((i) => i.status === "draft").length,
  };
  const checks = tab === "progression" ? progressionReport(project) : null;
  const design = DESIGN_TABS.includes(tab);
  const agent = design ? "narrative" : "build";
  const problem = state.lastProblem && (
    <div className="problem" role="alert">
      {state.lastProblem}
      <button type="button" onClick={() => session.dismissProblem()}>
        dismiss
      </button>
    </div>
  );

  const onPlay = async (seed?: number) => {
    setTab("arena");
    if (await session.play(seed)) {
      frameRef.current?.focus();
      frameRef.current?.contentWindow?.focus();
    }
  };

  return (
    <div
      className={`studio mode-${tab}${chatOpen ? "" : " chat-closed"}`}
      style={{ "--side-w": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <header className="toolbar">
        <span className="title">{state.project.name}</span>
        <nav className="tabs" role="tablist">
          {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "selected" : ""} onClick={() => openTab(t)}>
              {TAB_LABEL[t]}
              {drafts[t] > 0 && <span className="tab-count">{drafts[t]}</span>}
            </button>
          ))}
        </nav>
        <button type="button" onClick={() => void onPlay()} disabled={!session.canPlay()}>
          ▶ Play
        </button>
        {state.seed !== null && (
          <button
            type="button"
            onClick={() => void onPlay(state.seed!)}
            disabled={!session.canPlay()}
            title="Play again with the same random choices"
          >
            ⟲ Seed {state.seed}
          </button>
        )}
        <button type="button" onClick={session.stop} disabled={!playing}>
          ■ Stop
        </button>
        <button
          type="button"
          onClick={() => void session.undo()}
          disabled={locked || !state.canUndo}
          title="Undo (Ctrl/Cmd+Z)"
        >
          ↶ Undo
        </button>
        <button type="button" onClick={() => void resetProject()} disabled={locked}>
          Reset…
        </button>
        <span className={`status status-${state.runtimeStatus}`} data-testid="runtime-status">
          {aiBusy ? "AI is editing…" : statusText(state.runtimeStatus, state.mode)}
        </span>
        <span className="revision">rev {state.project.revision}</span>
        <span
          className={`server ${state.serverConnected ? "server-on" : "server-off"}`}
          title={state.serverConnected ? "Connected to project server" : "Project server disconnected"}
        >
          ●
        </span>
      </header>

      {/* The game stays mounted (and sized) in every mode so it never reboots; modes only move it. */}
      <main className={`viewport${design ? " offstage" : ""}`} aria-hidden={design}>
        <iframe ref={frameRef} src="/game/index.html" title="Game" className="game-frame" />
        {tab === "arena" && !playing && state.runtimeStatus === "ready" && (
          <div className="edit-badge">Edit mode — press Play to test</div>
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
      {tab === "characters" && selected && (
        <CharacterBench key={`${selected.id}:${state.runtimeStatus}`} character={selected} project={project} art={state.art} session={session} />
      )}
      {tab === "worlds" && (
        <WorldBench
          project={project}
          session={session}
          ui={worldUi}
          setUi={setWorldUi}
          selected={worldSelected}
          locked={locked}
          onPlacePiece={(pieceId) => void placePiece(pieceId)}
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

      {tab === "wiki" ? (
        <aside className="sidebar">
          <WikiSidebar project={project} nav={wikiNav} setNav={setWikiNav} locked={locked} />
          {problem}
        </aside>
      ) : tab === "worlds" ? (
        <aside className="sidebar">
          <div className="side-resize" onPointerDown={startResize} title="Drag to resize" />
          <WorldPanel
            project={project}
            art={state.art}
            session={session}
            ui={worldUi}
            setUi={setWorldUi}
            selected={worldSelected}
            setSelected={setWorldSelected}
            locked={locked}
          />
          {problem}
        </aside>
      ) : checks ? (
        <aside className="sidebar">
          <ProgressionSidebar project={project} report={checks} nav={progressionNav} setNav={setProgressionNav} locked={locked} />
          {problem}
        </aside>
      ) : (
      <aside className="sidebar">
        <div className="side-resize" onPointerDown={startResize} title="Drag to resize" />
        <section>
          <h2>Characters</h2>
          <ul className="character-list">
            {project.characters.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  data-testid={`character-${c.id}`}
                  className={c.id === selectedId ? "selected" : ""}
                  onClick={() => setSelectedId(c.id)}
                >
                  {(() => {
                    const look = project.art.assets.find((a) => a.id === c.appearance);
                    return look?.kind === "character" && look.preview ? (
                      <img className="swatch-img" src={fileUrl(look.preview.file)} alt="" />
                    ) : (
                      <span className="swatch" style={{ background: c.color }} />
                    );
                  })()}
                  {c.name}
                  <span className="kind">{c.kind}</span>
                </button>
              </li>
            ))}
          </ul>
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
        </section>
        {selected && tab === "characters" && (
          <ArtPanel key={selected.id} character={selected} project={project} art={state.art} session={session} locked={playing || Object.values(state.chats).some((c) => c.running !== null)} />
        )}
        {selected && tab === "arena" && (
          <Inspector
            key={selected.id}
            character={selected}
            spawns={project.sandbox.spawns.filter((s) => s.characterId === selected.id)}
            defaultSpawn={defaultSpawn}
            session={session}
            locked={locked}
            lockHint={aiBusy ? "The AI is editing. Wait for it or cancel." : "Stop the playtest to edit."}
            wikiPageId={project.wiki.pages.find((p) => p.characterId === selected.id)?.id}
            arenaAbilities={project.sandbox.playerAbilities}
            onOpenWiki={openWikiPage}
          />
        )}
        {problem}
      </aside>
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
      />
    </div>
  );
}

function statusText(status: string, mode: string): string {
  if (status === "booting") return "Loading game…";
  if (status === "unavailable") return "Game unavailable";
  return mode === "play" ? "Playing" : "Editing";
}
