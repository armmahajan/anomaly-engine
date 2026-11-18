import { useState, type ReactNode } from "react";
import {
  findProgressionItem,
  MECHANICS,
  progressionIds,
  RewardSource,
  slugify,
  uniqueId,
  type Ability,
  type ChangeResult,
  type Connection,
  type Mechanic,
  type OperationCall,
  type ProgressionReport,
  type ProjectSpec,
  type Region,
  type StoryBeat,
} from "@anomaly/core";
import type { Session } from "./session.ts";
import { ProgressionGraph } from "./content/ProgressionGraph.tsx";
import { ConfirmButton, ListFilter, ListSection, matches } from "./content/ListSection.tsx";

export type ProgressionKind = "region" | "ability" | "connection" | "beat";
/** What the progression tab shows: a selected item, or a form for a new one. */
export type ProgressionNav = { selected: string | null; creating: ProgressionKind | null };

const KIND_LABEL: Record<ProgressionKind, string> = { region: "Region", ability: "Ability", connection: "Connection", beat: "Story beat" };
const SOURCES = RewardSource.options;

interface SidebarProps {
  project: ProjectSpec;
  session: Session;
  report: ProgressionReport;
  nav: ProgressionNav;
  setNav: (nav: ProgressionNav) => void;
  locked: boolean;
}

