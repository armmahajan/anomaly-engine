import { useEffect, useRef } from "react";
import { roomLinks, uniqueId, type ArchitectState, type ProjectSpec, type RoomContent, type RoomLink, type RoomPlan, type RoomTerrain } from "@anomaly/core";
import type { Session } from "../session.ts";
import { DraftText, IdToggles, NumberInput, Slider } from "./fields.tsx";
import { showRoom, startRun, toggleRoom } from "./ui.ts";

/**
 * One planned room: a one-line summary that opens into its whole plan (size,
 * terrain knobs, contents, notes, seed, links) and its actions (pin, rebuild,
 * open the built room). Pinned rooms are the creator's: shown read-only.
 */

export type Run = (name: string, input: unknown) => Promise<boolean>;

const TERRAIN: { key: keyof RoomTerrain; label: string; hint: string }[] = [
  { key: "verticality", label: "Verticality", hint: "How much of the room is climbing or dropping." },
  { key: "hazards", label: "Hazards", hint: "Spikes and pits." },
  { key: "density", label: "Density", hint: "How many platforms and obstacles." },
  { key: "open", label: "Open floor", hint: "Wide open floor (room to fight)." },
];

const SIDES = ["left", "right", "top", "bottom"] as const;
const ID = /^[a-z][a-z0-9_]*$/;

/** Rooms are measured in screens: 30 x 14 tiles is about one. */
export function screens(cols: number, rows: number): number {
  return (cols / 30) * (rows / 14);
}

export function screensText(n: number): string {
  const rounded = Math.max(0.5, Math.round(n * 2) / 2);
  return `about ${rounded} screen${rounded === 1 ? "" : "s"}`;
}

interface Props {
  room: RoomPlan;
  project: ProjectSpec;
  architect: ArchitectState;
  session: Session;
  run: Run;
  expanded: boolean;
  focusNonce: number | null;
  /** Edits refused (playtest, AI at work). */
  locked: boolean;
  onOpenRoom?: (roomId: string) => void;
}

