import { useState } from "react";
import { artStaleness, type ArtActivityEntry, type ArtJobRequest, type ArtRunningJob, type ArtState, type ProjectSpec, type RigMode } from "@anomaly/core";
import { fileUrl } from "./api.ts";
import type { Session } from "./session.ts";
import { isSubjectJob, subjectRef, type ArtSubject } from "./characters/subject.ts";
import { ObjectUsesPanel } from "./objects/ObjectUsesPanel.tsx";

/**
 * Characters mode sidebar: the inputs and actions for each stage, and the
 * running job. The visuals (sheets, design, live rig, clips) are in the
 * workbench (CharacterBench). The AI loops within a stage; the creator picks
 * between stages, or ticks Auto to take the AI's picks.
 */

interface Props {
  /** A character (its appearance) or an object asset: art jobs send characterId or objectId. */
  subject: ArtSubject;
  project: ProjectSpec;
  art: ArtState;
  session: Session;
  /** Playtest or another AI turn in progress. */
  locked: boolean;
}

export const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`);

const RIG_MODE_CHOICES: { id: RigMode; label: string; title: string }[] = [
  {
    id: "vector",
    label: "Vector (recommended)",
    title:
      "The full pipeline: designs drawn ready to rig, a clean flat redraw, a vector rig with elbows and knees checked over several rounds, then detail shapes (shading, highlights, folds) from the design. Animates cleanly.",
  },
  { id: "cutout", label: "Cutout", title: "The design itself, cut into pieces on bones: looks exactly like the concept" },
  { id: "traced", label: "Traced", title: "The design cut into pieces on bones, each redrawn as flat shapes with the art direction's outline: close to the concept, matching the vector art" },
];

export function ArtPanel({ subject, project, art, session, locked }: Props) {
  const asset = subject.asset;
  const job = art.runningJobs.find((j) => isSubjectJob(j, subject)) ?? null;
  const mine = job !== null;
  const lastJob = [...art.jobs].reverse().find((j) => isSubjectJob(j, subject));
  const [brief, setBrief] = useState(asset?.brief ?? "");
  const [conceptNote, setConceptNote] = useState("");
  const [rigNote, setRigNote] = useState("");
  const [animNote, setAnimNote] = useState("");
  const [auto, setAuto] = useState(false);
  const [rigMode, setRigMode] = useState<RigMode>(asset?.rig?.mode ?? project.art.direction.rigMode ?? "vector");
  const [zoom, setZoom] = useState<string | null>(null);
  // Another character's job doesn't block this one: it runs alongside (or queues behind what it conflicts with).
  const queued = art.pending.some((p) => isSubjectJob(p, subject));
  const disabled = locked || mine || queued || !art.available;

  const start = (request: Omit<ArtJobRequest, "characterId" | "objectId">) => void session.startArtJob({ ...subjectRef(subject), ...request } as ArtJobRequest);

  // Where each step stands, and the one thing to do next. A later step built from an earlier
  // version of the one before it (another design chosen since, the bones changed since) is out of date.
  const sheets = asset?.concepts.length ?? 0;
  const clips = asset ? Object.keys(asset.clips).length : 0;
  const { rigStale, clipsStale } = asset ? artStaleness(asset) : { rigStale: false, clipsStale: false };
  const conceptState: StepState = asset?.chosen ? "done" : "next";
  const conceptStatus = asset?.chosen ? "design chosen" : sheets ? `${sheets} sheet${sheets > 1 ? "s" : ""}, none chosen` : "not started";
  const rigState: StepState = !asset?.chosen ? "waiting" : asset.rig && !rigStale ? "done" : "next";
  const rigStatus = !asset?.chosen
    ? "after a design is chosen"
    : rigStale
      ? "from an earlier design: rebuild"
      : asset.rig
        ? `built${asset.preview?.match ? `, ${Math.round(asset.preview.match.silhouette * 100)}% match` : ""}`
        : "not built";
  const animState: StepState = !asset?.rig || rigStale ? "waiting" : clips && !clipsStale ? "done" : "next";
  const animStatus = !asset?.rig
    ? "after the rig"
    : rigStale
      ? "after the rig is rebuilt"
      : clipsStale
        ? "for an earlier rig: re-animate"
        : clips
          ? `${clips} clip${clips > 1 ? "s" : ""}`
          : "not animated";
  const next = !asset?.chosen
    ? sheets
      ? "Click a design in the workbench to build from it, or generate more."
      : `Describe ${subject.name} and generate concepts (or tick Auto to do every step).`
    : !asset.rig
      ? "Build the rig from the chosen design."
      : rigStale
        ? "You chose another design: rebuild the rig from it, then re-animate."
        : !clips
          ? "Animate the rig."
          : clipsStale
            ? "The rig changed since these clips were written: re-animate."
            : null;

  return (
    <section className="art-panel" data-testid="art-panel">
      <h2>
        {subject.name}
        {subject.kind === "object" && <span className="kind"> object</span>}
      </h2>
      {subject.kind === "object" && <ObjectUsesPanel objectId={subject.id} project={project} session={session} locked={locked} />}
      <div className="art-meta">
        {art.available ? (
          <>
            <ImageModelPicker art={art} project={project} session={session} disabled={locked} />
            <span title={`budget ${money(art.budget)} per job`}>
              {art.models.imageChoices.length < 2 ? `${art.models.image} · ` : ""}
              {art.models.vision} · spent {money(art.totalCost)}
            </span>
          </>
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
        What should {subject.name} look like?
      </label>
      <textarea
        id="art-brief"
        className="art-text"
        rows={3}
        placeholder={subject.kind === "object" ? "e.g. a rusted floor lever with a red knob" : "e.g. a lanky courier in a patched raincoat with an oversized satchel"}
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
          onClick={() => start({ stage: auto ? "auto" : "concepts", brief: brief.trim() || undefined, feedback: conceptNote.trim() || undefined, rigMode })}
        >
          {auto ? "Generate everything" : "Generate concepts"}
        </button>
        {asset?.chosen && !auto && (
          <button
            type="button"
            disabled={disabled}
            title="Four variations on the chosen design"
            onClick={() => start({ stage: "concepts", refine: true, feedback: conceptNote.trim() || undefined, rigMode })}
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

      <JobLog art={art} job={job} lastJob={lastJob} onCancel={(id) => void session.cancelArtJob(id)} onZoom={setZoom} subject={subject.name} />
      {zoom && <Zoom file={zoom} onClose={() => setZoom(null)} />}
    </section>
  );
}

/**
 * Which image model draws the art (the art direction's imageModel; the studio lists the offered ones). Steps
 * the pick can't do (a reference image, a transparent background) fall back to the default, and the job log
 * names the model that drew each image.
 */
export function ImageModelPicker({ art, project, session, disabled }: { art: ArtState; project: ProjectSpec; session: Session; disabled: boolean }) {
  const offered = art.models.imageChoices;
  if (offered.length < 2) return null;
  const picked = project.art.direction.imageModel;
  const value = offered.some((m) => m.id === picked) ? picked! : offered[0]!.id;
  const choose = async (id: string) => {
    const result = await session.applyOperation("setArtDirection", { changes: { imageModel: id === offered[0]!.id ? null : id } });
    if (!result.ok) session.reportProblem(result.error.message);
  };
  return (
    <label className="art-image-model" title="Draws all the art: concepts, redraws, details, props, weapons, screens and scenery. Steps it can't do (a reference image, a transparent background) use the default.">
      Image model
      <select aria-label="Image model" value={value} disabled={disabled} onChange={(e) => void choose(e.target.value)}>
        {offered.map((m, i) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {i === 0 ? " (default)" : ""}
          </option>
        ))}
      </select>
    </label>
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
  job,
  lastJob,
  onCancel,
  onZoom,
  subject,
}: {
  art: ArtState;
  /** This subject's running job, if one runs. */
  job: ArtRunningJob | null;
  lastJob: ArtState["jobs"][number] | undefined;
  onCancel: (jobId: string) => void;
  onZoom: (file: string) => void;
  subject: string;
}) {
  const others = art.runningJobs.filter((j) => j.id !== job?.id);
  return (
    <>
      {(job || lastJob) && (
        <div className="art-job" data-testid="art-job">
          {job ? (
            <>
              <div className="art-job-head">
                <span>
                  Working: {job.stage} · {money(job.cost)}
                  {job.waiting ? ` · waiting (${job.waiting})` : ""}
                </span>
                <button type="button" onClick={() => onCancel(job.id)}>
                  Cancel
                </button>
              </div>
              <Activity entries={job.activity} onZoom={onZoom} />
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
      {others.length > 0 && (
        <p className="hint" data-testid="art-others">
          Also drawing: {others.map((o) => (o.stage === "gameArt" ? `the whole game${o.underLock ? " (the Architect)" : ""}` : `${o.characterId ?? o.objectId ?? o.weaponId ?? o.biomeId ?? (o.stage === "worldKit" ? "a new biome" : o.stage)} (${o.stage})`)).join(", ")}.
        </p>
      )}
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
