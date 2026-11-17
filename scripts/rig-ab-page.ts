/**
 * The blind voting page for a rig A/B run (scripts/rig-ab.ts).
 *   node scripts/rig-ab-page.ts <out-dir>     -> <out-dir>/vote.html
 * Publish it as an Artifact with capabilities {db: {}}: each vote is a db doc votes/<subject> = {pick, at},
 * where pick is an arm id ("vector", "cutout", "vector-opus") or "same". Arm order is shuffled per subject
 * here, so the page only shows letters until every subject has a vote.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/rig-ab-page.ts <out-dir>");
interface Result {
  id: string;
  brief: string;
  arms: Record<string, { clips: string[]; match: { silhouette: number; color: number } | null }>;
}
const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as Result[];
const png = (path: string) => `data:image/png;base64,${readFileSync(path).toString("base64")}`;
const shuffle = <T>(list: T[]) => list.map((x) => [Math.random(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
const subjects = results.map((r) => ({
  id: r.id,
  brief: r.brief,
  concept: png(join(out, r.id, "concept.png")),
  arms: shuffle(Object.keys(r.arms)).map((arm) => ({ arm, sheet: png(join(out, r.id, arm, "sheet.png")), clips: r.arms[arm]!.clips, match: r.arms[arm]!.match })),
}));

const html = `<title>Rig Mode Vote</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;600&display=swap">
<style>
/* Layout: one subject per row; its concept, then the candidates side by side, then the vote. */
:root {
  --bg: #f3f4f6; --panel: #ffffff; --fg: #1d2330; --muted: #5d6677; --line: #d9dde5; --accent: #3d6fd8; --picked: #e6eefc;
  --stage: #d8d6cf;
  --display: "Space Grotesk", "Segoe UI", system-ui, sans-serif; --body: "Inter", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #12151b; --panel: #1b2029; --fg: #e5e8ee; --muted: #98a1b2; --line: #2c3340; --accent: #7aa2f7; --picked: #24304a; color-scheme: dark } }
:root[data-theme="dark"] { --bg: #12151b; --panel: #1b2029; --fg: #e5e8ee; --muted: #98a1b2; --line: #2c3340; --accent: #7aa2f7; --picked: #24304a; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font-family: var(--body); line-height: 1.5; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 24px 48px }
main { max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px }
h1 { font-family: var(--display); font-size: 1.8rem; margin: 0; text-wrap: balance }
.lede { color: var(--muted); max-width: 65ch; margin: 0 }
.progress { font-variant-numeric: tabular-nums; color: var(--muted) }
.subject { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 12px }
.subject h2 { font-family: var(--display); font-size: 1.05rem; margin: 0 }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px }
figure { margin: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0 }
figcaption { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em }
.frame { background: var(--stage); border-radius: 6px; aspect-ratio: 1; width: 100%; max-width: 100%; object-fit: contain; display: block }
canvas.frame { image-rendering: auto }
.votes { display: flex; flex-wrap: wrap; gap: 8px }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); cursor: pointer }
button:hover { border-color: var(--accent) }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }
button[aria-pressed="true"] { background: var(--picked); border-color: var(--accent); font-weight: 600 }
.reveal { font-size: 0.85rem; color: var(--muted) }
.status { font-size: 0.85rem; color: var(--muted) }
@media (prefers-reduced-motion: reduce) { canvas.frame { animation: none } }
</style>
<main>
  <h1>Rig Mode Vote</h1>
  <p class="lede">Each character was drawn once, then rigged in different ways. Compare each candidate with the design on the left, animated, and pick the one that looks more like it and moves better. The names stay hidden until every character has a vote.</p>
  <p class="progress" id="progress"></p>
  <div id="subjects"></div>
  <p class="status" id="status">Connecting to the vote store…</p>
</main>
<script>
const SUBJECTS = ${JSON.stringify(subjects)};
const CELL = 192, COLS = 6;
const votes = {};
let db = null;
const letters = "ABC";

