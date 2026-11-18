import { useState } from "react";
import {
  HitShape,
  MAX_ATTACKS_PER_WEAPON,
  MAX_WEAPONS,
  slugify,
  uniqueId,
  WeaponAttack,
  type ChangeResult,
  type ProjectSpec,
  type Weapon,
  type WeaponArt,
} from "@anomaly/core";
import type { Session } from "../session.ts";
import { fileUrl } from "../api.ts";
import { askConfirm } from "../ui/confirm.tsx";
import { ArtJobButton } from "../ArtJobButton.tsx";
import { canDrawWeapons, weaponArtRequest } from "../artStages.ts";
import { Cell, Num, Pick, Swatch, Text } from "./fields.tsx";
import "./weapons.css";

type Attack = WeaponAttack;
type ShapeType = HitShape["type"];

const SHAPES: { id: ShapeType; label: string }[] = [
  { id: "arc", label: "Arc (a swing)" },
  { id: "box", label: "Box (a jab, a bash)" },
  { id: "thrust", label: "Thrust (a stab)" },
  { id: "projectile", label: "Projectile (fires)" },
];

/** A shape of a new type, with sensible sizes (a switch keeps nothing of the old one). */
const shapeOf = (type: ShapeType): HitShape =>
  HitShape.parse(
    {
      arc: { type, radius: 60 },
      box: { type, width: 50, height: 40, offset: [20, 0] },
      thrust: { type, length: 80 },
      projectile: { type },
    }[type],
  );

const AIMS = [
  { id: "forward", label: "forward" },
  { id: "up", label: "up" },
  { id: "down", label: "down (in the air)" },
  { id: "any", label: "any" },
] as const;
const WHERE = [
  { id: "both", label: "ground or air" },
  { id: "ground", label: "on the ground" },
  { id: "air", label: "in the air" },
] as const;

/**
 * Game tab: the game's weapons. A weapon is attacks plus art; each attack's trigger, hit shape,
 * damage, timing, movement, combo, ammo and clip are edited here, one operation per change
 * (createWeapon, updateWeapon, setWeaponAttack, deleteWeaponAttack, deleteWeapon).
 */
