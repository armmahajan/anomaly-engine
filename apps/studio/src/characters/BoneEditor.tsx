import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { boneSubtree, MAX_BONES, MAX_GRIPS, slugify, uniqueId, type ArtDirection, type ChangeResult, type CharacterAsset, type Grip, type Rig } from "@anomaly/core";
import type { Session } from "../session.ts";
import { fileUrl } from "../api.ts";
import { askConfirm } from "../ui/confirm.tsx";
import { Num } from "../weapons/fields.tsx";
import { apply, blobPath, linePath, posedBones, stageMapping, turnAngle, type Mat, type Vec } from "./rigView.ts";
import "./characters.css";

/**
 * The bone editor (Characters ▸ Rig ▸ Edit bones): fix a rig by hand before animating. The panel
 * (left of the stage) lists the bones, the selected bone's parts and the rig's grips; handles over
 * the stage move joints (drag), turn a bone's resting angle (the turn handle), and place grips.
 * Every edit is one core operation (moveBonePivot, rotateBoneRest, scaleBone, reassignPart, addBone,
 * removeBone, setGrip, removeGrip), undoable. The pose test turns joints by mouse without saving.
 */

interface Props {
  asset: CharacterAsset & { rig: Rig };
  direction: ArtDirection;
  session: Session;
  locked: boolean;
  /** Pose test: degrees per bone (null = off). Lifted so the stage can show the rest pose meanwhile. */
  pose: Record<string, number> | null;
  setPose: (pose: Record<string, number> | null) => void;
}

/** The gesture in progress over the stage. */
type Drag =
  | { kind: "pivot"; bone: string; start: Vec; at: Vec; moved: boolean }
  | { kind: "turn"; bone: string; from: Vec; degrees: number }
  | { kind: "grip"; grip: string; at: Vec; moved: boolean }
  | { kind: "pose"; bone: string; from: Vec; base: number };

