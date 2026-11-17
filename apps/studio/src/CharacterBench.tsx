import { useEffect, useRef, useState } from "react";
import type { ArtState, Character, CharacterAsset, ProjectSpec } from "@anomaly/core";
import { fileBase64, fileUrl } from "./api.ts";
import type { Session } from "./session.ts";

/**
 * Characters mode workbench (main area). Big visuals here; inputs and actions
 * stay in the sidebar (ArtPanel). The live rig is the real runtime, placed in
 * the "stage" grid area next to this component's "design" area, and driven by
 * `stage` messages.
 */

type Step = "concepts" | "rig" | "animation";

/** Which step an art job belongs to (for the stepper's working indicator). */
const JOB_STEPS: Record<string, Step> = { concepts: "concepts", choose: "concepts", auto: "concepts", rig: "rig", animate: "animation" };

interface Props {
  character: Character;
  project: ProjectSpec;
  art: ArtState;
  session: Session;
}

export function characterAsset(project: ProjectSpec, character: Character): CharacterAsset | null {
  const asset = project.art.assets.find((a) => a.id === character.appearance);
  return asset && asset.kind === "character" ? asset : null;
}

function defaultStep(asset: CharacterAsset | null): Step {
  if (asset?.rig && Object.keys(asset.clips).length > 0) return "animation";
  if (asset?.chosen) return "rig";
  return "concepts";
}