/** `onOpenWiki`: open a wiki page (a weapon's page links to it: `WikiPage.weaponId`). */
export function WeaponsPanel({ project, session, locked, onOpenWiki }: { project: ProjectSpec; session: Session; locked: boolean; onOpenWiki?: (pageId: string) => void }) {
  const { list } = project.weapons;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const weapon = list.find((w) => w.id === selectedId) ?? list[0] ?? null;

  const run = async (op: string, input: unknown): Promise<ChangeResult> => {
    const result = await session.applyOperation(op, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result;
  };

  const create = async () => {
    const text = name.trim();
    if (!text) return;
    const id = uniqueId(slugify(text, "weapon"), list.map((w) => w.id));
    if ((await run("createWeapon", { id, name: text })).ok) {
      setName("");
      setSelectedId(id);
    }
  };

  return (
    <div className="weapons-panel" data-testid="weapons-panel">
      <p className="hint">Weapons are attacks plus their art. Put one in a loadout slot (below) for the player, or give it with a handler (giveWeapon); enemies use one with the useWeapon action.</p>
      <div className="modal-list" role="list" aria-label="Weapons">
        {list.map((w) => (
          <button key={w.id} type="button" role="listitem" className={w === weapon ? "modal-chip selected" : "modal-chip"} aria-pressed={w === weapon} onClick={() => setSelectedId(w.id)}>
            {w.name}
            <small className="wpn-chip-count">{w.attacks.length}</small>
          </button>
        ))}
      </div>
      <div className="list-actions items-add">
        <input
          className="art-text"
          aria-label="new weapon name"
          placeholder="New weapon name"
          value={name}
          disabled={locked || list.length >= MAX_WEAPONS}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
        />
        <button type="button" disabled={locked || !name.trim() || list.length >= MAX_WEAPONS} onClick={() => void create()}>
          + Weapon
        </button>
      </div>
      {weapon ? (
        <WeaponEditor key={weapon.id} weapon={weapon} project={project} session={session} locked={locked} run={run} onOpenWiki={onOpenWiki} />
      ) : (
        <p className="hint">No weapons yet: the player uses the built-in attack (their stats).</p>
      )}
    </div>
  );
}

type Run = (op: string, input: unknown) => Promise<ChangeResult>;

function WeaponEditor({ weapon, project, session, locked, run, onOpenWiki }: { weapon: Weapon; project: ProjectSpec; session: Session; locked: boolean; run: Run; onOpenWiki?: (pageId: string) => void }) {
  const wikiPage = project.wiki.pages.find((p) => p.weaponId === weapon.id);
  const [open, setOpen] = useState<string | null>(weapon.attacks[0]?.id ?? null);
  const update = (changes: { name?: string; description?: string; art?: Partial<WeaponArt> }) => void run("updateWeapon", { weaponId: weapon.id, ...changes });
  const setAttack = (attack: Attack) => void run("setWeaponAttack", { weaponId: weapon.id, attack });
  const slots = project.weapons.loadout.slots.filter((s) => s.start === weapon.id);

  const remove = async () => {
    const message = slots.length ? `${slots.map((s) => s.label).join(" and ")} start${slots.length === 1 ? "s" : ""} empty then. Undo can restore it.` : "Undo can restore it.";
    if (await askConfirm({ title: `Delete ${weapon.name}?`, message, confirmLabel: "Delete", danger: true })) void run("deleteWeapon", { weaponId: weapon.id });
  };

  const addAttack = async () => {
    const id = uniqueId("attack", weapon.attacks.map((a) => a.id));
    const attack = WeaponAttack.parse({ id, name: weapon.attacks.length ? `Attack ${weapon.attacks.length + 1}` : "Attack", shape: shapeOf("arc") });
    if ((await run("setWeaponAttack", { weaponId: weapon.id, attack })).ok) setOpen(id);
  };

  const { art } = weapon;
  return (
    <div className="wpn-editor" data-testid={`weapon-${weapon.id}`}>
      <div className="modal-editor-head">
        <code>{weapon.id}</code>
        {wikiPage && onOpenWiki && (
          <button type="button" className="wiki-link" title={`Open “${wikiPage.title}” in the wiki`} onClick={() => onOpenWiki(wikiPage.id)}>
            Wiki page →
          </button>
        )}
        <button type="button" disabled={locked} onClick={() => void remove()}>
          Delete
        </button>
      </div>
      <div className="wpn-grid">
        <Cell label="Name">
          <Text label="weapon name" value={weapon.name} required maxLength={60} disabled={locked} onCommit={(name) => update({ name })} />
        </Cell>
        <Cell label="Description" wide>
          <Text label="weapon description" value={weapon.description} maxLength={400} placeholder="What it is, in the game (optional)" disabled={locked} onCommit={(description) => update({ description })} />
        </Cell>
      </div>

      <h4 className="wpn-heading">Art</h4>
      <div className="wpn-art">
        <div className="wpn-sprite" data-testid="weapon-sprite">
          {art.sprite ? <img src={fileUrl(art.sprite)} alt={`${weapon.name} sprite`} /> : <span className="hint">not drawn yet</span>}
        </div>
        <div className="wpn-grid">
          <Cell label="Looks like" wide>
            <Text label="weapon brief" multiline value={art.brief} maxLength={400} placeholder="e.g. a chipped bronze sickle on a short bone handle" disabled={locked} onCommit={(brief) => update({ art: { brief } })} />
          </Cell>
          <div className="wpn-cell wide wpn-readonly" title="Set when the weapon is drawn">
            <span className="wpn-caption">Held at</span>
            <span>
              grip ({art.grip.join(", ")}) · tip ({art.tip.join(", ")}) · scale {art.scale}
            </span>
          </div>
          <div className="wpn-cell wide">
            {canDrawWeapons ? (
              <ArtJobButton
                session={session}
                request={weaponArtRequest(weapon.id)}
                label={art.sprite ? "🎨 Draw it again" : "🎨 Draw it"}
                cost="$0.01: one sprite from the brief, its grip and tip found"
                locked={locked}
                nothing={!art.brief.trim() && !weapon.description.trim() ? "Say what it looks like first" : undefined}
              />
            ) : (
              <button type="button" disabled title="Drawing weapons arrives with the weapon art update">
                🎨 Draw it (coming soon)
              </button>
            )}
          </div>
          <Cell label="Trail" title="Drawn behind the tip while an attack is active (width 0 = none)">
            <span className="wpn-inline">
              <Swatch label="trail colour" value={art.trail.color} disabled={locked} onCommit={(color) => update({ art: { trail: { ...art.trail, color } } })} />
              <Num label="trail width" value={art.trail.width} min={0} max={64} disabled={locked} onCommit={(width) => update({ art: { trail: { ...art.trail, width } } })} />
              <span className="unit">px</span>
              <Num label="trail seconds" value={art.trail.seconds} min={0} max={1} step={0.01} disabled={locked} onCommit={(seconds) => update({ art: { trail: { ...art.trail, seconds } } })} />
              <span className="unit">s</span>
            </span>
          </Cell>
          <Cell label="Hit spark">
            <Swatch label="spark colour" value={art.spark} disabled={locked} onCommit={(spark) => update({ art: { spark } })} />
          </Cell>
        </div>
      </div>

      <h4 className="wpn-heading">
        Attacks <span className="muted">{weapon.attacks.length === 0 ? "none: it does nothing yet" : `${weapon.attacks.length}`}</span>
      </h4>
      {weapon.attacks.map((attack) => (
        <AttackEditor
          key={attack.id}
          attack={attack}
          weapon={weapon}
          project={project}
          open={open === attack.id}
          onToggle={() => setOpen(open === attack.id ? null : attack.id)}
          locked={locked}
          onChange={setAttack}
          onDelete={async () => {
            if (await askConfirm({ title: `Delete the attack ${attack.name}?`, message: "Combos into it end there. Undo can restore it.", confirmLabel: "Delete", danger: true })) {
              void run("deleteWeaponAttack", { weaponId: weapon.id, attackId: attack.id });
            }
          }}
        />
      ))}
      <button type="button" className="link-button" disabled={locked || weapon.attacks.length >= MAX_ATTACKS_PER_WEAPON} onClick={() => void addAttack()}>
        + Attack
      </button>
    </div>
  );
}

/** What the attack does, in a few words (the folded card's summary). */
function attackSummary(a: Attack): string {
  const s = a.shape;
  const shape = s.type === "arc" ? `arc ${s.radius}px` : s.type === "box" ? `box ${s.width}×${s.height}` : s.type === "thrust" ? `thrust ${s.length}px` : `${s.projectile.count > 1 ? `${s.projectile.count} ` : ""}projectile${s.projectile.count > 1 ? "s" : ""}`;
  const aim = a.trigger.aim === "forward" ? "" : ` · aim ${a.trigger.aim}`;
  return `${shape} · ${a.damage} dmg${aim}${a.trigger.hold > 0 ? ` · hold ${a.trigger.hold}s` : ""}`;
}

/** Clip names the wielders could have: the player's first, then every character's. */
function clipChoices(project: ProjectSpec): string[] {
  const player = project.characters.find((c) => c.kind === "player");
  const names: string[] = [];
  const add = (assetId: string | undefined) => {
    const asset = project.art.assets.find((a) => a.id === assetId);
    if (asset?.kind === "character") names.push(...Object.keys(asset.clips));
  };
  add(player?.appearance);
  project.art.assets.forEach((a) => add(a.id));
  return [...new Set(names)];
}

function AttackEditor({
  attack,
  weapon,
  project,
  open,
  onToggle,
  locked,
  onChange,
  onDelete,
}: {
  attack: Attack;
  weapon: Weapon;
  project: ProjectSpec;
  open: boolean;
  onToggle: () => void;
  locked: boolean;
  onChange: (attack: Attack) => void;
  onDelete: () => void;
}) {
  const set = (changes: Partial<Attack>) => onChange({ ...attack, ...changes });
  const shape = attack.shape;
  const setShape = (changes: Record<string, unknown>) => set({ shape: { ...shape, ...changes } as HitShape });
  const { items } = project.world;
  const clips = clipChoices(project);
  const clipOptions = [{ id: "", label: "(the attack slots, by phase)" }, ...[...new Set([...clips, ...(attack.clip ? [attack.clip] : [])])].map((c) => ({ id: c, label: c }))];
  const n = (label: string, value: number, min: number, max: number, onCommit: (v: number) => void, step = 1, unit?: string, title?: string) => (
    <Cell label={label} title={title}>
      <span className="wpn-inline">
        <Num label={`${attack.id} ${label}`} value={value} min={min} max={max} step={step} disabled={locked} onCommit={onCommit} />
        {unit && <span className="unit">{unit}</span>}
      </span>
    </Cell>
  );

  return (
    <section className={`wpn-attack${open ? " open" : ""}`} data-testid={`attack-${attack.id}`}>
      <h5 className="wpn-attack-head">
        <button type="button" aria-expanded={open} onClick={onToggle}>
          <span className="caret" aria-hidden />
          <span className="wpn-attack-name">{attack.name}</span>
          <span className="wpn-attack-summary">{attackSummary(attack)}</span>
        </button>
      </h5>
      {open && (
        <div className="wpn-attack-body">
          <div className="wpn-grid">
            <Cell label="Name">
              <Text label={`${attack.id} name`} value={attack.name} required maxLength={60} disabled={locked} onCommit={(name) => set({ name })} />
            </Cell>
            <Cell label="Aim" title="The aim held when pressed">
              <Pick label={`${attack.id} aim`} value={attack.trigger.aim} options={AIMS} disabled={locked} onPick={(aim) => set({ trigger: { ...attack.trigger, aim } })} />
            </Cell>
            <Cell label="Where">
              <Pick label={`${attack.id} where`} value={attack.trigger.where} options={WHERE} disabled={locked} onPick={(where) => set({ trigger: { ...attack.trigger, where } })} />
            </Cell>
            {n("Hold", attack.trigger.hold, 0, 5, (hold) => set({ trigger: { ...attack.trigger, hold } }), 0.05, "s", "Seconds the button is held first (0 = tap): a charged attack")}
          </div>

          <h6 className="wpn-sub">Hit</h6>
          <div className="wpn-grid">
            <Cell label="Shape">
              <Pick label={`${attack.id} shape`} value={shape.type} options={SHAPES} disabled={locked} onPick={(type) => type !== shape.type && set({ shape: shapeOf(type) })} />
            </Cell>
            {shape.type === "arc" && (
              <>
                {n("Radius", shape.radius, 0, 2000, (radius) => setShape({ radius }), 1, "px", "Reach from the wielder's centre")}
                {n("From", shape.from, -180, 180, (from) => setShape({ from }), 1, "°", "Start angle (negative = up)")}
                {n("To", shape.to, -180, 180, (to) => setShape({ to }), 1, "°", "End angle: the sweep runs from → to over the active window")}
              </>
            )}
            {shape.type === "box" && (
              <>
                {n("Width", shape.width, 0, 2000, (width) => setShape({ width }), 1, "px")}
                {n("Height", shape.height, 0, 2000, (height) => setShape({ height }), 1, "px")}
                {n("Ahead", shape.offset[0], -1000, 1000, (x) => setShape({ offset: [x, shape.offset[1]] }), 1, "px", "Box centre in front of the wielder's chest")}
                {n("Down", shape.offset[1], -1000, 1000, (y) => setShape({ offset: [shape.offset[0], y] }), 1, "px", "Box centre below the wielder's chest (negative = up)")}
              </>
            )}
            {shape.type === "thrust" && (
              <>
                {n("Length", shape.length, 0, 2000, (length) => setShape({ length }), 1, "px")}
                {n("Width", shape.width, 1, 400, (width) => setShape({ width }), 1, "px")}
              </>
            )}
            {shape.type === "projectile" && <ProjectileFields attack={attack} locked={locked} onChange={(projectile) => setShape({ projectile })} />}
            {n("Damage", attack.damage, 0, 999, (damage) => set({ damage }))}
            {n("Knockback", attack.knockback, 0, 3000, (knockback) => set({ knockback }), 10, "px/s")}
            {n("Hit stop", attack.hitStop, 0, 1, (hitStop) => set({ hitStop }), 0.01, "s", "The action freezes this long on a hit")}
            {n("Shake", attack.shake, 0, 32, (shake) => set({ shake }), 1, "px", "Camera shake on a hit")}
          </div>

          <h6 className="wpn-sub">Timing</h6>
          <div className="wpn-grid">
            {n("Windup", attack.timing.windup, 0, 10, (windup) => set({ timing: { ...attack.timing, windup } }), 0.01, "s")}
            {n("Active", attack.timing.active, 0, 10, (active) => set({ timing: { ...attack.timing, active } }), 0.01, "s", "The hit shape is live only now")}
            {n("Recovery", attack.timing.recovery, 0, 10, (recovery) => set({ timing: { ...attack.timing, recovery } }), 0.01, "s")}
            {n("Cooldown", attack.cooldown, 0, 10, (cooldown) => set({ cooldown }), 0.01, "s", "After recovery, before it can start again")}
          </div>

          <h6 className="wpn-sub">Movement and combo</h6>
          <div className="wpn-grid">
            {n("Lunge", attack.movement.lunge, 0, 3000, (lunge) => set({ movement: { ...attack.movement, lunge } }), 10, "px/s", "Forward during the active window")}
            {n("Recoil", attack.movement.recoil, 0, 3000, (recoil) => set({ movement: { ...attack.movement, recoil } }), 10, "px/s", "Pushed back when it hits (or fires)")}
            <Cell label="Pogo" title="A hit while aiming down bounces the wielder up">
              <input type="checkbox" aria-label={`${attack.id} pogo`} checked={attack.movement.pogo} disabled={locked} onChange={(e) => set({ movement: { ...attack.movement, pogo: e.target.checked } })} />
            </Cell>
            <Cell label="Combo into" title="Used instead if pressed again within the window">
              <Pick
                label={`${attack.id} combo next`}
                value={attack.combo.next ?? ""}
                options={[{ id: "", label: "(none)" }, ...weapon.attacks.map((a) => ({ id: a.id, label: a.id === attack.id ? `${a.name} (itself)` : a.name }))]}
                disabled={locked}
                onPick={(next) => set({ combo: { ...attack.combo, next: next || null } })}
              />
            </Cell>
            {attack.combo.next !== null && n("Window", attack.combo.window, 0, 10, (window) => set({ combo: { ...attack.combo, window } }), 0.05, "s")}
          </div>

          <h6 className="wpn-sub">Ammo and animation</h6>
          <div className="wpn-grid">
            <Cell label="Ammo" title={items.length ? "Spend an item per use; with too few the attack doesn't start" : "The game has no items yet (Game ▸ Items)"}>
              <Pick
                label={`${attack.id} ammo`}
                value={attack.ammo?.item ?? ""}
                options={[{ id: "", label: "(none)" }, ...items.map((i) => ({ id: i.id, label: i.name }))]}
                disabled={locked}
                onPick={(item) => set({ ammo: item ? { item, per: attack.ammo?.per ?? 1 } : null })}
              />
            </Cell>
            {attack.ammo && n("Per use", attack.ammo.per, 1, 99, (per) => set({ ammo: { ...attack.ammo!, per } }))}
            <Cell label="Clip" title="The wielder's animation for it (Characters ▸ Animation); else the attack slots by phase">
              <Pick label={`${attack.id} clip`} value={attack.clip ?? ""} options={clipOptions} disabled={locked} onPick={(clip) => set({ clip: clip || null })} />
            </Cell>
          </div>
          <div className="wpn-attack-actions">
            <code>{attack.id}</code>
            <button type="button" disabled={locked} onClick={onDelete}>
              Delete attack
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ProjectileFields({ attack, locked, onChange }: { attack: Attack; locked: boolean; onChange: (p: Extract<HitShape, { type: "projectile" }>["projectile"]) => void }) {
  if (attack.shape.type !== "projectile") return null;
  const p = attack.shape.projectile;
  const field = (label: string, key: "speed" | "gravity" | "count" | "spread" | "lifetime" | "pierce" | "size", min: number, max: number, step = 1, unit?: string) => (
    <Cell label={label} key={key}>
      <span className="wpn-inline">
        <Num label={`${attack.id} ${label}`} value={p[key]} min={min} max={max} step={step} disabled={locked} onCommit={(v) => onChange({ ...p, [key]: v })} />
        {unit && <span className="unit">{unit}</span>}
      </span>
    </Cell>
  );
  return (
    <>
      {field("Speed", "speed", 0, 3000, 10, "px/s")}
      {field("Gravity", "gravity", 0, 4000, 10, "px/s²")}
      {field("Count", "count", 1, 8)}
      {field("Spread", "spread", 0, 180, 1, "°")}
      {field("Lifetime", "lifetime", 0.05, 10, 0.05, "s")}
      {field("Pierce", "pierce", 0, 20)}
      {field("Size", "size", 2, 200, 1, "px")}
      <Cell label="Colour">
        <Swatch label={`${attack.id} projectile colour`} value={p.color} disabled={locked} onCommit={(color) => onChange({ ...p, color })} />
      </Cell>
    </>
  );
}
