import { useState } from "react";
import { CLIP_SLOTS, objectUses, slugify, uniqueId, type ArtState, type CharacterAsset, type ChangeResult, type Clip, type ProjectSpec } from "@anomaly/core";
import type { Session } from "../session.ts";
import { fileUrl } from "../api.ts";
import { askConfirm } from "../ui/confirm.tsx";
import { animateClipRequest, canAnimateOneClip } from "../artStages.ts";
import { isSubjectJob, missingClips, subjectRef, type ArtSubject } from "./subject.ts";
import { MarkerTimeline } from "./MarkerTimeline.tsx";
import "./characters.css";

/**
 * Characters ▸ Animation: every clip of a character's or an object's art (the standard slots the
 * runtime picks by situation, and named ones), previewed on the stage. The selected clip can be
 * redone from a direction, renamed, copied, deleted, given markers (named moments that fire marker
 * events in play) and, for a character, attached to an enemy behavior state (stateClips) or a weapon
 * attack (its clip). Every change is a core operation, so Undo takes it back.
 */

interface Props {
  subject: ArtSubject;
  asset: CharacterAsset;
  project: ProjectSpec;
  art: ArtState;
  session: Session;
  /** The clip on the stage. */
  current: string | null;
  onPlay: (clipId: string) => void;
  /** A playtest or an AI turn holds the project. */
  locked: boolean;
}

const isSlot = (id: string) => Object.hasOwn(CLIP_SLOTS, id);

/** Behavior states of the characters drawn with this asset (enemies only: the player has no behavior). */
function statesOf(project: ProjectSpec, assetId: string) {
  return project.characters.flatMap((c) => (c.kind === "enemy" && c.appearance === assetId ? Object.keys(c.behavior.states).map((state) => ({ character: c, state })) : []));
}

/** Weapon attacks whose clip names this one. */
const attacksUsing = (project: ProjectSpec, clipId: string) =>
  project.weapons.list.flatMap((w) => w.attacks.filter((a) => a.clip === clipId).map((attack) => ({ weapon: w, attack })));

