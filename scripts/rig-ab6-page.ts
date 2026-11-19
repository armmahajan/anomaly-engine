/**
 * The blind comparison page for a rig A/B round 6 run (scripts/rig-ab6.ts).
 *   node scripts/rig-ab6-page.ts <out-dir> [--seed N]
 * Writes <out>/ab6.html (one self-contained page: every image a data URI), <out>/key.json (which
 * letter is which arm, per subject: never in the page) and <out>/results.json (likeness, cost,
 * counts per subject and arm, plus the image ledger). Each candidate shows the design beside its
 * close-up, its clips playing, its match to the design and its image cost. Letters are shuffled per
 * subject with a seeded shuffle (the same seed gives the same letters).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const out = args[0];
if (!out) throw new Error("usage: node scripts/rig-ab6-page.ts <out-dir> [--seed N]");
const seed = Number(args.includes("--seed") ? args[args.indexOf("--seed") + 1] : 6);

interface Subject {
  id: string;
  name: string;
  brief: string;
  kind: string;
  clips: string[];
  conceptCost: number | null;
}
interface Result {
  arm: string;
  cost: { images: number };
  likeness: { silhouette: number; color: number; detail: number } | null;
  clips: string[];
}
const subjects = JSON.parse(readFileSync(join(out, "subjects.json"), "utf8")) as Subject[];
const arms = JSON.parse(readFileSync(join(out, "arms.json"), "utf8")) as { id: string; what: string }[];

function random(s: number) {
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (text: string) => createHash("sha256").update(text).digest().readUInt32LE(0);
function shuffle<T>(list: T[], key: string): T[] {
  const next = random(seed ^ hash(key));
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** Data URIs by content hash (an image shared by several cards is embedded once). */
const images = new Map<string, string>();
function embed(path: string, maxSide?: number): string {
  let data = readFileSync(path);
  let type = path.endsWith(".webp") ? "image/webp" : "image/png";
  if (maxSide) {
    const run = spawnSync(
      "python3",
      ["-I", "-c", "import sys, io\nfrom PIL import Image\nim = Image.open(sys.argv[1]).convert('RGB')\nim.thumbnail((int(sys.argv[2]), int(sys.argv[2])))\nb = io.BytesIO()\nim.save(b, 'WEBP', quality=90)\nsys.stdout.buffer.write(b.getvalue())", path, String(maxSide)],
      { maxBuffer: 1 << 26 },
    );
    if (run.status !== 0) throw new Error(`shrinking ${path}: ${run.stderr}`);
    data = run.stdout;
    type = "image/webp";
  }
  const key = createHash("sha256").update(data).digest("hex").slice(0, 12);
  if (!images.has(key)) images.set(key, `data:${type};base64,${data.toString("base64")}`);
  return key;
}

const LETTERS = "ABC";
const key: Record<string, Record<string, string>> = {};
const results: Record<string, unknown>[] = [];
const pct = (n: number | undefined) => (n === undefined ? "–" : `${Math.round(n * 100)}%`);
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const sections = subjects.map((subject) => {
  const done = arms.filter((a) => existsSync(join(out, subject.id, a.id, "result.json")));
  const order = shuffle(
    done.map((a) => a.id),
    subject.id,
  );
  key[subject.id] = Object.fromEntries(order.map((arm, i) => [LETTERS[i]!, arm]));
  const armResults: Record<string, Result> = {};
  for (const a of done) armResults[a.id] = JSON.parse(readFileSync(join(out, subject.id, a.id, "result.json"), "utf8")) as Result;
  results.push({ subject: subject.id, brief: subject.brief, conceptCost: subject.conceptCost, arms: armResults });
  if (order.length === 0) return "";
  const design = embed(join(out, subject.id, order[0]!, "concept.png"), 512);
  const cards = order.map((arm, i) => {
    const dir = join(out, subject.id, arm);
    const r = armResults[arm]!;
    const clips = r.clips
      .filter((c) => existsSync(join(dir, `${c}.webp`)))
      .map((c) => `<figure><img loading="lazy" src="@@${embed(join(dir, `${c}.webp`))}" alt="${esc(subject.name)} ${c}, candidate ${LETTERS[i]}"><figcaption>${c}</figcaption></figure>`)
      .join("");
    return `<article class="card">
  <h3>Candidate ${LETTERS[i]}</h3>
  <div class="side">
    <figure><img src="@@${design}" alt="${esc(subject.name)} design"><figcaption>Design</figcaption></figure>
    <figure><img src="@@${embed(join(dir, "closeup.png"))}" alt="${esc(subject.name)} rest pose, candidate ${LETTERS[i]}"><figcaption>Rig at rest</figcaption></figure>
  </div>
  <div class="clips">${clips}</div>
  <dl class="stats">
    <div><dt>Shape match</dt><dd>${pct(r.likeness?.silhouette)}</dd></div>
    <div><dt>Colour match</dt><dd>${pct(r.likeness?.color)}</dd></div>
    <div><dt>Detail kept</dt><dd>${pct(r.likeness?.detail)}</dd></div>
    <div><dt>Image cost</dt><dd>$${r.cost.images.toFixed(3)}</dd></div>
  </dl>
</article>`;
  });
  return `<section class="subject">
  <h2>${esc(subject.name)}</h2>
  <p class="brief">${esc(subject.brief)}</p>
  <div class="grid">${cards.join("\n")}</div>
</section>`;
});

