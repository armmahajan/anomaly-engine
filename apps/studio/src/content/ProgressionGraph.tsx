import type { ProgressionReport, ProjectSpec, Region } from "@anomaly/core";
import { fitView, PanZoom, useElementSize } from "./PanZoom.tsx";

/**
 * The progression as a graph: one group per sphere (the order regions open
 * up), regions as nodes, connections as edges labelled with what they need.
 * Spheres run across (columns) or down (rows), whichever shows the graph
 * bigger in the space there is; the view fits, pans and zooms.
 */

type Orientation = "across" | "down";

const NODE_W = 168;
const PAD = 24;
const LINE = 16;
const LANE = 24;
// Across: a column per sphere.
const COL_W = 280;
const HEAD = 30;
const GAP_Y = 26;
// Down: a row per sphere, its heading in a gutter on the left.
const GUTTER = 92;
const GAP_X = 44;
const ROW_GAP = 76;

interface Node {
  region: Region;
  /** The node's sphere group, and its place in it. */
  group: number;
  slot: number;
  x: number;
  y: number;
  h: number;
  lines: { id?: string; text: string; critical?: boolean }[];
}

interface Layout {
  orientation: Orientation;
  headings: { text: string; x: number; y: number }[];
  nodes: Map<string, Node>;
  width: number;
  height: number;
  /** Top and bottom of each group's band (down only). */
  rows: { top: number; bottom: number }[];
  /** Where the lanes for far links start (across: below the nodes; down: right of them). */
  laneStart: number;
}

function groups(project: ProjectSpec, report: ProgressionReport) {
  const p = project.progression;
  const unreachable = report.spheres.length;
  const sphereOf = (r: Region) => report.regionSphere[r.id] ?? unreachable;
  const used = [...new Set(p.regions.map(sphereOf))].sort((a, b) => a - b);
  const heading = (sphere: number) => (sphere === unreachable ? (p.start === undefined ? "No start yet" : "Unreachable") : `Sphere ${sphere}`);
  const characterName = (id: string) => project.characters.find((c) => c.id === id)?.name ?? id;
  const critical = new Set(report.criticalPath);
  const members = used.map((sphere) => ({ heading: heading(sphere), regions: p.regions.filter((r) => sphereOf(r) === sphere) }));
  const linesOf = (region: Region): Node["lines"] => [
    ...p.abilities.filter((a) => a.obtainedIn?.regionId === region.id).map((a) => ({ id: a.id, text: `◆ ${a.name}`, critical: critical.has(a.id) })),
    ...(region.boss ? [{ text: `☠ ${characterName(region.boss)}` }] : []),
  ];
  return { members, linesOf };
}

function layoutAcross(project: ProjectSpec, report: ProgressionReport): Layout {
  const { members, linesOf } = groups(project, report);
  const nodes = new Map<string, Node>();
  const bottoms = members.map(() => PAD + HEAD);
  members.forEach((g, col) =>
    g.regions.forEach((region, slot) => {
      const lines = linesOf(region);
      const h = 46 + lines.length * LINE;
      nodes.set(region.id, { region, group: col, slot, x: PAD + col * COL_W, y: bottoms[col]!, h, lines });
      bottoms[col]! += h + GAP_Y;
    }),
  );
  const height = Math.max(...bottoms, 120) + PAD - GAP_Y;
  return {
    orientation: "across",
    headings: members.map((g, col) => ({ text: g.heading, x: PAD + col * COL_W, y: PAD + 10 })),
    nodes,
    width: PAD * 2 + Math.max(1, members.length) * COL_W - (COL_W - NODE_W),
    height,
    rows: [],
    laneStart: height - PAD + GAP_Y / 2,
  };
}

