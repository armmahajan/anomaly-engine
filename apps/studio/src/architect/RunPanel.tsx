import { useEffect } from "react";
import { ARCHITECT_STAGES, STAGE_DESCRIPTIONS, type ArchitectRunRequest, type ArchitectStage, type ArchitectState, type ProjectSpec } from "@anomaly/core";
import type { Session } from "../session.ts";
import { runReported, showRoom, startRun, stopRun, useRunControl } from "./ui.ts";

/**
 * The sidebar: the Architect's run. One primary button (Build game, Continue
 * after a pause, Rebuild once everything is done; Stop while it runs), the
 * stages with their status, summary and a pause-after toggle, how the last run
 * ended and what it found, and a compact activity log.
 */

export type StageChip = "pending" | "running" | "done" | "stale" | "failed" | "paused";

export const stageLabel = (stage: ArchitectStage) => stage[0]!.toUpperCase() + stage.slice(1);

/** What a stage's chip says: the project's record, the run's current stage, and where a paused run waits. */
export function stageChip(project: ProjectSpec, architect: ArchitectState, stage: ArchitectStage): StageChip {
  if (architect.running?.stage === stage) return "running";
  const status = project.architect.stages[stage]?.status ?? "pending";
  const last = architect.last;
  if (!architect.running && last?.outcome === "paused" && last.stage === stage && status === "done") return "paused";
  return status;
}

export type RunAction = "build" | "continue" | "rebuild";

export function runAction(project: ProjectSpec, architect: ArchitectState): RunAction {
  if (architect.last?.outcome === "paused") return "continue";
  if (ARCHITECT_STAGES.every((s) => project.architect.stages[s]?.status === "done")) return "rebuild";
  return "build";
}

const ACTION_LABEL: Record<RunAction, string> = { build: "Build game", continue: "Continue", rebuild: "Rebuild" };

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

interface Props {
  project: ProjectSpec;
  architect: ArchitectState;
  session: Session;
  /** Edits refused (a playtest, or the AI/art/the Architect at work). */
  locked: boolean;
}

