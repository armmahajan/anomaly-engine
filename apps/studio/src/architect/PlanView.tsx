import { useEffect, useState } from "react";
import { ARCHITECT_STAGES, regionOrder, RoomPlan, STAGE_DESCRIPTIONS, uniqueId, type ArchitectState, type ProjectSpec } from "@anomaly/core";
import { ConfirmButton } from "../content/ListSection.tsx";
import { stageChip, stageLabel } from "./RunPanel.tsx";
import type { Session } from "../session.ts";
import { DraftText, NumberInput } from "./fields.tsx";
import { RoomCard, screens, screensText, type Run } from "./RoomCard.tsx";
import { setExpanded, showRoom, useArchitectUi } from "./ui.ts";

/**
 * The main pane: the Architect's plan as a document. The whole game's
 * guidance and target play time, then each progression region (in the order
 * the player meets them) with its notes and its room cards.
 */

interface Props {
  project: ProjectSpec;
  architect: ArchitectState;
  session: Session;
  locked: boolean;
  onOpenRoom?: (roomId: string) => void;
}

export function PlanView({ project, architect, session, locked, onOpenRoom }: Props) {
  const ui = useArchitectUi();
  const plan = project.architect;
  const progression = project.progression;
  const editLocked = locked || session.aiBusy();

  const run: Run = async (name, input) => {
    const result = await session.applyOperation(name, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };

  const seed = () => void run("seedArchitectPlan", {});
  const unpinned = plan.rooms.filter((r) => !r.pinned).length;
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  // A room asked for (an issue's Show room, a link) opens its region if it was folded.
  const focusRegion = plan.rooms.find((r) => r.id === ui.focus?.roomId)?.regionId;
  useEffect(() => {
    if (focusRegion && folded.has(focusRegion)) setFolded(new Set([...folded].filter((id) => id !== focusRegion)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.focus?.nonce]);
  const fold = (regionId: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(regionId)) next.add(regionId);
      return next;
    });

  const addRoom = async (regionId: string) => {
    const region = progression.regions.find((r) => r.id === regionId);
    const ids = plan.rooms.map((r) => r.id);
    const inRegion = plan.rooms.filter((r) => r.regionId === regionId).length;
    const id = uniqueId(`${regionId}_${inRegion + 1}`, ids);
    const room = RoomPlan.parse({ id, name: `${region?.name ?? regionId} ${inRegion + 1}`, regionId, seed: Math.floor(Math.random() * 1_000_000) });
    if (await run("createRoomPlan", { room })) showRoom(id);
  };

  const notesOf = (regionId: string) => plan.regionNotes.find((n) => n.regionId === regionId)?.notes ?? "";
  const order = regionOrder(project);
  const known = new Set(progression.regions.map((r) => r.id));
  const strays = plan.rooms.filter((r) => !known.has(r.regionId));
  const totalScreens = plan.rooms.reduce((n, r) => n + screens(r.cols, r.rows), 0);
  const pinned = plan.rooms.filter((r) => r.pinned).length;
  const allOpen = plan.rooms.length > 0 && plan.rooms.every((r) => ui.expanded.has(r.id));

  const cards = (rooms: RoomPlan[]) => (
    <div className="room-cards">
      {rooms.map((room) => (
        <RoomCard
          key={room.id}
          room={room}
          project={project}
          architect={architect}
          session={session}
          run={run}
          expanded={ui.expanded.has(room.id)}
          focusNonce={ui.focus?.roomId === room.id ? ui.focus.nonce : null}
          locked={editLocked}
          {...(onOpenRoom ? { onOpenRoom } : {})}
        />
      ))}
    </div>
  );

  return (
    <div className="architect-main" data-testid="architect-main">
      {plan.rooms.length > 0 && <RunStrip project={project} architect={architect} />}
      <header className="architect-head">
        <h1>Build the game</h1>
        <p className="hint">
          The Architect turns the progression into a world: it plans the rooms, builds and fills them, then proves the game can be finished. Leave it all
          to the Architect with <b>Build game</b>, or shape as much of the plan as you like first. Pin a room to keep it exactly as you made it.
        </p>
      </header>

      <section className="architect-game" data-testid="architect-game">
        <DraftText
          multiline
          rows={3}
          caption="Guidance for the whole game"
          label="Game guidance"
          value={plan.guidance}
          disabled={editLocked}
          maxLength={4000}
          placeholder="What the Architect should aim for: pace, mood, how hard, what to show off…"
          onCommit={(guidance) => run("setArchitectGuidance", { guidance })}
        />
        <div className="architect-game-row">
          <span className="arch-caption">Play time</span>
          <NumberInput
            label="Target minutes, at least"
            value={plan.target.minutes[0]}
            min={1}
            max={600}
            disabled={editLocked}
            onCommit={(lo) => run("setArchitectGuidance", { targetMinutes: [lo, Math.max(lo, plan.target.minutes[1])] })}
          />
          <span>to</span>
          <NumberInput
            label="Target minutes, at most"
            value={plan.target.minutes[1]}
            min={1}
            max={600}
            disabled={editLocked}
            onCommit={(hi) => run("setArchitectGuidance", { targetMinutes: [Math.min(hi, plan.target.minutes[0]), hi] })}
          />
          <span className="hint">minutes</span>
          {plan.rooms.length > 0 && (
            <span className="architect-stats hint" data-testid="architect-stats">
              {plan.rooms.length} rooms · {plan.links.length} links · {screensText(totalScreens).replace("about ", "≈ ")}
              {pinned > 0 && ` · ${pinned} pinned`}
            </span>
          )}
        </div>
        {plan.rooms.length > 0 && (
          <div className="architect-game-row">
            {unpinned > 0 ? (
              <ConfirmButton
                label="Start again from the progression"
                question={`Replace the ${unpinned} unpinned room${unpinned === 1 ? "" : "s"} and their links with a new plan? Pinned rooms stay; Undo restores the rest.`}
                confirmLabel="Replace the plan"
                disabled={editLocked || progression.regions.length === 0}
                title="Replace the unpinned rooms with a plan derived from the progression"
                onConfirm={seed}
              />
            ) : (
              <button type="button" disabled={editLocked || progression.regions.length === 0} onClick={seed} title="Replace the unpinned rooms with a plan derived from the progression">
                Start again from the progression
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setFolded(new Set());
                setExpanded(allOpen ? [] : plan.rooms.map((r) => r.id));
              }}
            >
              {allOpen ? "Collapse all rooms" : "Expand all rooms"}
            </button>
            <button type="button" onClick={() => setFolded(folded.size === order.length ? new Set() : new Set(order))}>
              {folded.size === order.length ? "Unfold all regions" : "Fold all regions"}
            </button>
          </div>
        )}
      </section>

      {plan.rooms.length === 0 ? (
        <section className="architect-empty" data-testid="architect-empty">
          <h2>No plan yet</h2>
          {progression.regions.length === 0 ? (
            <p className="hint">
              The plan grows out of the progression: its regions, the abilities and keys that gate them, the start and the ending. Design the progression
              first (the Progression tab, or ask the director).
            </p>
          ) : (
            <>
              <p className="hint">
                Start the plan from the progression ({progression.regions.length} regions, {progression.abilities.length} abilities and keys) to review and
                shape every room before anything is built. Or press <b>Build game</b> and the Architect plans it for you.
              </p>
              <button type="button" className="arch-primary" disabled={editLocked} onClick={() => void run("seedArchitectPlan", {})}>
                Start from the progression
              </button>
            </>
          )}
        </section>
      ) : (
        <>
          {order.map((regionId) => {
            const region = progression.regions.find((r) => r.id === regionId)!;
            const rooms = plan.rooms.filter((r) => r.regionId === regionId);
            const size = rooms.reduce((n, r) => n + screens(r.cols, r.rows), 0);
            const tags = [progression.start === regionId && "start", progression.ending === regionId && "ending"].filter(Boolean);
            return (
              <section key={regionId} className={`architect-region${folded.has(regionId) ? " folded" : ""}`} data-testid={`architect-region-${regionId}`}>
                <div className="architect-region-head">
                  <button
                    type="button"
                    className="region-fold"
                    aria-expanded={!folded.has(regionId)}
                    aria-label={`${folded.has(regionId) ? "Unfold" : "Fold"} ${region.name}`}
                    onClick={() => fold(regionId)}
                  >
                    <span className="caret" aria-hidden />
                  </button>
                  <h2>{region.name}</h2>
                  {tags.map((t) => (
                    <span key={String(t)} className="tag">
                      {t}
                    </span>
                  ))}
                  <span className="hint">
                    {rooms.length} room{rooms.length === 1 ? "" : "s"}
                    {rooms.length > 0 && `, ${screensText(size)}`} · the progression asks for {region.rooms}
                  </span>
                  <button type="button" className="arch-mini" disabled={editLocked} onClick={() => void addRoom(regionId)}>
                    + Room
                  </button>
                </div>
                {!folded.has(regionId) && (
                  <DraftText
                    multiline
                    rows={2}
                    label={`Notes for ${region.name}`}
                    value={notesOf(regionId)}
                    disabled={editLocked}
                    maxLength={2000}
                    placeholder={`Notes for ${region.name}: its mood, what it teaches, how it should feel…`}
                    onCommit={(notes) => run("setArchitectGuidance", { region: { regionId, notes } })}
                    className="region-notes"
                  />
                )}
                {!folded.has(regionId) && (rooms.length > 0 ? cards(rooms) : <p className="hint">No rooms planned here.</p>)}
              </section>
            );
          })}
          {strays.length > 0 && (
            <section className="architect-region" data-testid="architect-region-other">
              <div className="architect-region-head">
                <h2>Not in a progression region</h2>
                <span className="hint">move these to a region, or delete them</span>
              </div>
              {cards(strays)}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The run at a glance, above the plan (it stays in view while the plan scrolls):
 * every stage in order with its state, so the plan and the run read together.
 * The controls are in the sidebar.
 */
function RunStrip({ project, architect }: { project: ProjectSpec; architect: ArchitectState }) {
  const paused = new Set(project.architect.pauseAfter);
  return (
    <nav className="arch-strip" aria-label="Build stages" data-testid="architect-strip">
      <ol>
        {ARCHITECT_STAGES.map((stage) => {
          const chip = stageChip(project, architect, stage);
          return (
            <li key={stage} className={`arch-strip-stage chip-${chip}`} title={`${stageLabel(stage)}: ${chip}. ${STAGE_DESCRIPTIONS[stage]}`}>
              <span className={`arch-strip-dot chip-${chip}`} aria-hidden />
              {stageLabel(stage)}
              {paused.has(stage) && (
                <span className="arch-strip-pause" aria-label="pauses after">
                  ⏸
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