export function RoomCard({ room, project, architect, session, run, expanded, focusNonce, locked, onOpenRoom }: Props) {
  const ref = useRef<HTMLElement>(null);
  const ro = locked || room.pinned;
  const update = (changes: Record<string, unknown>) => run("updateRoomPlan", { roomId: room.id, changes });
  const built = project.world.rooms.some((r) => r.id === room.id);
  const rebuilding = architect.running?.rooms?.includes(room.id) ?? false;
  const abilities = project.progression.abilities.map((a) => ({ id: a.id, name: a.name }));
  const abilityName = (id: string) => abilities.find((a) => a.id === id)?.name ?? id;
  const characterName = (id: string) => project.characters.find((c) => c.id === id)?.name ?? id;

  // Asked for (an issue, a link): bring it into view.
  useEffect(() => {
    if (focusNonce !== null) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusNonce]);

  const summary = room.contents.map((c, i) => <ContentChip key={i} content={c} characterName={characterName} abilityName={abilityName} />);

  return (
    <article
      ref={ref}
      className={`room-card${room.pinned ? " pinned" : ""}${expanded ? " open" : ""}${focusNonce !== null ? " focused" : ""}${rebuilding ? " rebuilding" : ""}`}
      data-testid={`room-card-${room.id}`}
    >
      <header className="room-card-head">
        <button type="button" className="room-card-toggle" aria-expanded={expanded} onClick={() => toggleRoom(room.id)}>
          <span className="room-card-caret">{expanded ? "▾" : "▸"}</span>
          <span className="room-card-name">{room.name}</span>
          <span className="room-card-size">
            {room.cols}×{room.rows}
          </span>
        </button>
        <span className="room-card-summary">{summary}</span>
        {built && <span className="tag canon" title="The world room exists">built</span>}
        {rebuilding && <span className="tag">rebuilding…</span>}
        <button
          type="button"
          className={`room-pin${room.pinned ? " on" : ""}`}
          aria-pressed={room.pinned}
          disabled={locked}
          title={room.pinned ? "Pinned: yours. No stage changes its plan or its room. Click to hand it back to the Architect." : "Pin: keep this room as it is; no stage rewrites it"}
          onClick={() => void run("setRoomPinned", { roomId: room.id, pinned: !room.pinned })}
        >
          {room.pinned ? "Pinned" : "Pin"}
        </button>
      </header>
      {expanded && (
        <div className="room-card-body">
          {room.pinned && <p className="room-pinned-note">Pinned: this room is yours. The Architect leaves its plan and its built room alone. Unpin it to edit.</p>}
          <div className="room-row">
            <DraftText className="grow" caption="Name" label="Room name" value={room.name} disabled={ro} maxLength={80} onCommit={(name) => (name.trim() ? update({ name: name.trim() }) : false)} />
            <label className="arch-field">
              <span className="arch-caption">Region</span>
              <select aria-label="Region" value={room.regionId} disabled={ro} onChange={(e) => void update({ regionId: e.target.value })}>
                {project.progression.regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
                {!project.progression.regions.some((r) => r.id === room.regionId) && <option value={room.regionId}>{room.regionId}</option>}
              </select>
            </label>
          </div>
          <div className="room-row room-size">
            <span className="arch-caption">Size</span>
            <NumberInput label="Width in tiles" value={room.cols} min={16} max={240} disabled={ro} onCommit={(cols) => update({ cols })} />
            <span>×</span>
            <NumberInput label="Height in tiles" value={room.rows} min={10} max={135} disabled={ro} onCommit={(rows) => update({ rows })} />
            <span className="hint" data-testid="room-screens">
              tiles, {screensText(screens(room.cols, room.rows))}
            </span>
            {room.at && (
              <span className="hint">
                at {room.at.x}, {room.at.y}
              </span>
            )}
          </div>
          <div className="room-terrain">
            {TERRAIN.map((t) => (
              <Slider key={t.key} label={t.label} hint={t.hint} value={room.terrain[t.key]} disabled={ro} onCommit={(v) => update({ terrain: { [t.key]: v } })} />
            ))}
          </div>
          <ContentsEditor room={room} project={project} ro={ro} update={update} />
          <DraftText
            multiline
            caption="Notes"
            label="Room notes"
            value={room.notes}
            disabled={ro}
            maxLength={2000}
            placeholder="What this room is for, how it should feel, anything the Architect must keep…"
            onCommit={(notes) => update({ notes })}
          />
          <div className="room-row">
            <span className="arch-caption">Seed</span>
            <NumberInput label="Seed" value={room.seed} min={0} max={999_999} disabled={ro} onCommit={(seed) => update({ seed })} />
            <button type="button" className="arch-mini" disabled={ro} title="Another room from the same plan" onClick={() => void update({ seed: Math.floor(Math.random() * 1_000_000) })}>
              ↻ Reroll
            </button>
          </div>
          <LinksEditor room={room} project={project} ro={ro} run={run} abilities={abilities} />
          <div className="room-actions">
            <button
              type="button"
              disabled={locked || room.pinned || session.aiBusy()}
              title={room.pinned ? "Pinned rooms are never rebuilt" : "Build this room again from its plan (geometry onward)"}
              onClick={() => void startRun(session, { from: "geometry", rooms: [room.id] })}
            >
              Rebuild this room
            </button>
            {built && onOpenRoom && (
              <button type="button" onClick={() => onOpenRoom(room.id)}>
                Open in Rooms
              </button>
            )}
            <button type="button" className="room-delete" disabled={ro} onClick={() => void run("deleteRoomPlan", { roomId: room.id })}>
              Delete room
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function ContentChip({ content: c, characterName, abilityName }: { content: RoomContent; characterName: (id: string) => string; abilityName: (id: string) => string }) {
  switch (c.kind) {
    case "enemy":
      return (
        <span className={`content-chip enemy${c.lockRoom ? " lock" : ""}`}>
          ☠ {characterName(c.characterId)}
          {c.count > 1 ? ` ×${c.count}` : ""}
          {c.grants.length > 0 && ` → ${c.grants.map(abilityName).join(", ")}`}
        </span>
      );
    case "pickup":
      return <span className="content-chip pickup">◆ {abilityName(c.grants)}</span>;
    case "save":
      return <span className="content-chip save">✚ save</span>;
    case "start":
      return <span className="content-chip start">▶ start</span>;
    case "ending":
      return <span className="content-chip ending">★ ending</span>;
  }
}

// --- contents ---------------------------------------------------------------

type Update = (changes: Record<string, unknown>) => Promise<boolean>;

function ContentsEditor({ room, project, ro, update }: { room: RoomPlan; project: ProjectSpec; ro: boolean; update: Update }) {
  const contents = room.contents;
  const abilities = project.progression.abilities;
  const region = project.progression.regions.find((r) => r.id === room.regionId);
  const enemies = project.characters.filter((c) => c.kind === "enemy");
  const save = (next: RoomContent[]) => update({ contents: next });
  const replace = (i: number, c: RoomContent) => save(contents.map((x, j) => (j === i ? c : x)));
  const remove = (i: number) => void save(contents.filter((_, j) => j !== i));
  const full = contents.length >= 24;

  const placed = new Set(project.architect.rooms.flatMap((r) => r.contents.flatMap((c) => (c.kind === "pickup" ? [c.grants] : c.kind === "enemy" ? c.grants : []))));
  const add = (c: RoomContent) => void save([...contents, c]);
  const newEnemy = (): RoomContent => ({
    kind: "enemy",
    characterId: region?.enemies.find((e) => e !== region.boss) ?? region?.enemies[0] ?? enemies[0]?.id ?? "enemy",
    count: 1,
    lockRoom: false,
    grants: [],
    healthBar: false,
  });
  const newPickup = (): RoomContent => ({ kind: "pickup", grants: (abilities.find((a) => !placed.has(a.id)) ?? abilities[0])!.id });

  return (
    <div className="room-contents" data-testid="room-contents">
      <span className="arch-caption">Contents</span>
      {contents.length === 0 && <p className="hint">Nothing here yet: an empty room to cross.</p>}
      <ul>
        {contents.map((c, i) => (
          <li key={i} className={`content-row ${c.kind}`} data-testid={`content-${c.kind}`}>
            {c.kind === "enemy" && <EnemyRow content={c} project={project} ro={ro} onChange={(next) => replace(i, next)} />}
            {c.kind === "pickup" && (
              <>
                <span className="content-kind">◆ Pickup</span>
                <select aria-label="Pickup grants" value={c.grants} disabled={ro} onChange={(e) => void replace(i, { ...c, grants: e.target.value })}>
                  {abilities.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                  {!abilities.some((a) => a.id === c.grants) && <option value={c.grants}>{c.grants}</option>}
                </select>
              </>
            )}
            {c.kind === "save" && (
              <>
                <span className="content-kind">✚ Save point</span>
                <DraftText className="grow" label="Save point note" placeholder="note (optional)" value={c.note ?? ""} disabled={ro} maxLength={200} onCommit={(note) => replace(i, note ? { ...c, note } : { kind: "save" })} />
              </>
            )}
            {c.kind === "start" && (
              <>
                <span className="content-kind">▶ Start</span>
                <span className="hint grow">The game starts here.</span>
              </>
            )}
            {c.kind === "ending" && (
              <>
                <span className="content-kind">★ Ending</span>
                <span className="hint grow">Reaching it ends the game.</span>
              </>
            )}
            <button type="button" className="arch-remove" aria-label={`Remove ${c.kind}`} disabled={ro} onClick={() => remove(i)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="room-add">
        <button type="button" disabled={ro || full} onClick={() => add(newEnemy())}>
          + Enemy
        </button>
        <button type="button" disabled={ro || full || abilities.length === 0} title={abilities.length ? undefined : "The progression has no abilities or keys yet"} onClick={() => add(newPickup())}>
          + Pickup
        </button>
        <button type="button" disabled={ro || full} onClick={() => add({ kind: "save" })}>
          + Save
        </button>
        <button type="button" disabled={ro || full || contents.some((c) => c.kind === "start")} onClick={() => add({ kind: "start" })}>
          + Start
        </button>
        <button type="button" disabled={ro || full || contents.some((c) => c.kind === "ending")} onClick={() => add({ kind: "ending" })}>
          + Ending
        </button>
      </div>
    </div>
  );
}

type Enemy = Extract<RoomContent, { kind: "enemy" }>;

function EnemyRow({ content: c, project, ro, onChange }: { content: Enemy; project: ProjectSpec; ro: boolean; onChange: (c: Enemy) => Promise<boolean> }) {
  const exists = project.characters.some((ch) => ch.id === c.characterId && ch.kind === "enemy");
  const abilities = project.progression.abilities.map((a) => ({ id: a.id, name: a.name }));
  return (
    <div className="enemy-row">
      <div className="enemy-line">
        <span className="content-kind">☠ Enemy</span>
        <DraftText
          className="enemy-id"
          label="Enemy character"
          value={c.characterId}
          disabled={ro}
          maxLength={64}
          placeholder="enemy id"
          onCommit={(raw) => {
            const id = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
            return ID.test(id) ? onChange({ ...c, characterId: id }) : false;
          }}
        />
        {!exists && (
          <span className="tag draft" title="The cast stage creates it">
            new
          </span>
        )}
        <span className="hint">×</span>
        <NumberInput label="Enemy count" value={c.count} min={1} max={12} disabled={ro} onCommit={(count) => onChange({ ...c, count })} />
      </div>
      <div className="enemy-line">
        <label className="field-check">
          <input type="checkbox" checked={c.lockRoom} disabled={ro} onChange={(e) => void onChange({ ...c, lockRoom: e.target.checked })} />
          locks the room
        </label>
        <label className="field-check">
          <input type="checkbox" checked={c.healthBar} disabled={ro} onChange={(e) => void onChange({ ...c, healthBar: e.target.checked })} />
          health bar
        </label>
      </div>
      <div className="enemy-line">
        <span className="hint">grants</span>
        <IdToggles label="Enemy grants" options={abilities} value={c.grants} disabled={ro} onChange={(grants) => void onChange({ ...c, grants })} />
      </div>
    </div>
  );
}

// --- links ------------------------------------------------------------------

function LinksEditor({ room, project, ro, run, abilities }: { room: RoomPlan; project: ProjectSpec; ro: boolean; run: Run; abilities: { id: string; name: string }[] }) {
  const plan = project.architect;
  const links = roomLinks(plan, room.id);
  const name = (id: string) => plan.rooms.find((r) => r.id === id)?.name ?? id;
  const others = plan.rooms.filter((r) => r.id !== room.id);
  const regions = project.progression.regions;

  const add = (other: string) => {
    const link: RoomLink = { id: uniqueId(`${room.id}_to_${other}`, plan.links.map((l) => l.id)), a: { room: room.id }, b: { room: other }, requires: [], oneWay: false };
    void run("linkRooms", { link });
  };
  const change = (link: RoomLink, changes: Record<string, unknown>) => void run("updateRoomLink", { linkId: link.id, changes });

  return (
    <div className="room-links" data-testid="room-links">
      <span className="arch-caption">Links</span>
      {links.length === 0 && <p className="hint">Not linked to any room: the player can't get here.</p>}
      <ul>
        {links.map(({ link, here, other }) => {
          const there = here === "a" ? "b" : "a";
          const arrow = link.oneWay ? (here === "a" ? "→" : "←") : "↔";
          return (
            <li key={link.id} className="link-row" data-testid={`room-link-${link.id}`}>
              <div className="link-line">
                <span className="link-arrow" title={link.oneWay ? "One-way" : "Both ways"}>
                  {arrow}
                </span>
                <button type="button" className="wiki-link" onClick={() => showRoom(other)}>
                  {name(other)}
                </button>
                <label className="link-side">
                  door here
                  <select aria-label="Door side here" value={link[here].side ?? ""} disabled={ro} onChange={(e) => change(link, { [`${here}Side`]: e.target.value || null })}>
                    <option value="">auto</option>
                    {SIDES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="link-side">
                  there
                  <select aria-label={`Door side in ${name(other)}`} value={link[there].side ?? ""} disabled={ro} onChange={(e) => change(link, { [`${there}Side`]: e.target.value || null })}>
                    <option value="">auto</option>
                    {SIDES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="arch-remove" aria-label={`Unlink ${name(other)}`} disabled={ro} onClick={() => void run("unlinkRooms", { linkId: link.id })}>
                  ✕
                </button>
              </div>
              <div className="link-line">
                <label className="field-check">
                  <input type="checkbox" checked={link.oneWay} disabled={ro} onChange={(e) => change(link, { oneWay: e.target.checked })} />
                  one-way ({name(link.a.room)} → {name(link.b.room)})
                </label>
              </div>
              <div className="link-line">
                <span className="hint" title={`Needed to pass from ${name(link.a.room)} to ${name(link.b.room)}; the gate is built in ${name(link.a.room)}`}>
                  needs
                </span>
                <IdToggles label="Link requires" options={abilities} value={link.requires} disabled={ro} onChange={(requires) => change(link, { requires })} />
              </div>
            </li>
          );
        })}
      </ul>
      {others.length > 0 && (
        <div className="room-add">
          <select
            aria-label="Link to room"
            value=""
            disabled={ro}
            onChange={(e) => {
              if (e.target.value) add(e.target.value);
            }}
          >
            <option value="">+ Link to…</option>
            {[...regions.map((r) => ({ id: r.id, name: r.name })), { id: "", name: "Other" }].map((g) => {
              const list = others.filter((r) => (g.id ? r.regionId === g.id : !regions.some((x) => x.id === r.regionId)));
              return (
                list.length > 0 && (
                  <optgroup key={g.id || "_other"} label={g.name}>
                    {list.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </optgroup>
                )
              );
            })}
          </select>
        </div>
      )}
    </div>
  );
}