export function AnimationList({ subject, asset, project, art, session, current, onPlay, locked }: Props) {
  const clipIds = Object.keys(asset.clips);
  const missing = missingClips(project, subject);
  const busy = art.runningJobs.some((j) => isSubjectJob(j, subject)) || art.pending.some((p) => isSubjectJob(p, subject));
  const selected = current && asset.clips[current] ? current : null;

  const run = async (calls: { name: string; input: unknown }[]): Promise<boolean> => {
    const result: ChangeResult = calls.length === 1 ? await session.applyOperation(calls[0]!.name, calls[0]!.input) : await session.applyBatch(calls);
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };

  return (
    <div className="anim-list" data-testid="animation-list">
      {selected && <ClipDetails key={selected} clipId={selected} asset={asset} subject={subject} project={project} art={art} session={session} busy={busy} locked={locked} run={run} onRenamed={onPlay} />}
      <AddAnimation asset={asset} subject={subject} art={art} session={session} busy={busy} locked={locked} run={run} onAdded={onPlay} />
      {missing.length > 0 && (
        <p className="hint anim-missing" data-testid="missing-clips">
          Not made yet: {missing.join(", ")} ({subject.kind === "object" ? "the game plays them; until then the object holds still" : "they fall back to idle"}). Animate fills them in.
        </p>
      )}
      <ul className="bench-clips">
        {clipIds.map((id) => (
          <li key={id} data-testid={`clip-${id}`} className={id === current ? "selected" : ""}>
            <button type="button" aria-pressed={id === current} onClick={() => onPlay(id)}>
              {id === current ? "■" : "▶"} {id}
              <small>
                {asset.clips[id]!.duration}s{asset.clips[id]!.loop ? " loop" : ""}
                {subject.kind === "character" && !isSlot(id) ? " · named" : ""}
                {asset.clips[id]!.markers.length > 0 && ` · ${asset.clips[id]!.markers.map((m) => m.name).join(", ")}`}
              </small>
              {asset.clips[id]!.markers.length > 0 && (
                <span className="clip-marker-ticks" aria-hidden>
                  {asset.clips[id]!.markers.map((m, i) => (
                    <i key={i} style={{ left: `${m.t * 100}%` }} />
                  ))}
                </span>
              )}
            </button>
            {asset.clipPreviews[id] && <img src={fileUrl(asset.clipPreviews[id]!)} alt={`${id} filmstrip`} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Run = (calls: { name: string; input: unknown }[]) => Promise<boolean>;

function ClipDetails({ clipId, asset, subject, project, art, session, busy, locked, run, onRenamed }: {
  clipId: string;
  asset: CharacterAsset;
  subject: ArtSubject;
  project: ProjectSpec;
  art: ArtState;
  session: Session;
  busy: boolean;
  locked: boolean;
  run: Run;
  onRenamed: (clipId: string) => void;
}) {
  const clip = asset.clips[clipId]!;
  const [direction, setDirection] = useState(clip.direction ?? "");
  const [name, setName] = useState(clipId);
  const isObject = subject.kind === "object";
  const states = isObject ? [] : statesOf(project, asset.id);
  const attached = states.filter((s) => asset.stateClips[s.state] === clipId);
  const attacks = isObject ? [] : attacksUsing(project, clipId);
  // An object's clip plays where the game names it: a prop's idle, an effect, a projectile look.
  const objectPlays = isObject ? objectUses(project).filter((u) => u.object === asset.id && u.clips.includes(clipId)) : [];
  const slot = !isObject && isSlot(clipId);

  const redo = () => {
    if (canAnimateOneClip) void session.startArtJob(animateClipRequest(subjectRef(subject), clipId, direction));
    else void session.startArtJob({ stage: "animate", ...subjectRef(subject), feedback: direction.trim() ? `${clipId}: ${direction.trim()}` : undefined });
  };

  const rename = async () => {
    const next = slugify(name, "");
    if (!next || next === clipId) return setName(clipId);
    if (asset.clips[next]) {
      session.reportProblem(`${subject.name} already has a clip "${next}"`);
      return setName(clipId);
    }
    // One step: the clip under its new name (filmstrip too), the states and attacks that played it, then the old name goes.
    const elsewhere = project.art.assets.some((a) => a.id !== asset.id && a.kind === "character" && a.clips[clipId]);
    const calls = [
      { name: "setClip", input: { assetId: asset.id, clipId: next, clip, ...(asset.clipPreviews[clipId] && { preview: asset.clipPreviews[clipId] }) } },
      ...attached.map((s) => ({ name: "setStateClip", input: { assetId: asset.id, stateId: s.state, clipId: next } })),
      ...(elsewhere ? [] : attacks.map(({ weapon, attack }) => ({ name: "setWeaponAttack", input: { weaponId: weapon.id, attack: { ...attack, clip: next } } }))),
      { name: "setClip", input: { assetId: asset.id, clipId, clip: null } },
    ];
    if (await run(calls)) onRenamed(next);
    else setName(clipId);
  };

  const copy = async () => {
    const id = uniqueId(`${clipId}_copy`, Object.keys(asset.clips));
    if (await run([{ name: "setClip", input: { assetId: asset.id, clipId: id, clip } }])) onRenamed(id);
  };

  const remove = async () => {
    const uses = [...attached.map((s) => `${s.character.name}'s ${s.state} state`), ...attacks.map((a) => `${a.weapon.name}'s ${a.attack.name}`)];
    const message = `${uses.length ? `${uses.join(", ")} go${uses.length === 1 ? "es" : ""} back to the automatic clip. ` : ""}Undo can restore it.`;
    if (await askConfirm({ title: `Delete the ${clipId} animation?`, message, confirmLabel: "Delete", danger: true })) void run([{ name: "setClip", input: { assetId: asset.id, clipId, clip: null } }]);
  };

  const attach = (target: string) => {
    const [kind, a, b] = target.split(":");
    if (kind === "state") void run([{ name: "setStateClip", input: { assetId: asset.id, stateId: a, clipId } }]);
    if (kind === "attack") {
      const attack = project.weapons.list.find((w) => w.id === a)?.attacks.find((x) => x.id === b);
      if (attack) void run([{ name: "setWeaponAttack", input: { weaponId: a, attack: { ...attack, clip: clipId } } }]);
    }
  };

  const targets = isObject ? [] : [
    ...states.filter((s) => asset.stateClips[s.state] !== clipId).map((s) => ({ id: `state:${s.state}`, label: `${s.character.name} ▸ ${s.state} state${asset.stateClips[s.state] ? ` (now ${asset.stateClips[s.state]})` : ""}` })),
    ...project.weapons.list.flatMap((w) => w.attacks.filter((a) => a.clip !== clipId).map((a) => ({ id: `attack:${w.id}:${a.id}`, label: `${w.name} ▸ ${a.name}${a.clip ? ` (now ${a.clip})` : ""}` }))),
  ];

  return (
    <section className="anim-detail" data-testid="clip-detail" aria-label={`${clipId} animation`}>
      <div className="anim-detail-head">
        <input
          className="art-text anim-name"
          aria-label="animation name"
          value={name}
          disabled={locked}
          title={slot ? "A standard slot: the runtime plays it by situation. Renamed, it plays only where attached." : "Rename"}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setName(clipId);
          }}
        />
        <span className="muted">
          {clip.duration}s{clip.loop ? " loop" : " once"} · {isObject ? "plays where the game names it" : slot ? CLIP_SLOTS[clipId as keyof typeof CLIP_SLOTS] : "named: plays where it is attached"}
        </span>
      </div>
      <textarea
        className="art-text"
        aria-label="animation direction"
        rows={2}
        placeholder="Direction (e.g. a heavy overhead chop, the whole body leaning in)"
        value={direction}
        disabled={busy}
        onChange={(e) => setDirection(e.target.value)}
      />
      <div className="art-actions">
        <button
          type="button"
          disabled={busy || !art.available || locked || (!canAnimateOneClip && !slot)}
          title={canAnimateOneClip ? `Animate ${clipId} again from the direction` : slot ? "Re-animates every slot with this direction (single-clip redo arrives with the animation update)" : "Redoing a named clip arrives with the animation update"}
          onClick={redo}
        >
          {canAnimateOneClip ? "Redo" : "Redo (all slots)"}
        </button>
        <button type="button" disabled={locked} onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" disabled={locked} onClick={() => void remove()}>
          Delete
        </button>
      </div>
      <div className="anim-attach">
        <span className="anim-caption">Plays in</span>
        {isObject && objectPlays.length === 0 && <span className="muted">nothing names it yet (a prop's idle, playAnimation, spawnEffect, a projectile look)</span>}
        {objectPlays.map((u) => (
          <span key={u.path} className="anim-chip" data-testid="clip-use">
            {u.what}
          </span>
        ))}
        {!isObject && attached.length === 0 && attacks.length === 0 && <span className="muted">{slot ? "its slot's situations" : "nothing yet: attach it"}</span>}
        {attached.map((s) => (
          <span key={s.state} className="anim-chip" data-testid={`attached-state-${s.state}`}>
            {s.character.name} ▸ {s.state}
            <button type="button" aria-label={`detach from ${s.state}`} disabled={locked} onClick={() => void run([{ name: "setStateClip", input: { assetId: asset.id, stateId: s.state, clipId: null } }])}>
              ×
            </button>
          </span>
        ))}
        {attacks.map(({ weapon, attack }) => (
          <span key={`${weapon.id}:${attack.id}`} className="anim-chip" data-testid={`attached-attack-${weapon.id}-${attack.id}`}>
            {weapon.name} ▸ {attack.name}
            <button type="button" aria-label={`detach from ${attack.name}`} disabled={locked} onClick={() => void run([{ name: "setWeaponAttack", input: { weaponId: weapon.id, attack: { ...attack, clip: null } } }])}>
              ×
            </button>
          </span>
        ))}
        {targets.length > 0 && (
          <select aria-label="attach to" value="" disabled={locked} onChange={(e) => e.target.value && attach(e.target.value)}>
            <option value="">Attach to…</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <MarkerTimeline key={`${asset.id}:${clipId}`} assetId={asset.id} clipId={clipId} clip={clip} locked={locked} run={run} />
    </section>
  );
}

function AddAnimation({ asset, subject, art, session, busy, locked, run, onAdded }: {
  asset: CharacterAsset;
  subject: ArtSubject;
  art: ArtState;
  session: Session;
  busy: boolean;
  locked: boolean;
  run: Run;
  onAdded: (clipId: string) => void;
}) {
  const [name, setName] = useState("");
  const [direction, setDirection] = useState("");
  const [from, setFrom] = useState("idle");
  const id = slugify(name, "");
  const taken = Boolean(id && asset.clips[id]);
  const base = asset.clips[from] ? from : (Object.keys(asset.clips)[0] ?? null);

  const add = async () => {
    if (!id || taken) return;
    if (canAnimateOneClip) {
      if (await session.startArtJob(animateClipRequest(subjectRef(subject), id, direction))) {
        setName("");
        setDirection("");
      }
      return;
    }
    // Until named animation lands: the new clip starts as a copy (keeping the direction to redo it), ready to attach.
    if (!base) return;
    const clip: Clip = { ...asset.clips[base]!, ...(direction.trim() ? { direction: direction.trim() } : {}) };
    if (await run([{ name: "setClip", input: { assetId: asset.id, clipId: id, clip } }])) {
      setName("");
      setDirection("");
      onAdded(id);
    }
  };

  return (
    <details className="anim-add" data-testid="add-animation">
      <summary>+ Add an animation</summary>
      <input className="art-text" aria-label="new animation name" placeholder="Name (e.g. overhead_chop)" value={name} onChange={(e) => setName(e.target.value)} />
      {taken && <p className="field-error">{subject.name} already has “{id}”.</p>}
      <textarea className="art-text" aria-label="new animation direction" rows={2} placeholder="What it should look like" value={direction} onChange={(e) => setDirection(e.target.value)} />
      {!canAnimateOneClip && (
        <label className="anim-from">
          Starts as a copy of
          <select aria-label="copy of" value={base ?? ""} onChange={(e) => setFrom(e.target.value)}>
            {Object.keys(asset.clips).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="art-actions">
        <button type="button" disabled={locked || busy || !id || taken || (canAnimateOneClip ? !art.available : !base)} onClick={() => void add()}>
          {canAnimateOneClip ? "Animate it" : "Add"}
        </button>
      </div>
      {!canAnimateOneClip && <p className="hint">Animating a named clip from its direction arrives with the animation update; for now it starts as a copy you can attach, and keeps the direction for then.</p>}
    </details>
  );
}
