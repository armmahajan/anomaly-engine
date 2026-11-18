/**
 * The blind voting page for a rig look A/B round 4 run (scripts/rig-ab4.ts).
 *   node scripts/rig-ab4-page.ts <out-dir> [--seed N]
 * Writes <out>/vote.html (one self-contained page: every image is a data URI), <out>/key.json
 * (which neutral label is which arm, per subject: never in the page) and <out>/results.json
 * (costs, likeness, part counts, texture sizes, animation metrics per subject and arm).
 * Every candidate of a character starts from the same design, so the design is shown once per character.
 * Candidates are shuffled per subject with a seeded shuffle, so regenerating the page keeps the
 * same labels (and key) for the same seed.
 * Publish the page as an Artifact with capabilities {db: {}}, like rig-ab-page.ts: each subject's
 * vote is the db doc votes/<subject> = {likes: ["B", "D"], best: "D" | null, note, at}.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const out = args[0];
if (!out) throw new Error("usage: node scripts/rig-ab4-page.ts <out-dir> [--seed N]");
const seed = Number(args.includes("--seed") ? args[args.indexOf("--seed") + 1] : 4);

interface Subject {
  id: string;
  name: string;
  brief: string;
}
interface ArmInfo {
  id: string;
  what: string;
}
const subjects = JSON.parse(readFileSync(join(out, "subjects.json"), "utf8")) as Subject[];
const arms = JSON.parse(readFileSync(join(out, "arms.json"), "utf8")) as ArmInfo[];

/** A small seeded random generator (mulberry32). */
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

/** Images by content hash (shared images are embedded once). Concepts are shrunk to 320 px WebP. */
const images = new Map<string, string>();
function embed(path: string, shrink = false): string {
  let data = readFileSync(path);
  let type = path.endsWith(".webp") ? "image/webp" : "image/png";
  if (shrink) {
    const run = spawnSync(
      "python3",
      ["-I", "-c", "import sys, io\nfrom PIL import Image\nim = Image.open(sys.argv[1]).convert('RGB')\nim.thumbnail((320, 320))\nb = io.BytesIO()\nim.save(b, 'WEBP', quality=85)\nsys.stdout.buffer.write(b.getvalue())", path],
      { maxBuffer: 1 << 24 },
    );
    if (run.status !== 0) throw new Error(`shrinking ${path}: ${run.stderr}`);
    data = run.stdout;
    type = "image/webp";
  }
  const key = createHash("sha256").update(data).digest("hex").slice(0, 12);
  if (!images.has(key)) images.set(key, `data:${type};base64,${data.toString("base64")}`);
  return key;
}

const LETTERS = "ABCDEFGH";
const key: Record<string, Record<string, string>> = {};
const results: Record<string, unknown>[] = [];
const page = subjects.map((subject) => {
  const done = arms.filter((a) => existsSync(join(out, subject.id, a.id, "result.json")));
  const order = shuffle(
    done.map((a) => a.id),
    subject.id,
  );
  key[subject.id] = Object.fromEntries(order.map((arm, i) => [LETTERS[i]!, arm]));
  const armResults: Record<string, unknown> = {};
  for (const a of done) armResults[a.id] = JSON.parse(readFileSync(join(out, subject.id, a.id, "result.json"), "utf8"));
  results.push({ subject: subject.id, brief: subject.brief, arms: armResults });
  return {
    id: subject.id,
    name: subject.name,
    brief: subject.brief,
    design: embed(join(out, subject.id, order[0]!, "concept.png"), true),
    candidates: order.map((arm, i) => {
      const dir = join(out, subject.id, arm);
      return { label: LETTERS[i]!, still: embed(join(dir, "closeup.png")), walk: embed(join(dir, "walk.webp")) };
    }),
  };
});

