import { useEffect, useRef, useState } from "react";
import { gridCols, gridRows, type ProjectSpec } from "@anomaly/core";
import { ART_STATE_TEXT, regionGroups, roomArt, type ArtState } from "../worlds/scenery.ts";

/** With more rooms than this, only the selected room's region starts open. */
const OPEN_ALL_UP_TO = 30;

type ArtFilter = "any" | ArtState;
const ART_FILTERS: { value: ArtFilter; label: string }[] = [
  { value: "any", label: "Any scenery" },
  { value: "plain", label: "Plain tiles" },
  { value: "dressed", label: "Dressed" },
  { value: "stale", label: "Needs recompose" },
];

/** A room's scenery state as a small dot (with its meaning on hover). */
export function ArtDot({ state }: { state: ArtState }) {
  return <span className={`art-dot ${state}`} title={ART_STATE_TEXT[state]} aria-label={ART_STATE_TEXT[state]} role="img" />;
}

/**
 * The game's rooms grouped by progression region: each group collapses and
 * shows how many rooms it has (of those planned) and how many are dressed.
 * A filter narrows by name or scenery state.
 */
export function RoomList({ project, selected, onSelect }: { project: ProjectSpec; selected: string | null; onSelect: (id: string) => void }) {
  const groups = regionGroups(project);
  const total = project.world.rooms.length;
  const groupOf = (roomId: string | null) => groups.find((g) => g.rooms.some((r) => r.id === roomId))?.id;
  const [open, setOpen] = useState<Set<string>>(() => new Set(total <= OPEN_ALL_UP_TO ? groups.map((g) => g.id) : [groupOf(selected) ?? groups[0]?.id ?? ""]));
  const [text, setText] = useState("");
  const [art, setArt] = useState<ArtFilter>("any");

  // Selecting a room (here, on the map, or by playing into it) opens its region.
  const selectedGroup = groupOf(selected);
  useEffect(() => {
    if (selectedGroup !== undefined) setOpen((o) => (o.has(selectedGroup) ? o : new Set([...o, selectedGroup])));
  }, [selectedGroup, selected]);

  // Keep the selected room's row in view (picked on the map, sent from Scenery, or followed in play).
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => listRef.current?.querySelector("button.selected")?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  const query = text.trim().toLowerCase();
  const filtering = query !== "" || art !== "any";
  const matches = (r: ProjectSpec["world"]["rooms"][number]) =>
    (query === "" || r.name.toLowerCase().includes(query) || r.id.includes(query)) && (art === "any" || roomArt(project, r).state === art);
  const toggle = (id: string) => setOpen((o) => (o.has(id) ? new Set([...o].filter((x) => x !== id)) : new Set([...o, id])));
  const shown = groups.map((g) => ({ ...g, shown: g.rooms.filter(matches) })).filter((g) => !filtering || g.shown.length > 0);
  const single = groups.length === 1;

  return (
    <div className="room-groups" data-testid="room-list" ref={listRef}>
      {total > 6 && (
        <div className="list-filter">
          <input className="art-text" type="search" aria-label="filter rooms" placeholder={`Filter ${total} rooms…`} value={text} onChange={(e) => setText(e.target.value)} />
          <select aria-label="filter rooms by scenery" value={art} onChange={(e) => setArt(e.target.value as ArtFilter)}>
            {ART_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {filtering && shown.length === 0 && <p className="hint">No rooms match.</p>}
      {shown.map((g) => {
        const isOpen = single || filtering || open.has(g.id);
        const dressed = g.rooms.filter((r) => r.dressing).length;
        const stale = g.rooms.filter((r) => roomArt(project, r).state === "stale").length;
        return (
          <div key={g.id} className="room-group" data-testid={`region-group-${g.id || "none"}`}>
            {!single && (
              <button type="button" className="room-group-head" aria-expanded={isOpen} onClick={() => toggle(g.id)} disabled={filtering}>
                <span className="chevron" aria-hidden>
                  ▸
                </span>
                <span className="region-swatch" style={{ background: g.color ?? "transparent" }} />
                <span className="room-group-name">{g.name}</span>
                <span className="kind" title={`${g.rooms.length} room${g.rooms.length === 1 ? "" : "s"}${g.planned !== null ? ` of ${g.planned} planned in Progression` : ""}; ${dressed} with scenery`}>
                  {filtering ? `${g.shown.length} of ${g.rooms.length}` : g.planned !== null && g.planned !== g.rooms.length ? `${g.rooms.length}/${g.planned}` : g.rooms.length}
                  {" · "}
                  {dressed} dressed
                  {stale > 0 && <span className="stale-count"> · {stale} to recompose</span>}
                </span>
              </button>
            )}
            {isOpen && (
              <ul className="character-list room-group-list">
                {(filtering ? g.shown : g.rooms).map((r) => (
                  <li key={r.id}>
                    <button type="button" data-testid={`room-${r.id}`} className={r.id === selected ? "selected" : ""} onClick={() => onSelect(r.id)}>
                      <ArtDot state={roomArt(project, r).state} />
                      <span className="room-name">{r.name}</span>
                      {project.world.start?.room === r.id && <span className="tag" title="The game starts here">start</span>}
                      {project.world.playtest?.room === r.id && <span className="tag" title="▶ Play in the Playtest tab starts here">playtest</span>}
                      <span className="kind">
                        {gridCols(r.grid)}×{gridRows(r.grid)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <p className="art-legend" aria-label="Scenery legend">
        <span>
          <ArtDot state="dressed" /> dressed
        </span>
        <span>
          <ArtDot state="stale" /> needs recompose
        </span>
        <span>
          <ArtDot state="plain" /> plain tiles
        </span>
      </p>
    </div>
  );
}