export function CharacterBench({ character, project, art, session }: Props) {
  const asset = characterAsset(project, character);
  const [step, setStep] = useState<Step>(() => defaultStep(asset));
  const [sheet, setSheet] = useState<number | null>(null); // null = latest
  const [clip, setClip] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [flip, setFlip] = useState(false);
  const [bones, setBones] = useState(false);
  const [onion, setOnion] = useState(0.5);
  const busy = art.running !== null && art.running.characterId === character.id;

  const clipIds = asset ? Object.keys(asset.clips) : [];
  const currentClip = step === "animation" ? (clip && asset?.clips[clip] ? clip : (clipIds[0] ?? null)) : step === "concepts" && asset?.clips.idle ? "idle" : null;
  const duration = currentClip && asset ? asset.clips[currentClip]!.duration : 1;
  const loop = currentClip && asset ? asset.clips[currentClip]!.loop : true;

  // Follow the pipeline: when a stage's result lands (design chosen, rig built, clips written), show the next step.
  const progress = `${asset?.chosen?.file ?? ""}|${asset?.preview?.file ?? ""}|${clipIds.join(",")}`;
  const lastProgress = useRef(progress);
  useEffect(() => {
    if (progress !== lastProgress.current) {
      lastProgress.current = progress;
      setStep(defaultStep(asset));
    }
  }, [progress, asset]);

  // Local playhead while playing (the runtime plays on its own clock at the same speed).
  useEffect(() => {
    if (!playing || step !== "animation") return;
    let frame = 0;
    const start = performance.now() - (time / speed) * 1000;
    const tick = () => {
      const t = ((performance.now() - start) / 1000) * speed;
      setTime(loop ? t % duration : Math.min(t, duration));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, step, currentClip, speed, duration, loop]);

  // The design image goes to the runtime once per design (for the onion skin), not with every frame.
  const sentDesign = useRef<string | null>(null);
  const [designData, setDesignData] = useState<string | null>(null);
  const designRef = asset?.chosen?.file ?? null;
  useEffect(() => {
    if (!designRef) return;
    let cancelled = false;
    void fileBase64(designRef).then((data) => !cancelled && setDesignData(data));
    return () => {
      cancelled = true;
    };
  }, [designRef]);

  useEffect(() => {
    let image: string | null = null;
    if (designRef && designData && sentDesign.current !== designRef) {
      image = designData;
      sentDesign.current = designRef;
    } else if (!designRef && sentDesign.current !== null) {
      image = "";
      sentDesign.current = null;
    }
    session.setStage({
      mode: "character",
      characterId: character.id,
      clip: currentClip,
      time: step === "animation" && !playing ? time : null,
      speed,
      flip,
      bones,
      onion: { image, alpha: step === "rig" ? onion : 0 },
    });
  }, [session, character.id, currentClip, step, playing, step === "animation" && !playing ? time : -1, speed, flip, bones, onion, designRef, designData, project.revision]);

  const sheets = asset?.concepts ?? [];
  const sheetIndex = sheet ?? sheets.length - 1;
  const shown = sheets[sheetIndex];
  const start = (request: Parameters<Session["startArtJob"]>[0]) => void session.startArtJob(request);
  const disabled = art.running !== null || !art.available;

  const steps: { id: Step; label: string; status: string; ready: boolean }[] = [
    { id: "concepts", label: "① Concepts", status: sheets.length ? `${sheets.length} sheet${sheets.length > 1 ? "s" : ""}` : "none yet", ready: true },
    {
      id: "rig",
      label: "② Rig",
      status: asset?.preview?.match ? `${percent(asset.preview.match.silhouette)} match` : asset?.preview?.score !== undefined ? `${asset.preview.score}/10` : asset?.rig ? "built" : "none yet",
      ready: Boolean(asset?.chosen),
    },
    { id: "animation", label: "③ Animation", status: clipIds.length ? `${clipIds.length} clips` : "none yet", ready: Boolean(asset?.rig) },
  ];

  return (
    <div className="bench" data-testid="character-bench">
      <div className="bench-top">
        <nav className="stepper" aria-label="Stages">
          {steps.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`${step === s.id ? "selected" : ""}${busy && JOB_STEPS[art.running!.stage] === s.id ? " working" : ""}`}
              disabled={!s.ready}
              aria-pressed={step === s.id}
              onClick={() => setStep(s.id)}
            >
              <span>{s.label}</span>
              <small>{s.status}</small>
            </button>
          ))}
        </nav>
        <div className="stage-tools">
          {step === "rig" && asset?.chosen && (
            <label title="Fade the design in behind the rig (the critic's view)">
              Onion
              <input type="range" min={0} max={1} step={0.05} value={onion} onChange={(e) => setOnion(Number(e.target.value))} aria-label="onion skin" />
            </label>
          )}
          <label>
            <input type="checkbox" checked={bones} onChange={(e) => setBones(e.target.checked)} /> Bones
          </label>
          <label>
            <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Face left
          </label>
        </div>
      </div>

      <div className="bench-design">
        {step === "concepts" &&
          (shown ? (
            <div className="bench-sheet" data-testid={`sheet-${sheetIndex}`}>
              {[0, 1, 2, 3].map((cell) => {
                const chosen = asset?.chosen?.sheet === sheetIndex && asset.chosen.cell === cell;
                const picked = shown.recommended?.cell === cell;
                return (
                  <button
                    key={cell}
                    type="button"
                    className={`art-cell${chosen ? " chosen" : ""}`}
                    style={{
                      backgroundImage: `url(${fileUrl(shown.file)})`,
                      backgroundPosition: `${(cell % 2) * 100}% ${Math.floor(cell / 2) * 100}%`,
                    }}
                    disabled={disabled}
                    aria-label={`design ${cell + 1} of sheet ${sheetIndex + 1}`}
                    title={picked ? `AI pick: ${shown.recommended?.reason}` : `Build from design ${cell + 1}`}
                    onClick={() => start({ characterId: character.id, stage: "choose", sheet: sheetIndex, cell })}
                  >
                    {picked && <span className="art-badge">AI pick</span>}
                    {chosen && <span className="art-badge chosen">chosen</span>}
                  </button>
                );
              })}
              <p className="hint bench-caption">
                Sheet {sheetIndex + 1} of {sheets.length}
                {shown.feedback ? ` · “${shown.feedback}”` : ""}
                {shown.recommended ? ` · AI pick: ${shown.recommended.reason}` : ""} · click a design to build from it
              </p>
            </div>
          ) : (
            <Empty>Describe {character.name} in the sidebar and generate concepts: four designs for about a quarter of a cent.</Empty>
          ))}

        {step === "rig" &&
          (asset?.chosen ? (
            <figure className="bench-figure">
              <img src={fileUrl(asset.chosen.file)} alt="chosen design" />
              <figcaption>
                Chosen design · the live rig is on the right
                {asset.preview?.score !== undefined && ` · critic ${asset.preview.score}/10`}
                {asset.rig && ` · ${asset.rig.parts.length} parts`}
                {asset.rig && ` · ${asset.rig.mode ?? "vector"}`}
                {asset.preview?.match && (
                  <span className="bench-match" data-testid="rig-match" title="Measured likeness of the rig at rest to the design: silhouette overlap and color">
                    {" "}
                    · match {percent(asset.preview.match.silhouette)} shape, {percent(asset.preview.match.color)} color
                  </span>
                )}
              </figcaption>
              {asset.preview && <img className="bench-hidden-preview" src={fileUrl(asset.preview.file)} alt="rig render" data-testid="rig-preview" />}
            </figure>
          ) : (
            <Empty>Choose a design first.</Empty>
          ))}

        {step === "animation" &&
          (clipIds.length > 0 && asset ? (
            <ul className="bench-clips">
              {clipIds.map((id) => (
                <li key={id} data-testid={`clip-${id}`} className={id === currentClip ? "selected" : ""}>
                  <button
                    type="button"
                    aria-pressed={id === currentClip}
                    onClick={() => {
                      setClip(id);
                      setTime(0);
                      setPlaying(true);
                    }}
                  >
                    {id === currentClip ? "■" : "▶"} {id}
                    <small>
                      {asset.clips[id]!.duration}s{asset.clips[id]!.loop ? " loop" : ""}
                    </small>
                  </button>
                  {asset.clipPreviews[id] && <img src={fileUrl(asset.clipPreviews[id]!)} alt={`${id} filmstrip`} />}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{asset?.rig ? "Animate the rig from the sidebar." : "Build the rig first."}</Empty>
          ))}
      </div>

      <div className="bench-bottom">
        {step === "concepts" && sheets.length > 1 && (
          <div className="sheet-strip" aria-label="Concept history">
            {sheets.map((s, i) => (
              <button key={s.file} type="button" className={i === sheetIndex ? "selected" : ""} onClick={() => setSheet(i)} title={s.feedback ?? `Sheet ${i + 1}`}>
                <img src={fileUrl(s.file)} alt={`sheet ${i + 1}`} />
              </button>
            ))}
          </div>
        )}
        {step === "rig" && asset?.preview?.notes && <p className="hint bench-notes">Critic: {asset.preview.notes}</p>}
        {step === "animation" && currentClip && (
          <div className="timeline" data-testid="timeline">
            <button type="button" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play clip"}>
              {playing ? "❚❚" : "▶"}
            </button>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.01}
              value={time}
              aria-label="clip time"
              onChange={(e) => {
                setPlaying(false);
                setTime(Number(e.target.value));
              }}
            />
            <span className="timeline-time">
              {time.toFixed(2)} / {duration.toFixed(2)}s
            </span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="speed">
              {[0.25, 0.5, 1, 1.5, 2].map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}

const percent = (n: number) => `${Math.round(n * 100)}%`;

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="bench-empty">{children}</div>;
}
