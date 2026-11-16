import { useState } from "react";
import type { ArtActivityEntry, ArtJobRequest, ArtState, Character, ProjectSpec } from "@anomaly/core";
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
  const [zoom, setZoom] = useState<string | null>(null);
  const disabled = locked || running !== null || !art.available;

  const start = (request: Omit<ArtJobRequest, "characterId">) => void session.startArtJob({ characterId: character.id, ...request });

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

      <h3>① Concepts</h3>
      <label className="art-label" htmlFor="art-brief">
        What should {character.name} look like?
      </label>
      <textarea
        id="art-brief"
        className="art-text"
        rows={3}
        placeholder="e.g. a horned beetle knight with a pale mask"
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

      <h3>② Rig</h3>
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
          <div className="art-actions">
            <button type="button" disabled={disabled} onClick={() => start({ stage: "rig" })}>
              {asset.rig ? "Rebuild rig" : "Build rig"}
            </button>
            {asset.rig && (
              <button type="button" disabled={disabled || !rigNote.trim()} onClick={() => start({ stage: "rig", feedback: rigNote.trim() })}>
                Revise
              </button>
            )}
          </div>
        </>
      )}

      <h3>③ Animation</h3>
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