function layoutDown(project: ProjectSpec, report: ProgressionReport): Layout {
  const { members, linesOf } = groups(project, report);
  const nodes = new Map<string, Node>();
  const widest = Math.max(1, ...members.map((g) => g.regions.length));
  const rowW = (n: number) => n * NODE_W + Math.max(0, n - 1) * GAP_X;
  const rows: Layout["rows"] = [];
  let top = PAD;
  members.forEach((g, row) => {
    const sized = g.regions.map((region) => ({ region, lines: linesOf(region) }));
    const rowH = Math.max(46, ...sized.map((s) => 46 + s.lines.length * LINE));
    const left = GUTTER + (rowW(widest) - rowW(g.regions.length)) / 2;
    sized.forEach(({ region, lines }, slot) => {
      const h = 46 + lines.length * LINE;
      nodes.set(region.id, { region, group: row, slot, x: left + slot * (NODE_W + GAP_X), y: top + (rowH - h) / 2, h, lines });
    });
    rows.push({ top, bottom: top + rowH });
    top += rowH + ROW_GAP;
  });
  const laneStart = GUTTER + rowW(widest) + 24;
  return {
    orientation: "down",
    headings: members.map((g, row) => ({ text: g.heading, x: PAD - 8, y: (rows[row]!.top + rows[row]!.bottom) / 2 + 4 })),
    nodes,
    width: laneStart + PAD,
    height: Math.max(top - ROW_GAP + PAD, 120),
    rows,
    laneStart,
  };
}

/** A cubic's midpoint (t = 0.5). */
const mid3 = (p0: number, c1: number, c2: number, p3: number) => (p0 + 3 * c1 + 3 * c2 + p3) / 8;

/** Across. Neighbouring columns: a curve between facing sides. Further apart: a lane under all the nodes, so lines never cross them. */
function edgeAcross(a: Node, b: Node, offset: number, laneY: number | null) {
  if (laneY !== null) {
    const dir = b.group > a.group ? 1 : -1;
    const half = (COL_W - NODE_W) / 2;
    const out = dir > 0 ? a.x + NODE_W : a.x;
    const into = dir > 0 ? b.x : b.x + NODE_W;
    const g1 = out + dir * (half - 8 + offset);
    const g2 = into - dir * (half - 8 + offset);
    const ya = a.y + a.h / 2;
    const yb = b.y + b.h / 2;
    return { d: `M${out},${ya} L${g1},${ya} L${g1},${laneY} L${g2},${laneY} L${g2},${yb} L${into},${yb}`, mid: { x: (g1 + g2) / 2, y: laneY } };
  }
  const same = a.group === b.group;
  const x1 = a.group <= b.group ? a.x + NODE_W : a.x;
  const x2 = a.group < b.group ? b.x : b.x + NODE_W;
  const y1 = a.y + a.h / 2 + offset;
  const y2 = b.y + b.h / 2 + offset;
  const dir = x2 >= x1 ? 1 : -1;
  const dx = same ? 56 : Math.max(36, Math.abs(x2 - x1) / 2);
  const c1 = same ? x1 + dx : x1 + dir * dx;
  const c2 = same ? x2 + dx : x2 - dir * dx;
  return { d: `M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`, mid: { x: mid3(x1, c1, c2, x2), y: (y1 + y2) / 2 } };
}

/**
 * Down. Neighbouring rows: a curve from the facing edges. The same row: side by side, a straight line;
 * further along the row, an arc under it. Rows further apart: through the gaps between rows to a lane
 * right of every node and back, so lines never cross a node.
 */
