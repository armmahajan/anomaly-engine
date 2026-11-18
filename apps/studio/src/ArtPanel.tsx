import { useState } from "react";
import type { ArtActivityEntry, ArtJobRequest, ArtState, Character, ProjectSpec, RigMode } from "@anomaly/core";
import { fileUrl } from "./api.ts";
import { characterAsset } from "./CharacterBench.tsx";
import type { Session } from "./session.ts";

/**
 * Characters mode sidebar: the inputs and actions for each stage, and the
 * running job. The visuals (sheets, design, live rig, clips) are in the
 * workbench (CharacterBench). The AI loops within a stage; the creator picks
 * between stages, or ticks Auto to take the AI's picks.
 */

interface Props {
  character: Character;
  project: ProjectSpec;
  art: ArtState;
  session: Session;
  /** Playtest or another AI turn in progress. */
  locked: boolean;
}

export const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`);

const RIG_MODE_CHOICES: { id: RigMode; label: string; title: string }[] = [
  { id: "vector", label: "Vector", title: "Redrawn as flat shapes with outlines (the art direction's line and boil)" },
  { id: "cutout", label: "Cutout", title: "The design itself, cut into pieces on bones: looks exactly like the concept" },
  { id: "traced", label: "Traced", title: "The design cut into pieces on bones, each redrawn as flat shapes with the art direction's outline: close to the concept, matching the vector art" },
];

export function ArtPanel({ character, project, art, session, locked }: Props) {
  const asset = characterAsset(project, character);
  const running = art.running;
  const mine = running?.characterId === character.id;
  const lastJob = [...art.jobs].reverse().find((j) => j.characterId === character.id);
  const [brief, setBrief] = useState(asset?.brief ?? "");
  const [conceptNote, setConceptNote] = useState("");
  const [rigNote, setRigNote] = useState("");
  const [animNote, setAnimNote] = useState("");
  const [auto, setAuto] = useState(false);
  const [rigMode, setRigMode] = useState<RigMode>(asset?.rig?.mode ?? project.art.direction.rigMode ?? "vector");
  const [zoom, setZoom] = useState<string | null>(null);
  // Another character's job doesn't block this one: a new job queues behind it.
  const queued = art.pending.some((p) => p.characterId === character.id);
  const disabled = locked || mine || queued || !art.available;

  const start = (request: Omit<ArtJobRequest, "characterId">) => void session.startArtJob({ characterId: character.id, ...request });

  // Where each step stands, and the one thing to do next.
  const sheets = asset?.concepts.length ?? 0;
  const clips = asset ? Object.keys(asset.clips).length : 0;
  const conceptState: StepState = asset?.chosen ? "done" : "next";
  const conceptStatus = asset?.chosen ? "design chosen" : sheets ? `${sheets} sheet${sheets > 1 ? "s" : ""}, none chosen` : "not started";
  const rigState: StepState = !asset?.chosen ? "waiting" : asset.rig ? "done" : "next";
  const rigStatus = !asset?.chosen ? "after a design is chosen" : asset.rig ? `built${asset.preview?.match ? `, ${Math.round(asset.preview.match.silhouette * 100)}% match` : ""}` : "not built";
  const animState: StepState = !asset?.rig ? "waiting" : clips ? "done" : "next";
  const animStatus = !asset?.rig ? "after the rig" : clips ? `${clips} clip${clips > 1 ? "s" : ""}` : "not animated";
  const next = !asset?.chosen
    ? sheets
      ? "Click a design in the workbench to build from it, or generate more."
      : `Describe ${character.name} and generate concepts (or tick Auto to do every step).`
    : !asset.rig
      ? "Build the rig from the chosen design."
      : !clips
        ? "Animate the rig."
        : null;

  return (
    <section className="art-panel" data-testid="art-panel">
      <h2>{character.name}</h2>
      <div className="art-meta">
        {art.available ? (
          <span title={`budget ${money(art.budget)} per job`}>
            {art.models.image} · {art.models.vision} · spent {money(art.totalCost)}
          </span>
        ) : (
          <span className="field-error">Art generation is off: add OPENROUTER_API_KEY to the studio's .env.</span>
        )}
      </div>

      {next && (
        <p className="art-next" data-testid="art-next">
          <span>Next</span> {next}
        </p>
      )}

      <StepHead n="①" title="Concepts" state={conceptState} status={conceptStatus} />
      <label className="art-label" htmlFor="art-brief">
        What should {character.name} look like?
      </label>
      <textarea
        id="art-brief"
        className="art-text"
        rows={3}
        placeholder="e.g. a lanky courier in a patched raincoat with an oversized satchel"
        value={brief}
        disabled={disabled}
        onChange={(e) => setBrief(e.target.value)}
      />
      <input
        className="art-text"
        aria-label="concept direction"
        placeholder="Direction for this round (optional)"
        value={conceptNote}
        disabled={disabled}
        onChange={(e) => setConceptNote(e.target.value)}
      />
      <div className="art-actions">
        <button
          type="button"
          disabled={disabled || !(brief.trim() || asset?.brief)}
          onClick={() => start({ stage: auto ? "auto" : "concepts", brief: brief.trim() || undefined, feedback: conceptNote.trim() || undefined })}
        >
          {auto ? "Generate everything" : "Generate concepts"}
        </button>
        {asset?.chosen && !auto && (
          <button
            type="button"
            disabled={disabled}
            title="Four variations on the chosen design"
            onClick={() => start({ stage: "concepts", refine: true, feedback: conceptNote.trim() || undefined })}
          >
            Variations
          </button>
        )}
        <label className="art-auto" title="Run every stage, taking the AI's picks">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto
        </label>
      </div>

      <StepHead n="②" title="Rig" state={rigState} status={rigStatus} />
      {!asset?.chosen ? (
        <p className="hint">Click a design in the workbench to choose it.</p>
      ) : (
        <>
          <input
            className="art-text"
            aria-label="rig direction"
            placeholder={asset.rig ? "What to change (e.g. bigger horn)" : "Direction (optional)"}
            value={rigNote}
            disabled={disabled}
            onChange={(e) => setRigNote(e.target.value)}
          />
          <div className="art-rig-mode" role="radiogroup" aria-label="rig mode">
            {RIG_MODE_CHOICES.map((m) => (
              <label key={m.id} title={m.title}>
                <input type="radio" name="rig-mode" value={m.id} checked={rigMode === m.id} disabled={disabled} onChange={() => setRigMode(m.id)} /> {m.label}
              </label>
            ))}
          </div>
          <div className="art-actions">
            <button type="button" disabled={disabled} onClick={() => start({ stage: "rig", rigMode })}>
              {asset.rig ? "Rebuild rig" : "Build rig"}
            </button>
            {asset.rig && (
              <button type="button" disabled={disabled || !rigNote.trim()} onClick={() => start({ stage: "rig", rigMode, feedback: rigNote.trim() })}>
                Revise
              </button>
            )}
          </div>
        </>
      )}

      <StepHead n="③" title="Animation" state={animState} status={animStatus} />
      {!asset?.rig ? (
        <p className="hint">Build the rig first.</p>
      ) : (
        <>
          <input
            className="art-text"
            aria-label="animation direction"
            placeholder="Direction (e.g. heavier, stompier walk)"
            value={animNote}
            disabled={disabled}
            onChange={(e) => setAnimNote(e.target.value)}
          />
          <div className="art-actions">
            <button type="button" disabled={disabled} onClick={() => start({ stage: "animate", feedback: animNote.trim() || undefined })}>
              {Object.keys(asset.clips).length > 0 ? "Re-animate" : "Animate"}
            </button>
          </div>
        </>
      )}

      <JobLog art={art} mine={mine} lastJob={lastJob} onCancel={() => void session.cancelArtJob()} onZoom={setZoom} subject={character.name} />
      {zoom && <Zoom file={zoom} onClose={() => setZoom(null)} />}
    </section>
  );
}

type StepState = "done" | "next" | "waiting";

/** A step's heading with where it stands: done, the next to do, or waiting on an earlier one. */
function StepHead({ n, title, state, status }: { n: string; title: string; state: StepState; status: string }) {
  return (
    <h3 className={`art-step art-step-${state}`}>
      <span className="art-step-n" aria-hidden>
        {state === "done" ? "✓" : n}
      </span>
      {title}
      <span className="art-step-status">{status}</span>
    </h3>
  );
}

/** The running job (live activity, cancel) or the last finished one. Shared by the art and world sidebars. */
export function JobLog({
  art,
  mine,
  lastJob,
  onCancel,
  onZoom,
  subject,
}: {
  art: ArtState;
  mine: boolean;
  lastJob: ArtState["jobs"][number] | undefined;
  onCancel: () => void;
  onZoom: (file: string) => void;
  subject: string;
}) {
  const running = art.running;
  return (
    <>
      {(mine || lastJob) && (
        <div className="art-job" data-testid="art-job">
          {mine && running ? (
            <>
              <div className="art-job-head">
                <span>
                  Working: {running.stage} · {money(running.cost)}
                </span>
                <button type="button" onClick={onCancel}>
                  Cancel
                </button>
              </div>
              <Activity entries={running.activity} onZoom={onZoom} />
            </>
          ) : (
            lastJob && (
              <details>
                <summary className={lastJob.outcome === "committed" ? "" : "field-error"}>
                  Last job: {lastJob.stage} · {lastJob.outcome.replace("_", " ")} · {money(lastJob.cost)}
                  {lastJob.error ? ` · ${lastJob.error}` : ""}
                </summary>
                <Activity entries={lastJob.activity} onZoom={onZoom} />
              </details>
            )
          )}
        </div>
      )}
      {running && !mine && <p className="hint">The AI is working on {running.characterId ?? running.biomeId ?? "a new biome"}.</p>}
      {art.queued > 0 && (
        <p className="hint" data-testid="art-queued">
          {art.queued} more art job{art.queued > 1 ? "s" : ""} queued.
        </p>
      )}
    </>
  );
}

export function Zoom({ file, onClose }: { file: string; onClose: () => void }) {
  return (
    <div className="art-zoom" role="dialog" onClick={onClose}>
      <img src={fileUrl(file)} alt="enlarged" />
    </div>
  );
}

function Activity({ entries, onZoom }: { entries: ArtActivityEntry[]; onZoom: (file: string) => void }) {
  return (
    <ol className="art-activity">
      {entries.map((e, i) => (
        <li key={i}>
          <span>{e.text}</span>
          {e.cost !== undefined && <span className="art-cost">{money(e.cost)}</span>}
          {e.file && <img src={fileUrl(e.file)} alt="" onClick={() => onZoom(e.file!)} />}
        </li>
      ))}
    </ol>
  );
}