export function RunPanel({ project, architect, session, locked }: Props) {
  const plan = project.architect;
  const running = architect.running;
  const last = architect.last;
  const control = useRunControl();
  useEffect(() => runReported(session, running), [session, running, control.stopping]);
  const underway = running !== null || control.starting;
  const action = runAction(project, architect);
  const busyElsewhere = !underway && (locked || session.aiBusy());
  const roomName = (id: string) => plan.rooms.find((r) => r.id === id)?.name ?? id;

  const start = (request: ArchitectRunRequest) => void startRun(session, request);
  const onPrimary = () => start(action === "rebuild" ? { from: "plan" } : {});

  const togglePause = async (stage: ArchitectStage, on: boolean) => {
    const pauseAfter = on ? [...plan.pauseAfter, stage] : plan.pauseAfter.filter((s) => s !== stage);
    const result = await session.applyOperation("setArchitectPause", { pauseAfter: ARCHITECT_STAGES.filter((s) => pauseAfter.includes(s)) });
    if (!result.ok) session.reportProblem(result.error.message);
  };

  return (
    <section className="architect-sidebar" data-testid="architect-sidebar">
      <h2>Build game</h2>
      <div className="arch-run-buttons">
        {underway ? (
          <button type="button" className="arch-stop" disabled={control.stopping} onClick={() => void stopRun(session, running)}>
            {control.stopping ? "Stopping…" : "■ Stop"}
          </button>
        ) : (
          <button type="button" className="arch-primary" disabled={busyElsewhere} onClick={onPrimary}>
            {ACTION_LABEL[action]}
          </button>
        )}
      </div>
      <p className="hint arch-run-hint" data-testid="architect-run-hint">
        {!running && control.starting ? "Starting…" : runHint(project, architect, roomName)}
      </p>
      {running && (
        <div className="arch-progress" aria-hidden>
          <div style={{ width: `${((running.stages.indexOf(running.stage) + 0.5) / running.stages.length) * 100}%` }} />
        </div>
      )}

      <h3>Stages</h3>
      <ol className="arch-stages">
        {ARCHITECT_STAGES.map((stage, i) => {
          const chip = stageChip(project, architect, stage);
          const record = plan.stages[stage];
          const inRun = running?.stages.includes(stage) ?? false;
          const paused = plan.pauseAfter.includes(stage);
          const isLast = i === ARCHITECT_STAGES.length - 1;
          return (
            <li key={stage} className={`arch-stage chip-${chip}${inRun ? " in-run" : ""}`} data-testid={`architect-stage-${stage}`}>
              <div className="arch-stage-head">
                <span className={`arch-chip chip-${chip}`} data-testid={`stage-chip-${stage}`}>
                  {chip}
                </span>
                <span className="arch-stage-name">{stageLabel(stage)}</span>
                {!isLast && (
                  <label className={`arch-pause${paused ? " on" : ""}`} title={`Stop for your review when ${stage} finishes`}>
                    <input
                      type="checkbox"
                      aria-label={`Pause after ${stage}`}
                      checked={paused}
                      disabled={locked || session.aiBusy()}
                      onChange={(e) => void togglePause(stage, e.target.checked)}
                    />
                    pause after
                  </label>
                )}
                {!underway && (chip === "done" || chip === "stale" || chip === "failed" || chip === "paused") && (
                  <button
                    type="button"
                    className="arch-mini"
                    disabled={busyElsewhere}
                    title={`Run again from ${stage} to the end (later stages follow)`}
                    aria-label={`Run from ${stage}`}
                    onClick={() => start({ from: stage })}
                  >
                    ↻
                  </button>
                )}
              </div>
              {record?.summary && <p className="arch-stage-summary">{record.summary}</p>}
              <p className="arch-stage-desc">{STAGE_DESCRIPTIONS[stage]}</p>
              {paused && !isLast && <div className="arch-pause-line">⏸ pauses here for review</div>}
            </li>
          );
        })}
      </ol>

      {last && (
        <div className="arch-last" data-testid="architect-last">
          <h3>Last run</h3>
          <p>
            <span className={`arch-chip outcome-${last.outcome}`}>{last.outcome}</span> at {stageLabel(last.stage)}
            <span className="arch-time"> · {time(last.at)}</span>
          </p>
          {last.error && <p className="arch-error">{last.error}</p>}
          {last.issues.length > 0 && (
            <div className="arch-issues" data-testid="architect-issues">
              <h3>Issues ({last.issues.length})</h3>
              <ul>
                {last.issues.map((issue, i) => {
                  const roomId = issueRoom(project, issue);
                  return (
                    <li key={i}>
                      <span className="arch-issue-stage">{issue.stage}</span> {issue.message}
                      <span className="arch-issue-code"> {issue.code}</span>
                      {roomId && (
                        <button type="button" className="arch-mini" data-room={roomId} onClick={() => showRoom(roomId)} title={roomName(roomId)}>
                          Show room
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {architect.log.length > 0 && (
        <details className="arch-log" open data-testid="architect-log">
          <summary>Activity</summary>
          <ol>
            {architect.log
              .slice(-40)
              .reverse()
              .map((entry, i) => (
                <li key={`${entry.at}-${i}`}>
                  <span className="arch-time">{time(entry.at)}</span> <span className="arch-log-stage">{entry.stage}</span> {entry.text}
                </li>
              ))}
          </ol>
        </details>
      )}
    </section>
  );
}

/** The plan room an issue is about: its room, or for a link the room its gate is built in. */
export function issueRoom(project: ProjectSpec, issue: { roomId?: string; linkId?: string }): string | null {
  const plan = project.architect;
  if (issue.roomId && plan.rooms.some((r) => r.id === issue.roomId)) return issue.roomId;
  const link = issue.linkId ? plan.links.find((l) => l.id === issue.linkId) : undefined;
  return link ? link.a.room : null;
}

function runHint(project: ProjectSpec, architect: ArchitectState, roomName: (id: string) => string): string {
  const running = architect.running;
  if (running) {
    const n = running.stages.indexOf(running.stage) + 1;
    const scope = running.rooms ? ` for ${running.rooms.map(roomName).join(", ")}` : "";
    return `Running ${running.stage}${scope} (${n} of ${running.stages.length}). Stop finishes the current stage first.`;
  }
  const last = architect.last;
  if (!last) {
    return project.architect.rooms.length
      ? "Runs every stage below in order and proves the game. Tick “pause after” to stop and review at any stage."
      : "Plans the rooms from the progression, builds them and proves the game. Or start the plan yourself and shape it first.";
  }
  switch (last.outcome) {
    case "paused":
      return `Paused after ${last.stage} for your review. Change anything in the plan, then Continue.`;
    case "failed":
      return `${stageLabel(last.stage)} failed. Fix what it found (or the plan) and build again.`;
    case "cancelled":
      return `Stopped before ${last.stage}. Build game carries on from there.`;
    case "finished":
      return "Built. Rebuild runs every stage again; pinned rooms stay exactly as they are.";
  }
}