export function ProgressionSidebar({ project, session, report, nav, setNav, locked }: SidebarProps) {
  const [query, setQuery] = useState("");
  const p = project.progression;
  const name = (id: string) => p.regions.find((r) => r.id === id)?.name ?? id;
  const pageTitle = (id: string) => project.wiki.pages.find((pg) => pg.id === id)?.title ?? id;
  const drafts = [...p.regions, ...p.abilities, ...p.connections, ...p.beats].filter((i) => i.status === "draft");
  const acceptAll = async () => {
    const result = await session.applyBatch(drafts.map((i) => ({ name: "acceptProgressionItem", input: { id: i.id } })));
    if (!result.ok) session.reportProblem(result.error.message);
  };
  const item = (id: string, label: string, status: string) =>
    matches(query, label, id) && (
      <li key={id}>
        <button type="button" data-testid={`progression-item-${id}`} className={nav.selected === id ? "selected" : ""} onClick={() => setNav({ selected: id, creating: null })}>
          {label}
          {status === "draft" && <span className="kind draft-tag">draft</span>}
        </button>
      </li>
    );
  const group = (title: string, all: number, items: ReactNode[]) => {
    const shown = items.filter(Boolean);
    return (
      all > 0 &&
      (shown.length > 0 || !query) && (
        <ListSection title={title} count={query ? shown.length : all} forceOpen={query !== "" || (items as { key?: string }[]).some((i) => i && i.key === nav.selected)}>
          <ul className="character-list">{shown}</ul>
        </ListSection>
      )
    );
  };
  const errors = report.issues.filter((i) => i.severity === "error").length;

  return (
    <section className="wiki-sidebar">
      <div className="side-head">
        <h2>Progression</h2>
      </div>
      <div className="list-actions wiki-actions progression-actions">
        {(["region", "ability", "connection", "beat"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={locked || (kind === "connection" && p.regions.length < 2) || (kind === "beat" && p.regions.length === 0)}
            onClick={() => setNav({ selected: null, creating: kind })}
          >
            + {KIND_LABEL[kind]}
          </button>
        ))}
      </div>
      {drafts.length > 0 && (
        <div className="review-bar" data-testid="progression-review-bar">
          <p>
            <strong>{drafts.length}</strong> draft{drafts.length === 1 ? "" : "s"} by the director to review
          </p>
          <div className="review-actions">
            <button type="button" onClick={() => setNav({ selected: drafts[0]!.id, creating: null })}>
              Review next →
            </button>
            <ConfirmButton
              label="Accept all…"
              question={`Make all ${drafts.length} drafts canon? (Undo reverts it.)`}
              confirmLabel={`Accept ${drafts.length}`}
              disabled={locked}
              onConfirm={() => void acceptAll()}
            />
          </div>
        </div>
      )}
      {p.regions.length === 0 ? (
        <p className="hint">No regions yet. Ask the director to design the structure, or add a region.</p>
      ) : (
        <ListFilter value={query} onChange={setQuery} placeholder="Filter regions, abilities, links…" label="Filter progression" />
      )}
      {group("Regions", p.regions.length, p.regions.map((r) => item(r.id, r.name, r.status)))}
      {group("Abilities", p.abilities.length, p.abilities.map((a) => item(a.id, `◆ ${a.name}`, a.status)))}
      {group("Connections", p.connections.length, p.connections.map((c) => item(c.id, `${name(c.from)} ${c.oneWay ? "→" : "↔"} ${name(c.to)}`, c.status)))}
      {group("Story beats", p.beats.length, p.beats.map((b) => item(b.id, `${pageTitle(b.wikiPageId)} · ${name(b.regionId)}`, b.status)))}
      {report.issues.length > 0 && (
        <div className="wiki-gaps progression-issues" data-testid="progression-issues">
          <ListSection
            title="Checks"
            count={report.issues.length}
            extra={errors > 0 && <span className="list-section-drafts issue-error">{errors} error{errors === 1 ? "" : "s"}</span>}
          >
            <ul>
              {report.issues.map((issue, i) => (
                <li key={i} className={`issue-${issue.severity}`}>
                  {issue.message}
                  {issue.ids[0] && (
                    <button type="button" onClick={() => setNav({ selected: issue.ids[0]!, creating: null })}>
                      Show
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </ListSection>
        </div>
      )}
    </section>
  );
}

interface MainProps {
  project: ProjectSpec;
  report: ProgressionReport;
  session: Session;
  nav: ProgressionNav;
  setNav: (nav: ProgressionNav) => void;
  locked: boolean;
  onOpenWiki: (pageId: string) => void;
}

export function ProgressionMain({ project, report, session, nav, setNav, locked, onOpenWiki }: MainProps) {
  const p = project.progression;
  const found = nav.selected ? findProgressionItem(p, nav.selected) : undefined;
  const abilityName = (id: string) => p.abilities.find((a) => a.id === id)?.name ?? id;

  const panel = (nav.creating || found) && (
    <div className="progression-drawer">
      <button type="button" className="drawer-close" aria-label="Close" title="Close" onClick={() => setNav({ selected: null, creating: null })}>
        ×
      </button>
      <ItemPanel
        key={nav.creating ? `new-${nav.creating}` : nav.selected!}
        project={project}
        session={session}
        kind={nav.creating ?? found!.kind}
        item={nav.creating ? undefined : found!.item}
        locked={locked}
        setNav={setNav}
        onOpenWiki={onOpenWiki}
      />
    </div>
  );

  return (
    <div className="progression-main">
      {p.regions.length === 0 ? (
        <>
          {!nav.creating && (
            <div className="wiki-empty">
              <h1>Your game's progression</h1>
              <p className="hint">
                The structure of the game: regions, the abilities and keys that gate them, and where each one is found. The studio checks that the game can be
                finished, that nothing soft-locks the player, and shows the order things open up in. Design it with the director, or add a region.
              </p>
            </div>
          )}
          {panel}
        </>
      ) : (
        <>
          <div className="progression-status" data-testid="progression-status">
            {report.finishable ? <span className="tag canon">Finishable</span> : <span className="tag error">Not finishable</span>}
            {report.criticalPath.length > 0 && (
              <span data-testid="critical-path">
                Critical path:{" "}
                {report.criticalPath.map((id, i) => (
                  <span key={id}>
                    {i > 0 && " → "}
                    <button type="button" className="wiki-link critical" onClick={() => setNav({ selected: id, creating: null })}>
                      ◆ {abilityName(id)}
                    </button>
                  </span>
                ))}
              </span>
            )}
            <span className="progression-legend hint">dashed: draft · drag to pan · ctrl/⌘ + scroll to zoom</span>
          </div>
          <div className="progression-body">
            <ProgressionGraph project={project} report={report} selected={nav.selected} onSelect={(id) => setNav({ selected: id, creating: null })} />
            {panel}
          </div>
        </>
      )}
    </div>
  );
}

// --- the selected item: details, review and a form ---

interface PanelProps {
  project: ProjectSpec;
  session: Session;
  kind: ProgressionKind;
  item?: Region | Ability | Connection | StoryBeat;
  locked: boolean;
  setNav: (nav: ProgressionNav) => void;
  onOpenWiki: (pageId: string) => void;
}

/** Drop null and empty values: a new item simply leaves them out. */
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== ""));

function ItemPanel({ project, session, kind, item, locked, setNav, onOpenWiki }: PanelProps) {
  const p = project.progression;
  const report = (result: ChangeResult) => {
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };
  const taken = progressionIds(p);

  /** New items are canon (the creator made them); so is anything the creator edits. One batch: one undo step. */
  const save: FormProps["onSave"] = async (base, values, ends = {}) => {
    const opName = { region: "Region", ability: "Ability", connection: "Connection", beat: "StoryBeat" }[kind];
    const id = item?.id ?? uniqueId(slugify(base, kind), taken);
    const calls: OperationCall[] = [
      item
        ? { name: `update${opName}`, input: { [`${kind}Id`]: id, changes: { ...values, status: "canon" } } }
        : { name: `create${opName}`, input: { [kind]: { ...compact(values), id, status: "canon" } } },
    ];
    const endsInput = Object.fromEntries(Object.entries(ends).map(([k, here]) => [k, here ? id : null]));
    if (Object.keys(endsInput).length) calls.push({ name: "setProgressionEnds", input: endsInput });
    if (report(await session.applyBatch(calls))) setNav({ selected: id, creating: null });
  };
  const wikiPage = item && "wikiPageId" in item && item.wikiPageId ? project.wiki.pages.find((pg) => pg.id === item.wikiPageId) : undefined;
  const title = !item ? `New ${KIND_LABEL[kind].toLowerCase()}` : "name" in item ? item.name : KIND_LABEL[kind];
  const props = { project, locked, onSave: save };
  const drafts = [...p.regions, ...p.abilities, ...p.connections, ...p.beats].filter((i) => i.status === "draft");
  const nextDraft = drafts.find((i) => i.id !== item?.id);
  const remove = async (id: string) => {
    if (report(await session.applyOperation("deleteProgressionItem", { id }))) setNav({ selected: null, creating: null });
  };

  return (
    <section className="progression-panel" data-testid="progression-panel">
      <div className="wiki-meta">
        <span className="tag">{KIND_LABEL[kind]}</span>
        {item?.status === "canon" && <span className="tag canon">Canon</span>}
        {wikiPage && (
          <button type="button" className="wiki-link" onClick={() => onOpenWiki(wikiPage.id)}>
            Wiki page →
          </button>
        )}
      </div>
      {item?.status === "draft" && (
        <div className="wiki-review" data-testid="progression-review">
          <div className="wiki-review-text">
            <span className="tag draft">Draft by the director</span>
            <span className="hint">Accept it, change it below (saving makes it canon), or discard it.</span>
          </div>
          <div className="wiki-review-actions">
            <button type="button" className="primary" disabled={locked} onClick={() => void session.applyOperation("acceptProgressionItem", { id: item.id }).then(report)}>
              Accept
            </button>
            <button type="button" disabled={locked} title="Delete this draft (Undo restores it)" onClick={() => void remove(item.id)}>
              Discard
            </button>
            {nextDraft && (
              <button type="button" onClick={() => setNav({ selected: nextDraft.id, creating: null })}>
                Skip →
              </button>
            )}
          </div>
        </div>
      )}
      {item?.status === "canon" && nextDraft && (
        <p className="hint progression-next">
          <button type="button" className="wiki-link" onClick={() => setNav({ selected: nextDraft.id, creating: null })}>
            Next draft to review →
          </button>
        </p>
      )}
      <h2 className="panel-title">{title}</h2>
      {kind === "region" && <RegionForm {...props} region={item as Region | undefined} />}
      {kind === "ability" && <AbilityForm {...props} ability={item as Ability | undefined} />}
      {kind === "connection" && <ConnectionForm {...props} connection={item as Connection | undefined} />}
      {kind === "beat" && <BeatForm {...props} beat={item as StoryBeat | undefined} />}
      {!item && (
        <button type="button" className="cancel" onClick={() => setNav({ selected: null, creating: null })}>
          Cancel
        </button>
      )}
      {item?.status === "canon" && (
        <div className="progression-delete">
          <button type="button" disabled={locked} title="Undo restores it" onClick={() => void remove(item.id)}>
            Delete {KIND_LABEL[kind].toLowerCase()}
          </button>
        </div>
      )}
    </section>
  );
}

interface FormProps {
  project: ProjectSpec;
  locked: boolean;
  /** `ends`: make this region the start/ending (true) or stop it being one (false). */
  onSave: (base: string, values: Record<string, unknown>, ends?: { start?: boolean; ending?: boolean }) => Promise<void>;
}

function Form({ children, onSubmit, locked, valid = true }: { children: ReactNode; onSubmit: () => void; locked: boolean; valid?: boolean }) {
  return (
    <form
      className="progression-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <button type="submit" disabled={locked || !valid}>
        Save as canon
      </button>
    </form>
  );
}

function Select({ id, label, value, onChange, options, none }: { id: string; label: string; value: string; onChange: (v: string) => void; options: [string, string][]; none?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {none !== undefined && <option value="">{none}</option>}
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function Checks({ legend, options, value, onChange }: { legend: string; options: [string, string][]; value: string[]; onChange: (v: string[]) => void }) {
  if (options.length === 0) return null;
  return (
    <fieldset className="field progression-checks">
      <legend>{legend}</legend>
      {options.map(([id, text]) => (
        <label key={id} className="field-check">
          <input type="checkbox" checked={value.includes(id)} onChange={(e) => onChange(e.target.checked ? [...value, id] : value.filter((v) => v !== id))} />
          {text}
        </label>
      ))}
    </fieldset>
  );
}

function TextField({ id, label, value, onChange, type = "text" }: { id: string; label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} required />
    </div>
  );
}

const pageOptions = (project: ProjectSpec, preferKind?: string): [string, string][] =>
  [...project.wiki.pages].sort((a, b) => Number(b.kind === preferKind) - Number(a.kind === preferKind)).map((pg) => [pg.id, pg.title]);
const abilityOptions = (project: ProjectSpec, except?: string): [string, string][] =>
  project.progression.abilities.filter((a) => a.id !== except).map((a) => [a.id, a.name]);
const regionOptions = (project: ProjectSpec): [string, string][] => project.progression.regions.map((r) => [r.id, r.name]);

function RegionForm({ project, locked, onSave, region }: FormProps & { region?: Region }) {
  const p = project.progression;
  const [name, setName] = useState(region?.name ?? "");
  const [rooms, setRooms] = useState(String(region?.rooms ?? 8));
  const [enemies, setEnemies] = useState(region?.enemies ?? []);
  const [boss, setBoss] = useState(region?.boss ?? "");
  const [wikiPageId, setWikiPageId] = useState(region?.wikiPageId ?? "");
  const [isStart, setStart] = useState(region ? p.start === region.id : p.start === undefined);
  const [isEnd, setEnd] = useState(region ? p.ending === region.id : false);
  const enemyOptions = project.characters.filter((c) => c.kind === "enemy").map((c): [string, string] => [c.id, c.name]);

  const submit = () => {
    const was = { start: region !== undefined && p.start === region.id, ending: region !== undefined && p.ending === region.id };
    const ends = { ...(isStart !== was.start && { start: isStart }), ...(isEnd !== was.ending && { ending: isEnd }) };
    void onSave(name, { name: name.trim(), rooms: Number(rooms), enemies, boss: boss || null, wikiPageId: wikiPageId || null }, ends);
  };
  return (
    <Form onSubmit={submit} locked={locked} valid={name.trim() !== "" && Number(rooms) >= 1}>
      <TextField id="region-name" label="Name" value={name} onChange={setName} />
      <div className="wiki-row">
        <TextField id="region-rooms" label="Rooms" type="number" value={rooms} onChange={setRooms} />
        <Select id="region-boss" label="Boss" value={boss} onChange={setBoss} options={enemyOptions} none="none" />
      </div>
      <Select id="region-wiki" label="Wiki page" value={wikiPageId} onChange={setWikiPageId} options={pageOptions(project, "place")} none="none" />
      <Checks legend="Enemies" options={enemyOptions} value={enemies} onChange={setEnemies} />
      <div className="field progression-ends">
        <label className="field-check">
          <input type="checkbox" checked={isStart} onChange={(e) => setStart(e.target.checked)} /> The game starts here
        </label>
        <label className="field-check">
          <input type="checkbox" checked={isEnd} onChange={(e) => setEnd(e.target.checked)} /> Reaching it ends the game
        </label>
      </div>
    </Form>
  );
}

function AbilityForm({ project, locked, onSave, ability }: FormProps & { ability?: Ability }) {
  const [name, setName] = useState(ability?.name ?? "");
  const [mechanic, setMechanic] = useState<Mechanic>(ability?.mechanic ?? "key");
  const [regionId, setRegionId] = useState(ability?.obtainedIn?.regionId ?? "");
  const [source, setSource] = useState(ability?.obtainedIn?.source ?? "pickup");
  const [requires, setRequires] = useState(ability?.obtainedIn?.requires ?? []);
  const [wikiPageId, setWikiPageId] = useState(ability?.wikiPageId ?? "");
  const submit = () =>
    void onSave(name, {
      name: name.trim(),
      mechanic,
      obtainedIn: regionId ? { regionId, source, requires } : null,
      wikiPageId: wikiPageId || null,
    });
  return (
    <Form onSubmit={submit} locked={locked} valid={name.trim() !== ""}>
      <TextField id="ability-name" label="Name" value={name} onChange={setName} />
      <Select id="ability-mechanic" label="Mechanic" value={mechanic} onChange={(v) => setMechanic(v as Mechanic)} options={Object.keys(MECHANICS).map((m) => [m, m.replace("_", " ")])} />
      <p className="hint">{MECHANICS[mechanic]}</p>
      <div className="wiki-row">
        <Select id="ability-region" label="Found in" value={regionId} onChange={setRegionId} options={regionOptions(project)} none="not decided" />
        <Select id="ability-source" label="Source" value={source} onChange={(v) => setSource(v as typeof source)} options={SOURCES.map((s) => [s, s])} />
      </div>
      {regionId && <Checks legend="Needs, to get it there" options={abilityOptions(project, ability?.id)} value={requires} onChange={setRequires} />}
      <Select id="ability-wiki" label="Wiki page" value={wikiPageId} onChange={setWikiPageId} options={pageOptions(project, "ability")} none="none" />
    </Form>
  );
}

function ConnectionForm({ project, locked, onSave, connection }: FormProps & { connection?: Connection }) {
  const regions = regionOptions(project);
  const [from, setFrom] = useState(connection?.from ?? regions[0]?.[0] ?? "");
  const [to, setTo] = useState(connection?.to ?? regions[1]?.[0] ?? "");
  const [oneWay, setOneWay] = useState(connection?.oneWay ?? false);
  const [requires, setRequires] = useState(connection?.requires ?? []);
  return (
    <Form onSubmit={() => void onSave(`${from}_${to}`, { from, to, oneWay, requires })} locked={locked} valid={from !== to}>
      <div className="wiki-row">
        <Select id="connection-from" label="From" value={from} onChange={setFrom} options={regions} />
        <Select id="connection-to" label="To" value={to} onChange={setTo} options={regions} />
      </div>
      <label className="field field-check">
        <input type="checkbox" checked={oneWay} onChange={(e) => setOneWay(e.target.checked)} /> One-way (from → to only)
      </label>
      <Checks legend="Needs" options={abilityOptions(project)} value={requires} onChange={setRequires} />
    </Form>
  );
}

function BeatForm({ project, locked, onSave, beat }: FormProps & { beat?: StoryBeat }) {
  const pages = pageOptions(project, "story");
  const [wikiPageId, setWikiPageId] = useState(beat?.wikiPageId ?? pages[0]?.[0] ?? "");
  const [regionId, setRegionId] = useState(beat?.regionId ?? regionOptions(project)[0]?.[0] ?? "");
  const [requires, setRequires] = useState(beat?.requires ?? []);
  if (pages.length === 0) return <p className="hint">Write a story page in the wiki first: a beat places one in the structure.</p>;
  return (
    <Form onSubmit={() => void onSave(`beat_${wikiPageId}`, { wikiPageId, regionId, requires })} locked={locked}>
      <Select id="beat-page" label="Story page" value={wikiPageId} onChange={setWikiPageId} options={pages} />
      <Select id="beat-region" label="Happens in" value={regionId} onChange={setRegionId} options={regionOptions(project)} />
      <Checks legend="The player has by then" options={abilityOptions(project)} value={requires} onChange={setRequires} />
    </Form>
  );
}