function edgeDown(a: Node, b: Node, offset: number, laneX: number | null, rows: Layout["rows"]) {
  const ax = a.x + NODE_W / 2 + offset;
  const bx = b.x + NODE_W / 2 + offset;
  if (a.group === b.group) {
    if (Math.abs(a.slot - b.slot) === 1) {
      const right = b.slot > a.slot;
      const x1 = right ? a.x + NODE_W : a.x;
      const x2 = right ? b.x : b.x + NODE_W;
      const y = (a.y + a.h / 2 + b.y + b.h / 2) / 2 + offset;
      return { d: `M${x1},${y} L${x2},${y}`, mid: { x: (x1 + x2) / 2, y } };
    }
    const y1 = a.y + a.h;
    const y2 = b.y + b.h;
    const dip = Math.max(y1, y2) + ROW_GAP / 2 + offset;
    return { d: `M${ax},${y1} C${ax},${dip} ${bx},${dip} ${bx},${y2}`, mid: { x: (ax + bx) / 2, y: mid3(y1, dip, dip, y2) } };
  }
  const downward = b.group > a.group;
  const y1 = downward ? a.y + a.h : a.y;
  const y2 = downward ? b.y : b.y + b.h;
  if (laneX === null) {
    const dy = (downward ? 1 : -1) * Math.max(28, Math.abs(y2 - y1) / 2);
    return { d: `M${ax},${y1} C${ax},${y1 + dy} ${bx},${y2 - dy} ${bx},${y2}`, mid: { x: mid3(ax, ax, bx, bx), y: (y1 + y2) / 2 } };
  }
  // Out of the nodes off-centre (the centre is the neighbours' links), along the gaps close to the rows
  // (the middle of a gap holds the neighbours' labels), down the lane.
  const fx = a.x + NODE_W * 0.78 + offset;
  const tx = b.x + NODE_W * 0.78 + offset;
  const near = 14 + offset;
  const gapA = downward ? rows[a.group]!.bottom + near : rows[a.group]!.top - near;
  const gapB = downward ? rows[b.group]!.top - near : rows[b.group]!.bottom + near;
  return {
    d: `M${fx},${y1} L${fx},${gapA} L${laneX},${gapA} L${laneX},${gapB} L${tx},${gapB} L${tx},${y2}`,
    mid: { x: laneX, y: (gapA + gapB) / 2 },
  };
}

export function ProgressionGraph({
  project,
  report,
  selected,
  onSelect,
}: {
  project: ProjectSpec;
  report: ProgressionReport;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const p = project.progression;
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const across = layoutAcross(project, report);
  const down = layoutDown(project, report);
  const laneCount = (l: Layout) =>
    p.connections.filter((c) => {
      const a = l.nodes.get(c.from);
      const b = l.nodes.get(c.to);
      return a && b && Math.abs(a.group - b.group) > 1;
    }).length;
  const sizeOf = (l: Layout) =>
    l.orientation === "across" ? { width: l.width, height: l.height + laneCount(l) * LANE } : { width: l.width + laneCount(l) * LANE, height: l.height };
  // Whichever shows the graph bigger here (ties go across).
  const layout = fitView(box, sizeOf(down)).s > fitView(box, sizeOf(across)).s * 1.05 ? down : across;
  const size = sizeOf(layout);
  const { nodes } = layout;

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
    const far = Math.abs(a.group - b.group) > 1;
    const lane = far ? layout.laneStart + lanes++ * LANE : null;
    const label = c.requires.map(abilityName).join(" + ");
    const classes = ["edge", c.status, selected === c.id && "selected", flagged.has(c.id) && "flagged"].filter(Boolean).join(" ");
    const path = layout.orientation === "across" ? edgeAcross(a, b, k * 10, lane) : edgeDown(a, b, k * 10, lane, layout.rows);
    return [{ c, label, classes, ...path }];
  });

  return (
    <div className="progression-graph" ref={boxRef}>
      {box.width > 0 && (
        <PanZoom
          box={box}
          content={size}
          resetKey={layout.orientation}
          svgProps={{ role: "group", "aria-label": "Progression graph", "data-testid": "progression-graph", "data-orientation": layout.orientation }}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="edge-arrow" />
            </marker>
          </defs>
          {layout.headings.map((h) => (
            <text key={h.text} x={h.x} y={h.y} className="column-heading">
              {h.text}
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
        </PanZoom>
      )}
    </div>
  );
}