// results.json: per subject and arm, plus the image spend from the ledger.
const ledger = existsSync(join(out, "costs.jsonl"))
  ? readFileSync(join(out, "costs.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { what: string; cost: number })
  : [];
writeFileSync(
  join(out, "results.json"),
  JSON.stringify({ arms, imageSpend: Math.round(ledger.reduce((s, l) => s + l.cost, 0) * 1e4) / 1e4, imageCalls: ledger, subjects: results }, null, 1),
);
writeFileSync(join(out, "key.json"), JSON.stringify({ seed, note: "Which arm each candidate letter is, per subject. Not in vote.html.", subjects: key }, null, 1));

const html = `<title>Rig Finish Vote</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;600&display=swap">
<style>
/* One section per character: its candidates side by side (design, still, walking), each with Like / Best toggles. */
:root {
  --bg: #f3f4f6; --panel: #ffffff; --fg: #1d2330; --muted: #5d6677; --line: #d9dde5; --accent: #3d6fd8; --picked: #e6eefc; --best: #b7791f; --best-bg: #fdf3e1;
  --stage: #d8d6cf;
  --display: "Space Grotesk", "Segoe UI", system-ui, sans-serif; --body: "Inter", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #12151b; --panel: #1b2029; --fg: #e5e8ee; --muted: #98a1b2; --line: #2c3340; --accent: #7aa2f7; --picked: #24304a; --best: #e8b453; --best-bg: #3a2f1a; color-scheme: dark } }
:root[data-theme="dark"] { --bg: #12151b; --panel: #1b2029; --fg: #e5e8ee; --muted: #98a1b2; --line: #2c3340; --accent: #7aa2f7; --picked: #24304a; --best: #e8b453; --best-bg: #3a2f1a; color-scheme: dark }
* { box-sizing: border-box }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--body); line-height: 1.5; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 24px 48px }
main { max-width: 1280px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px }
h1 { font-family: var(--display); font-size: 1.8rem; margin: 0; text-wrap: balance }
.lede { color: var(--muted); max-width: 70ch; margin: 0 }
.progress, .status { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.9rem; margin: 0 }
.subject { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 14px; min-width: 0 }
.subject h2 { font-family: var(--display); font-size: 1.15rem; margin: 0 }
.subject .brief { color: var(--muted); margin: 0; font-size: 0.9rem }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 12px }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; min-width: 0 }
.card[data-like="true"] { border-color: var(--accent); background: var(--picked) }
.card[data-best="true"] { border-color: var(--best); box-shadow: 0 0 0 2px var(--best) inset }
.card h3 { font-family: var(--display); font-size: 1rem; margin: 0 }
figure { margin: 0; display: flex; flex-direction: column; gap: 4px; min-width: 0 }
figcaption { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em }
.walk { background: var(--stage); border-radius: 6px; width: 100%; aspect-ratio: 1; object-fit: contain; display: block }
.pair { display: grid; grid-template-columns: 1fr; gap: 8px }
.pair img { background: var(--stage); border-radius: 6px; width: 100%; aspect-ratio: 1; object-fit: contain; display: block }
.top { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap }
.top .text { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 6px }
.top figure { flex: 0 0 auto; width: min(100%, 180px) }
.top figure img { background: var(--stage); border-radius: 6px; width: 100%; aspect-ratio: 1; object-fit: contain; display: block }
.buttons { display: flex; gap: 8px; flex-wrap: wrap }
button { font: inherit; font-size: 0.9rem; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); cursor: pointer; min-height: 36px }
button:hover { border-color: var(--accent) }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }
button.like[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600 }
button.best[aria-pressed="true"] { background: var(--best-bg); border-color: var(--best); color: var(--fg); font-weight: 600 }
label.note { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; color: var(--muted) }
textarea { font: inherit; font-size: 0.9rem; color: var(--fg); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; min-height: 2.6em; resize: vertical; width: 100% }
</style>
<main>
  <h1>Rig Finish Vote</h1>
  <p class="lede">Each character's animated rig was finished several ways from the same design: the same shapes, bones and animation, only the look differs. For every character, compare the candidates walking and at rest (close up) against the design shown beside its name. Tick <b>Like</b> on every one you would be happy to use (as many as you want), and optionally mark one <b>Best</b>. Candidates are shuffled and named by letter only.</p>
  <p class="progress" id="progress"></p>
  <div id="subjects" style="display:flex;flex-direction:column;gap:20px"></div>
  <p class="status" id="status" role="status">Connecting to the vote store…</p>
</main>
<script>
const IMAGES = ${JSON.stringify(Object.fromEntries(images))};
const SUBJECTS = ${JSON.stringify(page)};
const votes = {};
let db = null;

const blank = () => ({ likes: [], best: null, note: "" });
const voteOf = (id) => votes[id] || (votes[id] = blank());

function render() {
  const done = SUBJECTS.filter((s) => votes[s.id] && (votes[s.id].likes.length > 0 || votes[s.id].best)).length;
  document.getElementById("progress").textContent = done + " of " + SUBJECTS.length + " characters voted";
  for (const s of SUBJECTS) {
    const v = voteOf(s.id);
    for (const c of s.candidates) {
      const card = document.getElementById("card-" + s.id + "-" + c.label);
      const like = v.likes.includes(c.label);
      const best = v.best === c.label;
      card.dataset.like = String(like);
      card.dataset.best = String(best);
      card.querySelector(".like").setAttribute("aria-pressed", String(like));
      card.querySelector(".best").setAttribute("aria-pressed", String(best));
    }
    const note = document.getElementById("note-" + s.id);
    if (document.activeElement !== note) note.value = v.note || "";
  }
}

function build() {
  const root = document.getElementById("subjects");
  for (const s of SUBJECTS) {
    const sec = document.createElement("section");
    sec.className = "subject";
    sec.setAttribute("aria-labelledby", "h-" + s.id);
    const h = document.createElement("h2");
    h.id = "h-" + s.id;
    h.textContent = s.name;
    const brief = document.createElement("p");
    brief.className = "brief";
    brief.textContent = "Brief: " + s.brief;
    const grid = document.createElement("div");
    grid.className = "grid";
    for (const c of s.candidates) {
      const card = document.createElement("article");
      card.className = "card";
      card.id = "card-" + s.id + "-" + c.label;
      const title = document.createElement("h3");
      title.textContent = "Candidate " + c.label;
      const walk = document.createElement("figure");
      const walkImg = document.createElement("img");
      walkImg.className = "walk";
      walkImg.src = IMAGES[c.walk];
      walkImg.alt = s.name + ", candidate " + c.label + ", walking";
      const walkCap = document.createElement("figcaption");
      walkCap.textContent = "Walking";
      walk.append(walkImg, walkCap);
      const pair = document.createElement("div");
      pair.className = "pair";
      for (const [src, text] of [[c.still, "At rest, close up"]]) {
        const f = document.createElement("figure");
        const img = document.createElement("img");
        img.src = IMAGES[src];
        img.alt = s.name + ", candidate " + c.label + ": " + text.toLowerCase();
        img.loading = "lazy";
        const cap = document.createElement("figcaption");
        cap.textContent = text;
        f.append(img, cap);
        pair.append(f);
      }
      const buttons = document.createElement("div");
      buttons.className = "buttons";
      const like = document.createElement("button");
      like.type = "button";
      like.className = "like";
      like.textContent = "Like";
      like.setAttribute("aria-label", "Like candidate " + c.label);
      like.addEventListener("click", () => {
        const v = voteOf(s.id);
        v.likes = v.likes.includes(c.label) ? v.likes.filter((l) => l !== c.label) : [...v.likes, c.label].sort();
        save(s.id);
      });
      const best = document.createElement("button");
      best.type = "button";
      best.className = "best";
      best.textContent = "Best";
      best.setAttribute("aria-label", "Best for " + s.name + ": candidate " + c.label);
      best.addEventListener("click", () => {
        const v = voteOf(s.id);
        v.best = v.best === c.label ? null : c.label;
        if (v.best && !v.likes.includes(c.label)) v.likes = [...v.likes, c.label].sort();
        save(s.id);
      });
      buttons.append(like, best);
      card.append(title, walk, pair, buttons);
      grid.append(card);
    }
    const label = document.createElement("label");
    label.className = "note";
    label.textContent = "Notes on " + s.name + " (optional)";
    const note = document.createElement("textarea");
    note.id = "note-" + s.id;
    note.rows = 2;
    note.addEventListener("change", () => {
      voteOf(s.id).note = note.value;
      save(s.id);
    });
    label.append(note);
    const top = document.createElement("div");
    top.className = "top";
    const words = document.createElement("div");
    words.className = "text";
    words.append(h, brief);
    const design = document.createElement("figure");
    const designImg = document.createElement("img");
    designImg.src = IMAGES[s.design];
    designImg.alt = s.name + ": the design";
    const designCap = document.createElement("figcaption");
    designCap.textContent = "Design";
    design.append(designImg, designCap);
    top.append(words, design);
    sec.append(top, grid, label);
    root.append(sec);
  }
}

async function save(subject) {
  render();
  if (!db) return;
  const v = voteOf(subject);
  try {
    await db.doc("votes/" + subject).set({ likes: v.likes, best: v.best, note: v.note || "", at: new Date().toISOString() });
    document.getElementById("status").textContent = "Saved.";
  } catch (e) {
    document.getElementById("status").textContent = "Couldn't save that vote (" + (e && e.code ? e.code : "error") + "). It's kept on this page until you reload.";
  }
}

build();
render();
const timer = setTimeout(() => { document.getElementById("status").textContent = "The vote store didn't answer; votes stay on this page only."; }, 10000);
if (typeof claude === "undefined" || !claude.use) {
  clearTimeout(timer);
  document.getElementById("status").textContent = "Votes can't be saved in this view; they stay on this page only.";
} else {
  claude.use("db").then((d) => {
    db = d;
    if (!db) { clearTimeout(timer); document.getElementById("status").textContent = "Votes can't be saved in this view; they stay on this page only."; return; }
    db.collection("votes").onSnapshot((snap) => {
      clearTimeout(timer);
      for (const doc of snap.docs) {
        const d = doc.data();
        votes[doc.id] = { likes: Array.isArray(d.likes) ? d.likes : [], best: d.best || null, note: d.note || "" };
      }
      document.getElementById("status").textContent = "Votes are saved as you click.";
      render();
    }, () => { clearTimeout(timer); document.getElementById("status").textContent = "Couldn't read earlier votes."; });
  });
}
</script>
`;
writeFileSync(join(out, "vote.html"), html);
console.log(`wrote ${join(out, "vote.html")} (${page.length} subjects, ${page.reduce((s, p) => s + p.candidates.length, 0)} candidates, ${(html.length / 1e6).toFixed(2)} MB), key.json, results.json`);
