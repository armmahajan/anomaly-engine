import { useState } from "react";
import type { ArtActivityEntry, ArtJobRequest, ArtState, Character, CharacterAsset, ProjectSpec } from "@anomaly/core";
import { fileUrl } from "./api.ts";
import type { Session } from "./session.ts";

/**
 * The character's look: concept sheets -> chosen design -> rig -> clips.
 * Each button starts an art job on the server; the AI loops within a stage
 * and stops for the creator's pick between stages (or runs everything with
 * "Auto").
 */

interface Props {
  character: Character;
  project: ProjectSpec;
  art: ArtState;
  session: Session;
  /** Playtest or another AI turn in progress. */
  locked: boolean;
}

const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`);

export function ArtPanel({ character, project, art, session, locked }: Props) {
  const asset = project.art.assets.find((a): a is CharacterAsset => a.id === character.appearance && a.kind === "character") ?? null;
  const running = art.running;
  const busy = running !== null;
  const mine = running?.characterId === character.id;
  const lastJob = [...art.jobs].reverse().find((j) => j.characterId === character.id);
  const [brief, setBrief] = useState(asset?.brief ?? "");
  const [conceptNote, setConceptNote] = useState("");
  const [rigNote, setRigNote] = useState("");
  const [animNote, setAnimNote] = useState("");
  const [auto, setAuto] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const disabled = locked || busy || !art.available;

  const start = (request: Omit<ArtJobRequest, "characterId">) => void session.startArtJob({ characterId: character.id, ...request });
  const preview = (clip: string | null) => {
    if (session.previewClip(character.id, clip)) setPreviewing(clip);
  };

  return (
    <section className="art-panel" data-testid="art-panel">
      <div className="art-meta">
        {art.available ? (
          <span title={`budget ${money(art.budget)} per job`}>
            {art.models.image} · {art.models.vision} · spent {money(art.totalCost)}
          </span>
        ) : (
          <span className="field-error">Art generation is off: add OPENROUTER_API_KEY to the studio's .env.</span>
        )}
      </div>

      <h3>1 · Concepts</h3>
      <label className="art-label" htmlFor="art-brief">
        What should {character.name} look like?
      </label>
      <textarea
        id="art-brief"
        className="art-text"
        rows={2}
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

      {asset && asset.concepts.length > 0 && (
        <div className="art-sheets">
          {asset.concepts
            .map((sheet, index) => ({ sheet, index }))
            .reverse()
            .slice(0, 4)
            .map(({ sheet, index }) => (
              <div key={sheet.file} className="art-sheet" data-testid={`sheet-${index}`}>
                {[0, 1, 2, 3].map((cell) => {
                  const chosen = asset.chosen?.sheet === index && asset.chosen.cell === cell;
                  const picked = sheet.recommended?.cell === cell;
                  return (
                    <button
                      key={cell}
                      type="button"
                      className={`art-cell${chosen ? " chosen" : ""}`}
                      style={{
                        backgroundImage: `url(${fileUrl(sheet.file)})`,
                        backgroundPosition: `${(cell % 2) * 100}% ${Math.floor(cell / 2) * 100}%`,
                      }}
                      disabled={disabled}
                      aria-label={`design ${cell + 1} of sheet ${index + 1}`}
                      title={picked ? `AI pick: ${sheet.recommended?.reason}` : `Use design ${cell + 1}`}
                      onClick={() => start({ stage: "choose", sheet: index, cell })}
                    >
                      {picked && <span className="art-badge">AI pick</span>}
                      {chosen && <span className="art-badge chosen">chosen</span>}
                    </button>
                  );
                })}
                {sheet.feedback && <p className="hint art-caption">“{sheet.feedback}”</p>}
              </div>
            ))}
          <p className="hint">Click a design to build the character from it.</p>
        </div>
      )}

      <h3>2 · Rig</h3>
      {!asset?.chosen ? (
        <p className="hint">Choose a design first.</p>
      ) : (
        <>
          <div className="art-pair">
            <figure>
              <img src={fileUrl(asset.chosen.file)} alt="chosen design" onClick={() => setZoom(asset.chosen!.file)} />
              <figcaption>design</figcaption>
            </figure>
            <figure>
              {asset.preview ? (
                <img src={fileUrl(asset.preview.file)} alt="rig render" data-testid="rig-preview" onClick={() => setZoom(asset.preview!.file)} />
              ) : (
                <div className="art-empty">no rig yet</div>
              )}
              <figcaption>
                rig{asset.preview?.score !== undefined ? ` · ${asset.preview.score}/10` : ""}
                {asset.rig ? ` · ${asset.rig.parts.length} parts` : ""}
              </figcaption>
            </figure>
          </div>
          {asset.preview?.notes && <p className="hint art-notes">{asset.preview.notes}</p>}
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

      <h3>3 · Animation</h3>
      {!asset?.rig ? (
        <p className="hint">Build the rig first.</p>
      ) : (
        <>
          {Object.keys(asset.clips).length > 0 && (
            <ul className="art-clips">
              {Object.keys(asset.clips).map((clipId) => (
                <li key={clipId} data-testid={`clip-${clipId}`}>
                  <button
                    type="button"
                    className={previewing === clipId ? "selected" : ""}
                    disabled={locked}
                    title="Play this clip in the arena (edit mode)"
                    onClick={() => preview(previewing === clipId ? null : clipId)}
                  >
                    {previewing === clipId ? "■" : "▶"} {clipId}
                  </button>
                  {asset.clipPreviews[clipId] && (
                    <img src={fileUrl(asset.clipPreviews[clipId]!)} alt={`${clipId} filmstrip`} onClick={() => setZoom(asset.clipPreviews[clipId]!)} />
                  )}
                </li>
              ))}
            </ul>
          )}
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

      {(mine || lastJob) && (
        <div className="art-job" data-testid="art-job">
          {mine && running ? (
            <>
              <div className="art-job-head">
                <span>
                  Working: {running.stage} · {money(running.cost)}
                </span>
                <button type="button" onClick={() => void session.cancelArtJob()}>
                  Cancel
                </button>
              </div>
              <Activity entries={running.activity} onZoom={setZoom} />
            </>
          ) : (
            lastJob && (
              <details>
                <summary className={lastJob.outcome === "committed" ? "" : "field-error"}>
                  Last job: {lastJob.stage} · {lastJob.outcome.replace("_", " ")} · {money(lastJob.cost)}
                  {lastJob.error ? ` · ${lastJob.error}` : ""}
                </summary>
                <Activity entries={lastJob.activity} onZoom={setZoom} />
              </details>
            )
          )}
        </div>
      )}
      {busy && !mine && <p className="hint">The AI is working on {running.characterId}.</p>}

      {zoom && (
        <div className="art-zoom" role="dialog" onClick={() => setZoom(null)}>
          <img src={fileUrl(zoom)} alt="enlarged" />
        </div>
      )}
    </section>
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
