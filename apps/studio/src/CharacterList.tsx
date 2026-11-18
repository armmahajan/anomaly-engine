import type { ReactNode } from "react";
import type { ArtState, LiveState, ProjectSpec } from "@anomaly/core";
import { fileUrl } from "./api.ts";
import { characterWork } from "./LiveStatus.tsx";
import { ListSection } from "./ui/ListSection.tsx";
import { ListFilter, matchesQuery } from "./ui/ListFilter.tsx";

/** Characters lists longer than this get a filter box. */
const FILTER_FROM = 8;

/**
 * The Playtest and Characters tabs' character list: a collapsible section
 * (so the inspector below can have the panel), the player first, then the
 * enemies, a filter once the cast is long, and the add/duplicate/delete row.
 */
export function CharacterList({
  project,
  art,
  live,
  selectedId,
  onSelect,
  query,
  setQuery,
  actions,
}: {
  project: ProjectSpec;
  art: ArtState;
  live: LiveState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: string;
  setQuery: (query: string) => void;
  actions: ReactNode;
}) {
  const all = project.characters;
  // A long cast gets a filter and is grouped (player, enemies); a short one is one plain list.
  const long = all.length > FILTER_FROM;
  const q = long ? query.trim() : "";
  const shown = all.filter((c) => matchesQuery(q, c.name, c.id, c.kind));
  const selected = all.find((c) => c.id === selectedId);

  const rows = (list: typeof all) => (
    <ul className="character-list">
      {list.map((c) => {
        const look = project.art.assets.find((a) => a.id === c.appearance);
        const work = characterWork(c.id, art, live);
        return (
          <li key={c.id}>
            <button
              type="button"
              data-testid={`character-${c.id}`}
              className={c.id === selectedId ? "selected" : ""}
              aria-current={c.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(c.id)}
            >
              {look?.kind === "character" && look.preview ? (
                <img className="swatch-img" src={fileUrl(look.preview.file)} alt="" />
              ) : (
                <span className="swatch" style={{ background: c.color }} />
              )}
              <span className="item-name">{c.name}</span>
              {work && (
                <span className="tag work" data-testid={`character-work-${c.id}`}>
                  {work}
                </span>
              )}
              {!long && <span className="kind">{c.kind}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );

  const groups = [
    { id: "player", title: "Player", list: shown.filter((c) => c.kind === "player") },
    { id: "enemies", title: "Enemies", list: shown.filter((c) => c.kind === "enemy") },
  ].filter((g) => g.list.length > 0);

  return (
    <ListSection id="characters" title="Characters" count={q ? `${shown.length} of ${all.length}` : all.length} forceOpen={q !== ""} testId="character-list">
      {long && <ListFilter value={query} onChange={setQuery} label="Filter characters" shown={shown.length} total={all.length} />}
      {!long
        ? rows(shown)
        : groups.map((g) => (
            <ListSection key={g.id} id={`characters:${g.id}`} level={2} title={g.title} count={g.list.length} forceOpen={q !== ""}>
              {rows(g.list)}
            </ListSection>
          ))}
      {shown.length === 0 && <p className="hint list-empty">No character matches “{q}”.</p>}
      {selected && q && !shown.includes(selected) && <p className="hint">{selected.name} (selected) is hidden by the filter.</p>}
      {actions}
    </ListSection>
  );
}
