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

export type ProgressionKind = "region" | "ability" | "connection" | "beat";
/** What the progression tab shows: a selected item, or a form for a new one. */
export type ProgressionNav = { selected: string | null; creating: ProgressionKind | null };

const KIND_LABEL: Record<ProgressionKind, string> = { region: "Region", ability: "Ability", connection: "Connection", beat: "Story beat" };
const SOURCES = RewardSource.options;

interface SidebarProps {
  project: ProjectSpec;
  report: ProgressionReport;
  nav: ProgressionNav;
  setNav: (nav: ProgressionNav) => void;
  locked: boolean;
}

export function ProgressionSidebar({ project, report, nav, setNav, locked }: SidebarProps) {
  const p = project.progression;
  const name = (id: string) => p.regions.find((r) => r.id === id)?.name ?? id;
  const pageTitle = (id: string) => project.wiki.pages.find((pg) => pg.id === id)?.title ?? id;
  const item = (id: string, label: ReactNode, status: string) => (
    <li key={id}>
      <button type="button" data-testid={`progression-item-${id}`} className={nav.selected === id ? "selected" : ""} onClick={() => setNav({ selected: id, creating: null })}>
        {label}
        {status === "draft" && <span className="kind draft-tag">draft</span>}
      </button>
    </li>
  );
  const group = (title: string, items: ReactNode[]) =>
    items.length > 0 && (
      <div className="wiki-group">
        <h3>{title}</h3>
        <ul className="character-list">{items}</ul>
      </div>
    );

  return (
    <section className="wiki-sidebar">
      <h2>Progression</h2>
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
      {p.regions.length === 0 && <p className="hint">No regions yet. Ask the director to design the structure, or add a region.</p>}
      {group("Regions", p.regions.map((r) => item(r.id, r.name, r.status)))}
      {group("Abilities", p.abilities.map((a) => item(a.id, `◆ ${a.name}`, a.status)))}
      {group("Connections", p.connections.map((c) => item(c.id, `${name(c.from)} ${c.oneWay ? "→" : "↔"} ${name(c.to)}`, c.status)))}
      {group("Story beats", p.beats.map((b) => item(b.id, `${pageTitle(b.wikiPageId)} · ${name(b.regionId)}`, b.status)))}
      {report.issues.length > 0 && (
        <div className="wiki-gaps progression-issues" data-testid="progression-issues">
          <h3>Checks ({report.issues.length})</h3>
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

  return (
    <div className="progression-main">
      {p.regions.length === 0 && !nav.creating ? (
        <div className="wiki-empty">
          <h1>Your game's progression</h1>
          <p className="hint">
            The structure of the game: regions, the abilities and keys that gate them, and where each one is found. The studio checks that the game can be
            finished, that nothing soft-locks the player, and shows the order things open up in. Design it with the director, or add a region.
          </p>
        </div>
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
          </div>
          <ProgressionGraph project={project} report={report} selected={nav.selected} onSelect={(id) => setNav({ selected: id, creating: null })} />
        </>
      )}
      {(nav.creating || found) && (
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
      )}
    </div>
  );
}

// --- the graph: one column per sphere, regions as nodes, connections as edges ---

const COL_W = 280;
const NODE_W = 168;
const PAD = 24;
const HEAD = 30;
const GAP_Y = 26;
const LINE = 16;

interface Node {
  region: Region;
  col: number;
  x: number;
  y: number;
  h: number;
  lines: { id?: string; text: string; critical?: boolean }[];
}

function layout(project: ProjectSpec, report: ProgressionReport) {
  const p = project.progression;
  const unreachable = report.spheres.length;
  const sphereOf = (r: Region) => report.regionSphere[r.id] ?? unreachable;
  const used = [...new Set(p.regions.map(sphereOf))].sort((a, b) => a - b);
  const heading = (sphere: number) => (sphere === unreachable ? (p.start === undefined ? "No start yet" : "Unreachable") : `Sphere ${sphere}`);
  const columns = used.map((sphere) => ({ sphere, heading: heading(sphere), x: PAD + used.indexOf(sphere) * COL_W }));
  const characterName = (id: string) => project.characters.find((c) => c.id === id)?.name ?? id;
  const critical = new Set(report.criticalPath);

  const nodes = new Map<string, Node>();
  const bottoms = columns.map(() => PAD + HEAD);
  for (const region of p.regions) {
    const col = used.indexOf(sphereOf(region));
    const lines: Node["lines"] = [
      ...p.abilities.filter((a) => a.obtainedIn?.regionId === region.id).map((a) => ({ id: a.id, text: `◆ ${a.name}`, critical: critical.has(a.id) })),
      ...(region.boss ? [{ text: `☠ ${characterName(region.boss)}` }] : []),
    ];
    const h = 46 + lines.length * LINE;
    nodes.set(region.id, { region, col, x: columns[col]!.x, y: bottoms[col]!, h, lines });
    bottoms[col]! += h + GAP_Y;
  }
  return { columns, nodes, width: PAD * 2 + Math.max(1, columns.length) * COL_W - (COL_W - NODE_W), height: Math.max(...bottoms, 120) + PAD - GAP_Y };
}

const LANE = 24;

/** Neighbouring columns: a curve between facing sides. Further apart: a lane under all the nodes, so lines never cross them. */
function edgePath(a: Node, b: Node, offset: number, laneY: number | null) {
  if (laneY !== null) {
    // Out the facing side, down the gap between columns, along the lane, up the gap, in the other side.
    const dir = b.col > a.col ? 1 : -1;
    const half = (COL_W - NODE_W) / 2;
    const out = dir > 0 ? a.x + NODE_W : a.x;
    const into = dir > 0 ? b.x : b.x + NODE_W;
    const g1 = out + dir * (half - 8 + offset);
    const g2 = into - dir * (half - 8 + offset);
    const ya = a.y + a.h / 2;
    const yb = b.y + b.h / 2;
    return { d: `M${out},${ya} L${g1},${ya} L${g1},${laneY} L${g2},${laneY} L${g2},${yb} L${into},${yb}`, mid: { x: (g1 + g2) / 2, y: laneY } };
  }
  const same = a.col === b.col;
  const x1 = a.col <= b.col ? a.x + NODE_W : a.x;
  const x2 = a.col < b.col ? b.x : b.x + NODE_W;
  const y1 = a.y + a.h / 2 + offset;
  const y2 = b.y + b.h / 2 + offset;
  const dir = x2 >= x1 ? 1 : -1;
  const dx = same ? 56 : Math.max(36, Math.abs(x2 - x1) / 2);
  const c1 = same ? x1 + dx : x1 + dir * dx;
  const c2 = same ? x2 + dx : x2 - dir * dx;
  return { d: `M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`, mid: { x: (x1 + 3 * c1 + 3 * c2 + x2) / 8, y: (y1 + y2) / 2 } };
}

function ProgressionGraph({ project, report, selected, onSelect }: { project: ProjectSpec; report: ProgressionReport; selected: string | null; onSelect: (id: string) => void }) {
  const p = project.progression;
  const { columns, nodes, width, height } = layout(project, report);
  const abilityName = (id: string) => p.abilities.find((a) => a.id === id)?.name ?? id;
  const flagged = new Set(report.issues.filter((i) => i.severity === "error").flatMap((i) => i.ids));
  const activate = (id: string) => ({
    role: "button",
    tabIndex: 0,
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onSelect(id);
    },
    onKeyDown: (e: { key: string }) => e.key === "Enter" && onSelect(id),
  });

  const pairCount = new Map<string, number>();
  let lanes = 0;
  const edges = p.connections.flatMap((c) => {
    const a = nodes.get(c.from);
    const b = nodes.get(c.to);
    if (!a || !b) return [];
    const pair = [c.from, c.to].sort().join("|");
    const k = pairCount.get(pair) ?? 0;
    pairCount.set(pair, k + 1);
    const laneY = Math.abs(a.col - b.col) > 1 ? height - PAD + GAP_Y / 2 + lanes++ * LANE : null;
    const label = c.requires.map(abilityName).join(" + ");
    const classes = ["edge", c.status, selected === c.id && "selected", flagged.has(c.id) && "flagged"].filter(Boolean).join(" ");
    return [{ c, label, classes, ...edgePath(a, b, k * 10, laneY) }];
  });

  return (
    <div className="progression-graph">
      <svg width={width} height={height + lanes * LANE} role="group" aria-label="Progression graph" data-testid="progression-graph">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="edge-arrow" />
          </marker>
        </defs>
        {columns.map((c) => (
          <text key={c.heading} x={c.x} y={PAD + 10} className="column-heading">
            {c.heading}
          </text>
        ))}
        {/* Lines, then nodes, then labels: a label is never hidden. */}
        {edges.map(({ c, d, classes }) => (
          <g key={c.id} className={classes} data-testid={`connection-${c.id}`} aria-label={`${c.from} to ${c.to}`} {...activate(c.id)}>
            <path d={d} className="edge-hit" />
            <path d={d} className="edge-line" markerEnd={c.oneWay ? "url(#arrow)" : undefined} />
          </g>
        ))}
        {[...nodes.values()].map(({ region, x, y, h, lines }) => {
          const classes = ["region-node", region.status, selected === region.id && "selected", flagged.has(region.id) && "flagged"].filter(Boolean).join(" ");
          const badges = [p.start === region.id && "START", p.ending === region.id && "END"].filter(Boolean).join(" · ");
          return (
            <g key={region.id} className={classes} data-testid={`region-node-${region.id}`} aria-label={region.name} {...activate(region.id)}>
              <rect x={x} y={y} width={NODE_W} height={h} rx={6} />
              <text x={x + 10} y={y + 20} className="node-name">
                {region.name}
              </text>
              {badges && (
                <text x={x + NODE_W - 8} y={y + 20} textAnchor="end" className="node-badge">
                  {badges}
                </text>
              )}
              <text x={x + 10} y={y + 34} className="node-meta">
                {region.rooms} rooms{region.enemies.length ? ` · ${region.enemies.length} enemy type${region.enemies.length > 1 ? "s" : ""}` : ""}
              </text>
              {lines.map((line, i) => (
                <text
                  key={i}
                  x={x + 10}
                  y={y + 52 + i * LINE}
                  className={`node-line${line.critical ? " critical" : ""}${line.id && selected === line.id ? " selected" : ""}`}
                  {...(line.id ? activate(line.id) : {})}
                >
                  {line.text}
                </text>
              ))}
            </g>
          );
        })}
        {edges.map(
          ({ c, label, mid, classes }) =>
            label && (
              <g key={c.id} className={classes} transform={`translate(${mid.x},${mid.y})`} data-testid={`connection-label-${c.id}`} {...activate(c.id)}>
                <rect x={-(label.length * 3.4 + 8)} y={-9} width={label.length * 6.8 + 16} height={18} rx={9} className="edge-label-bg" />
                <text textAnchor="middle" y={4} className="edge-label">
                  {label}
                </text>
              </g>
            ),
        )}
      </svg>
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

  return (
    <section className="progression-panel" data-testid="progression-panel">
      <div className="wiki-meta">
        <span className="tag">{KIND_LABEL[kind]}</span>
        {item?.status === "draft" && (
          <>
            <span className="tag draft">Draft by the director</span>
            <button type="button" disabled={locked} onClick={() => void session.applyOperation("acceptProgressionItem", { id: item.id }).then(report)}>
              Accept
            </button>
          </>
        )}
        {item?.status === "canon" && <span className="tag canon">Canon</span>}
        {item && (
          <button
            type="button"
            disabled={locked}
            onClick={async () => {
              if (report(await session.applyOperation("deleteProgressionItem", { id: item.id }))) setNav({ selected: null, creating: null });
            }}
          >
            {item.status === "draft" ? "Discard" : "Delete"}
          </button>
        )}
        {wikiPage && (
          <button type="button" className="wiki-link wiki-edit" onClick={() => onOpenWiki(wikiPage.id)}>
            Wiki page →
          </button>
        )}
      </div>
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
