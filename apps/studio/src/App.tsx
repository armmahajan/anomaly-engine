import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { newEnemyCharacter, progressionReport, uniqueId, type ChangeResult } from "@anomaly/core";
import type { Session } from "./session.ts";
import { Inspector } from "./Inspector.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { WikiMain, WikiSidebar, type WikiNav } from "./WikiView.tsx";
import { ProgressionMain, ProgressionSidebar, type ProgressionNav } from "./ProgressionView.tsx";

type Tab = "arena" | "wiki" | "progression";
const TAB_LABEL: Record<Tab, string> = { arena: "Arena", wiki: "Wiki", progression: "Progression" };

const ENEMY_COLORS = ["#5f9e6e", "#d08c3a", "#4f8fbf", "#b8577d", "#9c9a3f"];

export function App({ session }: { session: Session }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>("crawler");
  const [tab, setTab] = useState<Tab>("arena");
  const [wikiNav, setWikiNav] = useState<WikiNav>({ pageId: null, editing: null });
  const [progressionNav, setProgressionNav] = useState<ProgressionNav>({ selected: null, creating: null });

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

  /** Design documents are edited while the game is stopped: opening one ends a playtest. */
  const openTab = (next: Tab) => {
    if (next !== "arena" && playing) session.stop();
    setTab(next);
  };

  const openWikiPage = (pageId: string) => {
    setWikiNav({ pageId, editing: null });
    openTab("wiki");
  };

  const openCharacter = (characterId: string) => {
    setSelectedId(characterId);
    setTab("arena");
  };

  const progression = project.progression;
  const drafts: Record<Tab, number> = {
    arena: 0,
    wiki: project.wiki.pages.filter((p) => p.status === "draft").length,
    progression: [...progression.regions, ...progression.abilities, ...progression.connections, ...progression.beats].filter((i) => i.status === "draft").length,
  };
  const checks = tab === "progression" ? progressionReport(project) : null;
  const agent = tab === "arena" ? "build" : "narrative";
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
    <div className="studio">
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

      {/* The game stays mounted (and sized) behind the other tabs so it never reboots. */}
      <main className={`viewport${tab === "arena" ? "" : " offstage"}`} aria-hidden={tab !== "arena"}>
        <iframe ref={frameRef} src="/game/index.html" title="Game" className="game-frame" />
        {!playing && state.runtimeStatus === "ready" && <div className="edit-badge">Edit mode — press Play to test</div>}
      </main>
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
      ) : checks ? (
        <aside className="sidebar">
          <ProgressionSidebar project={project} report={checks} nav={progressionNav} setNav={setProgressionNav} locked={locked} />
          {problem}
        </aside>
      ) : (
      <aside className="sidebar">
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
                  <span className="swatch" style={{ background: c.color }} />
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
        {selected && (
          <Inspector
            key={selected.id}
            character={selected}
            spawns={project.sandbox.spawns.filter((s) => s.characterId === selected.id)}
            defaultSpawn={defaultSpawn}
            session={session}
            locked={locked}
            lockHint={aiBusy ? "The AI is editing. Wait for it or cancel." : "Stop the playtest to edit."}
            wikiPageId={project.wiki.pages.find((p) => p.characterId === selected.id)?.id}
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
      />
    </div>
  );
}

function statusText(status: string, mode: string): string {
  if (status === "booting") return "Loading game…";
  if (status === "unavailable") return "Game unavailable";
  return mode === "play" ? "Playing" : "Editing";
}