export function BoneEditor({ asset, direction, session, locked, pose, setPose }: Props) {
  const rig = asset.rig;
  const [selected, setSelected] = useState(rig.bones.find((b) => b.parent !== null)?.id ?? rig.bones[0]!.id);
  const [carry, setCarry] = useState(true);
  const [turn, setTurn] = useState(15);
  const [factor, setFactor] = useState(1.2);
  const [newBone, setNewBone] = useState("");
  const bone = rig.bones.find((b) => b.id === selected) ?? rig.bones[0]!;
  const cutout = rig.parts.some((p) => p.shape.type === "image");
  const movesImages = cutout && rig.parts.some((p) => boneSubtree(rig, bone.id).has(p.bone) && p.shape.type === "image");
  // Turning without carrying only swings joints, so cutout pieces don't stop it.
  const turnBlocked = movesImages && carry && !cutout;
  // Bones the selected one can trade places with (another limb, not on its chain); the near/far twin first.
  const swappable = rig.bones.filter((b) => b.parent !== null && bone.parent !== null && !boneSubtree(rig, bone.id).has(b.id) && !boneSubtree(rig, b.id).has(bone.id));
  const twin = bone.id.replace(/near|far/, (w) => (w === "near" ? "far" : "near"));
  const [swapWith, setSwapWith] = useState("");
  const swapTarget = swappable.some((b) => b.id === swapWith) ? swapWith : (swappable.find((b) => b.id === twin) ?? swappable[0])?.id ?? "";

  useEffect(() => {
    if (!rig.bones.some((b) => b.id === selected)) setSelected(rig.bones[0]!.id);
  }, [rig, selected]);

  const run = async (name: string, input: unknown): Promise<boolean> => {
    const result: ChangeResult = await session.applyOperation(name, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };
  const id = asset.id;
  const ops = {
    movePivot: (b: string, pivot: Vec, withCarry = carry) => run("moveBonePivot", { assetId: id, bone: b, pivot: round(pivot), carry: withCarry && !cutout }),
    turn: (b: string, degrees: number) => Math.abs(degrees) >= 0.5 && run("rotateBoneRest", { assetId: id, bone: b, degrees: Math.round(degrees * 10) / 10, carry: carry && !cutout }),
    setGrip: (grip: Grip) => run("setGrip", { assetId: id, grip: { ...grip, at: round(grip.at) } }),
  };

  const children = (parent: string | null, depth: number): { id: string; depth: number }[] =>
    rig.bones.filter((b) => b.parent === parent).flatMap((b) => [{ id: b.id, depth }, ...children(b.id, depth + 1)]);
  const tree = children(null, 0);
  const partsOn = rig.parts.filter((p) => p.bone === bone.id);
  const others = rig.parts.filter((p) => p.bone !== bone.id);
  const grips = rig.grips ?? [];

  const addBone = async () => {
    const base = slugify(newBone, "bone");
    const boneId = uniqueId(base, rig.bones.map((b) => b.id));
    if (await run("addBone", { assetId: id, bone: { id: boneId, parent: bone.id, pivot: round([bone.pivot[0] + 10, bone.pivot[1]]) } })) {
      setNewBone("");
      setSelected(boneId);
    }
  };
  const removeBone = async () => {
    const parent = bone.parent;
    if (parent === null) return;
    const ok = await askConfirm({
      title: `Remove the ${bone.id} bone?`,
      message: `Its parts and child bones go to ${parent}, and its animation tracks are dropped. Undo can restore it.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (ok && (await run("removeBone", { assetId: id, bone: bone.id }))) setSelected(parent);
  };
  const addGrip = () => {
    const gripId = grips.some((g) => g.id === "hand") ? uniqueId("grip", grips.map((g) => g.id)) : "hand";
    void ops.setGrip({ id: gripId, bone: bone.id, at: [bone.pivot[0], bone.pivot[1]], angle: 0 });
  };

  return (
    <div className="bone-editor" data-testid="bone-editor">
      <p className="hint">
        Drag a joint on the stage to move it{cutout ? "" : carry ? " (its drawing comes along)" : " (the drawing stays: only the turning point moves)"}; drag the blue
        round handle to turn the bone{carry && !cutout ? " and its drawing" : " (the drawing stays: only the joints under it swing round)"}; drag a grip ◆ to place it. Undo takes any edit back.
      </p>
      <div className="bone-row">
        <label title={cutout ? "Cutout parts show the design at its place, so only the turning point moves" : "Move the bone's drawing and the bones under it with the joint"}>
          <input type="checkbox" checked={carry && !cutout} disabled={cutout} onChange={(e) => setCarry(e.target.checked)} /> Carry the drawing
        </label>
        <label title="Turn joints by dragging them, without saving: see how the drawing bends">
          <input type="checkbox" aria-label="pose test" checked={pose !== null} onChange={(e) => setPose(e.target.checked ? {} : null)} /> Pose test
        </label>
        {pose && Object.keys(pose).length > 0 && (
          <button type="button" onClick={() => setPose({})}>
            Reset pose
          </button>
        )}
      </div>

      <h4>
        Bones <span className="muted">{rig.bones.length}</span>
      </h4>
      <ul className="bone-tree" aria-label="Bones">
        {tree.map((b) => (
          <li key={b.id}>
            <button type="button" aria-pressed={b.id === bone.id} style={{ paddingLeft: 6 + b.depth * 12 }} onClick={() => setSelected(b.id)} data-testid={`bone-${b.id}`}>
              {b.id}
              <small>{rig.parts.filter((p) => p.bone === b.id).length} parts</small>
            </button>
          </li>
        ))}
      </ul>

      <h4>
        {bone.id} <span className="muted">{bone.parent ? `under ${bone.parent}` : "root"}</span>
      </h4>
      <div className="bone-row">
        <label>
          Joint x
          <Num label="joint x" value={bone.pivot[0]} min={-1000} max={1000} step={0.5} disabled={locked} onCommit={(x) => void ops.movePivot(bone.id, [x, bone.pivot[1]])} />
        </label>
        <label>
          y
          <Num label="joint y" value={bone.pivot[1]} min={-1000} max={1000} step={0.5} disabled={locked} onCommit={(y) => void ops.movePivot(bone.id, [bone.pivot[0], y])} />
        </label>
      </div>
      <div className="bone-row">
        <label title="Turn the bone's resting angle, clockwise: with Carry the drawing, its drawing and the bones under it; without, only the joints under it">
          Turn
          <Num label="turn degrees" value={turn} min={-180} max={180} disabled={locked || turnBlocked} onCommit={setTurn} />°
        </label>
        <button type="button" disabled={locked || turnBlocked} onClick={() => void ops.turn(bone.id, turn)}>
          Turn
        </button>
        <label title="Make the limb longer or shorter: its drawing scales about the joint, the bones under it move along">
          Length ×
          <Num label="length factor" value={factor} min={0.25} max={4} step={0.05} disabled={locked || movesImages} onCommit={setFactor} />
        </label>
        <button type="button" disabled={locked || movesImages || factor === 1} onClick={() => void run("scaleBone", { assetId: id, bone: bone.id, factor })}>
          Scale
        </button>
      </div>
      {movesImages && <p className="hint">Cutout pieces show the design at their place: move joints (without carrying), reassign parts and add or remove bones instead.</p>}
      {swappable.length > 0 && (
        <div className="bone-row">
          <label title="For two limbs labelled the wrong way round (the near one planned as the far one): the two chains trade names and draw order; nothing moves">
            Swap with
            <select aria-label="swap with bone" value={swapTarget} disabled={locked} onChange={(e) => setSwapWith(e.target.value)}>
              {swappable.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.id}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={locked || !swapTarget} onClick={() => void run("swapBones", { assetId: id, a: bone.id, b: swapTarget })}>
            Swap
          </button>
        </div>
      )}

      <h4>
        Parts on {bone.id} <span className="muted">{partsOn.length}</span>
      </h4>
      <ul className="bone-parts" aria-label={`Parts on ${bone.id}`}>
        {partsOn.map((p) => (
          <li key={p.id}>
            <code title={`${p.shape.type}, z ${p.z}`}>{p.id}</code>
            <select aria-label={`${p.id} bone`} value={p.bone} disabled={locked} onChange={(e) => void run("reassignPart", { assetId: id, part: p.id, bone: e.target.value })}>
              {rig.bones.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.id === p.bone ? `on ${b.id}` : `→ ${b.id}`}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <select aria-label={`move a part to ${bone.id}`} value="" disabled={locked} onChange={(e) => e.target.value && void run("reassignPart", { assetId: id, part: e.target.value, bone: bone.id })}>
          <option value="">Move a part to {bone.id}…</option>
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id} (on {p.bone})
            </option>
          ))}
        </select>
      )}

      <div className="bone-row">
        <input className="art-text" aria-label="new bone name" placeholder="New bone name" value={newBone} disabled={locked} onChange={(e) => setNewBone(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void addBone()} />
        <button type="button" disabled={locked || rig.bones.length >= MAX_BONES} onClick={() => void addBone()}>
          + Child bone
        </button>
        <button type="button" disabled={locked || bone.parent === null} title={bone.parent === null ? "Every rig keeps its root bone" : undefined} onClick={() => void removeBone()}>
          Remove bone
        </button>
      </div>

      <h4>
        Grips <span className="muted">where weapons are held</span>
      </h4>
      <div className="bone-grips">
        {grips.length === 0 && <p className="hint">None: a weapon is held at the front of the body.</p>}
        {grips.map((g) => (
          <div key={g.id} className="bone-row" data-testid={`grip-${g.id}`}>
            <code>{g.id}</code>
            <select aria-label={`${g.id} grip bone`} value={g.bone} disabled={locked} onChange={(e) => void ops.setGrip({ ...g, bone: e.target.value })}>
              {rig.bones.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.id}
                </option>
              ))}
            </select>
            <label>
              at ({g.at.join(", ")}) angle
              <Num label={`${g.id} grip angle`} value={g.angle} min={-360} max={360} disabled={locked} onCommit={(angle) => void ops.setGrip({ ...g, angle })} />°
            </label>
            <button type="button" className="icon-button" aria-label={`remove grip ${g.id}`} disabled={locked} onClick={() => void run("removeGrip", { assetId: id, gripId: g.id })}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="link-button" disabled={locked || grips.length >= MAX_GRIPS} onClick={addGrip}>
          + Grip on {bone.id}
        </button>
      </div>

      <BoneOverlay rig={rig} direction={direction} selected={bone.id} onSelect={setSelected} locked={locked} pose={pose} setPose={setPose} carry={carry && !cutout} canTurn={!turnBlocked} ops={ops} />
    </div>
  );
}

const round = ([x, y]: readonly [number, number]): Vec => [Math.round(x * 2) / 2, Math.round(y * 2) / 2];

/** The handles over the stage (a portal into the runtime's viewport), and the posed rig during a pose test. */
function BoneOverlay({
  rig,
  direction,
  selected,
  onSelect,
  locked,
  pose,
  setPose,
  carry,
  canTurn,
  ops,
}: {
  rig: Rig;
  direction: ArtDirection;
  selected: string;
  onSelect: (bone: string) => void;
  locked: boolean;
  pose: Record<string, number> | null;
  setPose: (pose: Record<string, number> | null) => void;
  carry: boolean;
  /** The selected bone can turn (no cutout pieces under it). */
  canTurn: boolean;
  ops: { movePivot: (b: string, p: Vec, carry?: boolean) => unknown; turn: (b: string, degrees: number) => unknown; setGrip: (g: Grip) => unknown };
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  useEffect(() => setHost(document.querySelector<HTMLElement>("main.viewport")), []);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => setSize({ width: box.clientWidth, height: box.clientHeight }));
    observer.observe(box);
    return () => observer.disconnect();
  }, [host]);

  const map = useMemo(() => stageMapping(rig, size.width || 1, size.height || 1), [rig, size.width, size.height]);
  const posed = useMemo(() => posedBones(rig, pose ?? {}), [rig, pose]);
  if (!host) return null;

  const local = (e: ReactPointerEvent): Vec => {
    const r = boxRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const bones = new Map(rig.bones.map((b) => [b.id, b]));
  /** Where a bone's joint is drawn: its posed pivot (or the dragged spot). */
  const jointAt = (id: string): Vec => {
    if (drag?.kind === "pivot" && drag.bone === id) return map.toScreen(drag.at);
    const b = bones.get(id)!;
    return map.toScreen(apply(posed.get(id)!, b.pivot));
  };
  const sel = bones.get(selected);
  // The turn handle sits along the bone: toward its first child, else its parts' middle, else up.
  const handleDir = (() => {
    if (!sel) return [0, -1] as Vec;
    const child = rig.bones.find((b) => b.parent === sel.id);
    let target: Vec | null = child ? [child.pivot[0], child.pivot[1]] : null;
    if (!target) {
      const pts = rig.parts.filter((p) => p.bone === sel.id).flatMap((p) => (p.shape.type === "ellipse" ? [p.shape.center] : p.shape.points));
      if (pts.length) target = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    }
    const d: Vec = target ? [target[0] - sel.pivot[0], target[1] - sel.pivot[1]] : [0, -1];
    const len = Math.hypot(d[0], d[1]);
    return len < 0.5 ? ([0, -1] as Vec) : ([d[0] / len, d[1] / len] as Vec);
  })();
  const HANDLE = 46;

  const begin = (e: ReactPointerEvent, next: Drag) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).closest("svg")!.setPointerCapture(e.pointerId);
    setDrag(next);
  };
  const onJoint = (e: ReactPointerEvent, id: string) => {
    onSelect(id);
    const b = bones.get(id)!;
    if (pose) return begin(e, { kind: "pose", bone: id, from: local(e), base: pose[id] ?? 0 });
    if (locked) return;
    begin(e, { kind: "pivot", bone: id, start: [b.pivot[0], b.pivot[1]], at: [b.pivot[0], b.pivot[1]], moved: false });
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const at = local(e);
    if (drag.kind === "pivot") {
      const rigAt = map.toRig(at);
      const moved = drag.moved || Math.hypot(...(map.toScreen(drag.start).map((v, i) => v - at[i]!) as [number, number])) > 3;
      setDrag({ ...drag, at: rigAt, moved });
    } else if (drag.kind === "grip") {
      setDrag({ ...drag, at: map.toRig(at), moved: true });
    } else if (drag.kind === "turn") {
      const c = map.toScreen(bones.get(drag.bone)!.pivot);
      setDrag({ ...drag, degrees: turnAngle(c, drag.from, at) });
    } else {
      const c = jointAt(drag.bone);
      setPose({ ...pose, [drag.bone]: Math.round(drag.base + turnAngle(c, drag.from, at)) });
    }
  };
  const onUp = () => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (d.kind === "pivot" && d.moved) void ops.movePivot(d.bone, d.at, carry);
    if (d.kind === "turn") void ops.turn(d.bone, d.degrees);
    if (d.kind === "grip" && d.moved) {
      const g = rig.grips?.find((x) => x.id === d.grip);
      if (g) void ops.setGrip({ ...g, at: d.at });
    }
  };

  const parts = [...rig.parts].sort((a, b) => a.z - b.z);
  const source = rig.source;

  const overlay = (
    <div ref={boxRef} className="bone-overlay" data-testid="bone-overlay">
      <svg onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
        {pose && (
          <>
            <rect className="pose-backdrop" x={0} y={0} width="100%" height="100%" />
            <g transform={`matrix(${map.matrix.join(" ")})`} data-testid="pose-preview">
              <defs>
                {parts.map((p) =>
                  (p.shape.type === "image" && source) || p.shape.type === "mesh" ? (
                    <clipPath key={p.id} id={`pose-clip-${p.id}`}>
                      <path d={blobPath(p.shape.points, 0)} />
                    </clipPath>
                  ) : null,
                )}
              </defs>
              {parts.map((p) => (
                <g key={p.id} transform={`matrix(${(posed.get(p.bone) ?? ([1, 0, 0, 1, 0, 0] as Mat)).join(" ")})`} opacity={p.opacity}>
                  <PartShape part={p} direction={direction} source={source} />
                </g>
              ))}
            </g>
            <text className="pose-note" x={12} y={22}>
              Pose test: drag a joint to turn it (not saved)
            </text>
          </>
        )}
        {/* Bones: a line from each joint to its parent's. */}
        {rig.bones.map((b) =>
          b.parent === null ? null : (
            <line key={`l-${b.id}`} className={`bone-line${b.id === selected ? " selected" : ""}`} x1={jointAt(b.parent)[0]} y1={jointAt(b.parent)[1]} x2={jointAt(b.id)[0]} y2={jointAt(b.id)[1]} />
          ),
        )}
        {!pose && sel && canTurn && (() => {
          const c = map.toScreen(sel.pivot);
          const a = drag?.kind === "turn" ? (drag.degrees * Math.PI) / 180 : 0;
          const dir: Vec = [handleDir[0] * Math.cos(a) - handleDir[1] * Math.sin(a), handleDir[0] * Math.sin(a) + handleDir[1] * Math.cos(a)];
          const h: Vec = [c[0] + dir[0] * HANDLE, c[1] + dir[1] * HANDLE];
          return (
            <g>
              <line className="turn-line" x1={c[0]} y1={c[1]} x2={h[0]} y2={h[1]} />
              <circle
                className="turn-handle"
                cx={h[0]}
                cy={h[1]}
                r={6}
                data-testid="turn-handle"
                aria-label={`turn ${sel.id}`}
                onPointerDown={(e) => !locked && begin(e, { kind: "turn", bone: sel.id, from: local(e), degrees: 0 })}
              />
              {drag?.kind === "turn" && (
                <text className="bone-label" x={h[0] + 10} y={h[1]}>
                  {Math.round(drag.degrees)}°
                </text>
              )}
            </g>
          );
        })()}
        {rig.bones.map((b) => {
          const [x, y] = jointAt(b.id);
          const isSel = b.id === selected;
          return (
            <g key={`j-${b.id}`}>
              <circle
                className={`joint${isSel ? " selected" : ""}${drag?.kind === "pivot" && drag.bone === b.id ? " dragging" : ""}`}
                cx={x}
                cy={y}
                r={isSel ? 7 : 5}
                data-testid={`joint-${b.id}`}
                aria-label={`joint ${b.id}`}
                onPointerDown={(e) => onJoint(e, b.id)}
              />
              {isSel && (
                <text className="bone-label" x={x + 9} y={y - 9}>
                  {b.id}
                  {pose && pose[b.id] ? ` ${pose[b.id]}°` : ""}
                </text>
              )}
            </g>
          );
        })}
        {!pose &&
          (rig.grips ?? []).map((g) => {
            const [x, y] = map.toScreen(drag?.kind === "grip" && drag.grip === g.id ? drag.at : g.at);
            const a = (g.angle * Math.PI) / 180;
            return (
              <g key={`g-${g.id}`}>
                <line className="turn-line" x1={x} y1={y} x2={x + Math.cos(a) * 22} y2={y + Math.sin(a) * 22} />
                <path
                  className="grip"
                  d={`M${x},${y - 7}L${x + 7},${y}L${x},${y + 7}L${x - 7},${y}Z`}
                  data-testid={`grip-handle-${g.id}`}
                  aria-label={`grip ${g.id}`}
                  onPointerDown={(e) => !locked && begin(e, { kind: "grip", grip: g.id, at: [g.at[0], g.at[1]], moved: false })}
                />
              </g>
            );
          })}
      </svg>
    </div>
  );
  return createPortal(overlay, host);
}

/** One part drawn flat (fill, outline, taper ignored, no bending): enough to judge a pose. */
function PartShape({ part, direction, source }: { part: Rig["parts"][number]; direction: ArtDirection; source: Rig["source"] }) {
  const s = part.shape;
  const ink = part.ink > 0 ? { stroke: direction.ink, strokeWidth: direction.inkWidth * part.ink, strokeLinejoin: "round" as const } : {};
  switch (s.type) {
    case "blob":
      return <path d={blobPath(s.points, s.smooth)} fill={part.fill} {...ink} />;
    case "ellipse":
      return <ellipse cx={s.center[0]} cy={s.center[1]} rx={s.rx} ry={s.ry} transform={`rotate(${s.rotation} ${s.center[0]} ${s.center[1]})`} fill={part.fill} {...ink} />;
    case "stroke":
      return <path d={linePath(s.points, s.smooth)} fill="none" stroke={part.fill} strokeWidth={((s.widthEnd ?? s.width) + s.width) / 2} strokeLinecap="round" strokeLinejoin="round" />;
    case "image":
      return source ? (
        <SourceImage clip={`pose-clip-${part.id}`} source={source} />
      ) : (
        <path d={blobPath(s.points, 0)} fill={part.fill} />
      );
    case "mesh":
      // The rest pose only (no bending), so the texture's rect mapping places the layer exactly enough.
      return part.texture ? <MeshLayer clip={`pose-clip-${part.id}`} texture={part.texture} /> : null;
  }
}

/** An image's natural size once it has loaded (null until then). */
function useImageSize(href: string): { w: number; h: number } | null {
  const [size, setSize] = useState<{ href: string; w: number; h: number } | null>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setSize({ href, w: img.naturalWidth, h: img.naturalHeight });
    img.src = href;
  }, [href]);
  return size?.href === href ? size : null;
}

/** The cutout source, placed in rig space (rig = (image px - anchor) * scale), shown through a part's polygon. */
function SourceImage({ clip, source }: { clip: string; source: NonNullable<Rig["source"]> }) {
  const href = fileUrl(source.file);
  const size = useImageSize(href);
  if (!size) return null;
  return <image href={href} x={-source.anchor[0] * source.scale} y={-source.anchor[1] * source.scale} width={size.w * source.scale} height={size.h * source.scale} clipPath={`url(#${clip})`} />;
}

/** A mesh part's painted layer: its texture region (`uv`) stretched over its rest rect, inside the mesh outline. */
function MeshLayer({ clip, texture }: { clip: string; texture: NonNullable<Rig["parts"][number]["texture"]> }) {
  const href = fileUrl(texture.file);
  const size = useImageSize(href);
  if (!size) return null;
  const [x, y, w, h] = texture.rect;
  const [u, v, uw, vh] = texture.uv;
  const sx = w / uw;
  const sy = h / vh;
  return (
    <image
      href={href}
      data-testid="pose-mesh"
      x={x - u * sx}
      y={y - v * sy}
      width={size.w * sx}
      height={size.h * sy}
      preserveAspectRatio="none"
      opacity={texture.opacity}
      clipPath={`url(#${clip})`}
    />
  );
}