function animate(canvas, sheet) {
  const img = new Image();
  img.onload = () => {
    const total = Math.round(img.height / CELL) * COLS;
    const g = canvas.getContext("2d");
    let i = 1;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const draw = () => {
      g.clearRect(0, 0, CELL, CELL);
      g.drawImage(img, (i % COLS) * CELL, Math.floor(i / COLS) * CELL, CELL, CELL, 0, 0, CELL, CELL);
      if (!reduce) i = i + 1 >= total ? 1 : i + 1;
    };
    draw();
    if (!reduce) setInterval(draw, 125);
  };
  img.src = sheet;
}

function render() {
  const done = SUBJECTS.filter((s) => votes[s.id]).length;
  document.getElementById("progress").textContent = done + " of " + SUBJECTS.length + " voted";
  const all = done === SUBJECTS.length;
  for (const s of SUBJECTS) {
    for (const [i, a] of s.arms.entries()) {
      const label = document.getElementById("label-" + s.id + "-" + i);
      label.textContent = "Candidate " + letters[i] + (all ? " · " + a.arm + (a.match ? " · " + Math.round(a.match.silhouette * 100) + "% shape match" : "") : "");
    }
    for (const b of document.querySelectorAll('[data-subject="' + s.id + '"]')) b.setAttribute("aria-pressed", String(votes[s.id] === b.dataset.pick));
  }
}

function build() {
  const root = document.getElementById("subjects");
  for (const s of SUBJECTS) {
    const sec = document.createElement("section");
    sec.className = "subject";
    const h = document.createElement("h2");
    h.textContent = s.brief;
    sec.append(h);
    const row = document.createElement("div");
    row.className = "row";
    const concept = document.createElement("figure");
    concept.innerHTML = '<img class="frame" alt="Design"><figcaption>Design</figcaption>';
    concept.querySelector("img").src = s.concept;
    row.append(concept);
    s.arms.forEach((a, i) => {
      const fig = document.createElement("figure");
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = CELL;
      canvas.className = "frame";
      canvas.setAttribute("aria-label", "Candidate " + letters[i] + ", animated");
      const cap = document.createElement("figcaption");
      cap.id = "label-" + s.id + "-" + i;
      fig.append(canvas, cap);
      row.append(fig);
      animate(canvas, a.sheet);
    });
    sec.append(row);
    const bar = document.createElement("div");
    bar.className = "votes";
    const choices = [...s.arms.map((a, i) => [a.arm, letters[i] + " looks better"]), ["same", "About the same"]];
    for (const [pick, text] of choices) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.dataset.subject = s.id;
      b.dataset.pick = pick;
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => vote(s.id, pick));
      bar.append(b);
    }
    sec.append(bar);
    root.append(sec);
  }
}

async function vote(subject, pick) {
  votes[subject] = pick;
  render();
  if (!db) return;
  try {
    await db.doc("votes/" + subject).set({ pick, at: new Date().toISOString() });
    document.getElementById("status").textContent = "Saved.";
  } catch (e) {
    document.getElementById("status").textContent = "Couldn't save that vote (" + (e && e.code ? e.code : "error") + "). It's kept on this page until you reload.";
  }
}

build();
render();
const timer = setTimeout(() => { document.getElementById("status").textContent = "The vote store didn't answer; votes stay on this page only."; }, 10000);
claude.use("db").then((d) => {
  db = d;
  if (!db) { clearTimeout(timer); document.getElementById("status").textContent = "Votes can't be saved in this view; they stay on this page only."; return; }
  db.collection("votes").onSnapshot((snap) => {
    clearTimeout(timer);
    for (const doc of snap.docs) votes[doc.id] = doc.data().pick;
    document.getElementById("status").textContent = "Votes are saved as you click.";
    render();
  }, () => { clearTimeout(timer); document.getElementById("status").textContent = "Couldn't read earlier votes."; });
});
</script>
`;
writeFileSync(join(out, "vote.html"), html);
console.log(`wrote ${join(out, "vote.html")} (${subjects.length} subjects, ${(html.length / 1e6).toFixed(1)} MB)`);