const ledger = existsSync(join(out, "costs.jsonl"))
  ? readFileSync(join(out, "costs.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { what: string; cost: number })
  : [];
const spend = Math.round(ledger.reduce((s, l) => s + l.cost, 0) * 1e4) / 1e4;
writeFileSync(join(out, "results.json"), JSON.stringify({ arms, imageSpend: spend, imageCalls: ledger, subjects: results }, null, 1));
writeFileSync(join(out, "key.json"), JSON.stringify({ seed, note: "Which arm each candidate letter is, per subject. Not in the page.", subjects: key }, null, 1));

let html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rig Round Six</title>
<style>
:root { --bg: #f3f4f6; --panel: #ffffff; --fg: #1d2330; --muted: #5d6677; --line: #d9dde5; --stage: #d8d6cf; --accent: #3d6fd8 }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #12151b; --panel: #1b2029; --fg: #e5e8ee; --muted: #98a1b2; --line: #2c3340; --accent: #7aa2f7; color-scheme: dark } }
:root[data-theme="dark"] { --bg: #12151b; --panel: #1b2029; --fg: #e5e8ee; --muted: #98a1b2; --line: #2c3340; --accent: #7aa2f7; color-scheme: dark }
* { box-sizing: border-box }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; padding: 24px 16px 48px }
main { max-width: 1320px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px }
h1 { font-size: 1.7rem; margin: 0 }
.lede { color: var(--muted); max-width: 72ch; margin: 0 }
.subject { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0 }
.subject h2 { margin: 0; font-size: 1.2rem }
.brief { margin: 0; color: var(--muted); font-size: 0.9rem }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); gap: 12px }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-width: 0 }
.card h3 { margin: 0; font-size: 1rem }
.side, .clips { display: grid; grid-template-columns: 1fr 1fr; gap: 8px }
figure { margin: 0; display: flex; flex-direction: column; gap: 2px; min-width: 0 }
figure img { width: 100%; aspect-ratio: 1; object-fit: contain; background: var(--stage); border-radius: 6px; display: block; cursor: zoom-in }
figcaption { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 0 }
.stats div { background: var(--bg); border-radius: 6px; padding: 6px 8px; min-width: 0 }
.stats dt { font-size: 0.7rem; color: var(--muted) }
.stats dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600 }
dialog { border: none; padding: 0; background: transparent; max-width: 96vw; max-height: 96vh }
dialog img { max-width: 96vw; max-height: 92vh; image-rendering: auto; background: var(--stage); border-radius: 8px; display: block }
dialog::backdrop { background: rgb(0 0 0 / 0.7) }
@media (max-width: 520px) { .stats { grid-template-columns: repeat(2, 1fr) } }
</style>
</head>
<body>
<main>
  <h1>Rig round six</h1>
  <p class="lede">Three ways from a concept to an animated rig, shown blind: each subject's candidates are lettered in a shuffled order, every one built from the same chosen design with the same clip requests. Match figures compare the rig at rest with the design (shape overlap, colour where both are drawn, and how much of the design's interior detail survives). Image cost counts the image-model calls the candidate made; vision runs free on Claude Code. Click any picture to see it full size.</p>
  ${sections.join("\n")}
  <p class="lede">Total image spend for this round: $${spend.toFixed(3)}.</p>
</main>
<dialog id="zoom"><img alt=""></dialog>
<script>
const dialog = document.getElementById("zoom");
document.addEventListener("click", (e) => {
  const img = e.target.closest("figure img");
  if (img) { dialog.querySelector("img").src = img.src; dialog.querySelector("img").alt = img.alt; dialog.showModal(); }
  else if (e.target === dialog || e.target.closest("dialog")) dialog.close();
});
</script>
</body>
</html>
`;
html = html.replace(/@@([0-9a-f]{12})/g, (_, k: string) => images.get(k)!);
writeFileSync(join(out, "ab6.html"), html);
console.log(`wrote ${join(out, "ab6.html")} (${Math.round(html.length / 1024)} KB), image spend $${spend.toFixed(4)}`);
