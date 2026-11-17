import { z } from "zod";
import { Color, Id, PieceKind, uniqueId, type BiomeAsset, type Handler, type OperationCall, type ProjectSpec, type Prop, type WorldPiece, type WorldRoom } from "@anomaly/core";
import { StageError, type ArtContext, type StageResult } from "./stages.ts";
import { ask, style } from "./world.ts";

/**
 * Game stages: art for the parts of a game that aren't characters or room
 * dressings. Each returns operations like every stage (one undoable AI change),
 * validated by the whole-project check when saved. Nothing here knows what a
 * prop, screen or item is for: the models get their names, sizes, colors and
 * handlers as data.
 */

/** Cells per side of a generated sheet (props, icons): 2x2 for up to 4, else 3x3. */
const sheetSide = (n: number) => (n <= 4 ? 2 : 3);
const PER_SHEET = 9;
const KIT_MAX = 64;
const slug = (text: string, fallback: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 40) || fallback;
const CELL_NAMES = ["top-left", "top-middle", "top-right", "middle-left", "centre", "middle-right", "bottom-left", "bottom-middle", "bottom-right"];
const cellName = (i: number, side: number) => (side === 3 ? CELL_NAMES[i]! : ["top-left", "top-right", "bottom-left", "bottom-right"][i]!);

async function paintSheet(ctx: ArtContext, prompt: string, quality: string, label: string): Promise<Buffer> {
  if (ctx.signal?.aborted) throw new StageError("cancelled");
  const img = await ctx.image.generate({ prompt, aspectRatio: "1:1", transparent: true, quality, signal: ctx.signal });
  ctx.spend(img.usage);
  const file = await ctx.files.put(img.image, img.ext);
  ctx.log({ text: `${label} (${img.model}, ${quality})`, cost: img.usage.cost, file });
  return img.image;
}

type Slice = { png: Buffer; width: number; height: number };

/**
 * Paint things on one transparent sheet (`what`: one description each) and cut it
 * into them, by cell. A cell that comes back empty (the model drew fewer things,
 * or two ran together) is painted again on its own.
 */
async function paintCells(ctx: ArtContext, what: string[], sheet: (cells: string, side: number) => string, quality: string, label: string, maxSize: number): Promise<Map<number, Slice>> {
  const side = sheetSide(what.length);
  const cells = what.map((w, i) => `${cellName(i, side)} cell: ${w}`).join("; ") + (what.length < side * side ? ". Leave the other cells empty." : ".");
  const image = await paintSheet(ctx, sheet(cells, side), quality, label);
  const out = new Map<number, Slice>((await ctx.renderer.sliceGrid(image, side, side, maxSize)).filter((c) => c.cell < what.length).map((c) => [c.cell, c]));
  for (const [i, w] of what.entries()) {
    if (out.has(i)) continue;
    ctx.log({ text: `the cell for "${w.slice(0, 60)}" came back empty; painting it on its own` });
    const single = await paintSheet(ctx, sheet(`${w}.`, 1), quality, `${label}: again, one`);
    const [only] = await ctx.renderer.sliceGrid(single, 1, 1, maxSize);
    if (only) out.set(i, only);
  }
  return out;
}

/** "a 3x3 grid of separate <things>" or "one <thing>" for a sheet prompt. */
const grid = (side: number, things: string, thing: string) => (side === 1 ? `one ${thing}` : `a ${side}x${side} grid of separate ${things}`);

// --- props --------------------------------------------------------------------------

export interface PropArtInput {
  /** The world room whose props to draw, with its biome's kit. */
  worldRoomId: string;
}

const PropPicks = z.object({
  props: z
    .array(
      z.object({
        id: z.string(),
        /** A kit piece id, or null to paint a new one. */
        piece: z.string().nullable().default(null),
        paint: z
          .object({
            name: z.string().max(80),
            description: z.string().max(300),
            kind: PieceKind.default("decor"),
            glow: Color.optional(),
          })
          .optional(),
      }),
    )
    .max(100),
});

/** A handler as one line of data: event, conditions, effects and their fields. */
function handlerLine(h: Handler): string {
  const fields = (o: object) =>
    Object.entries(o)
      .filter(([k]) => k !== "type")
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" ");
  const when = h.when.length ? ` when ${JSON.stringify(h.when)}` : "";
  return `${h.on.type}${fields(h.on) ? ` (${fields(h.on)})` : ""}${when}: ${h.do.map((e) => `${e.type} ${fields(e)}`.trim()).join(", ") || "nothing"}`;
}

/** What the picking model is told about a prop. */
function propData(prop: Prop, project: ProjectSpec) {
  const items = new Map(project.world.items.map((i) => [i.id, i.name]));
  const named = JSON.stringify(prop.handlers).match(/"item":"([a-z0-9_]+)"/g)?.map((m) => m.slice(8, -1)) ?? [];
  const switchText = (v: Prop["solid"]) => (typeof v === "boolean" ? String(v) : `while ${JSON.stringify(v)}`);
  return {
    id: prop.id,
    name: prop.name ?? null,
    size: `${prop.width}x${prop.height}px`,
    color: prop.color,
    solid: switchText(prop.solid),
    visible: switchText(prop.visible),
    ...(prop.health !== null ? { health: prop.health } : {}),
    ...(prop.bounce ? { bounce: true } : {}),
    ...(prop.prompt ? { prompt: prop.prompt } : {}),
    handlers: prop.handlers.map(handlerLine).join(" | ").slice(0, 600),
    ...(named.length ? { items: [...new Set(named)].map((id) => `${id} = ${items.get(id) ?? id}`) } : {}),
  };
}

/** The biome a room's props are drawn from: its dressing's, else one dressing a room of its region, else the only kit. */
function biomeForRoom(project: ProjectSpec, room: WorldRoom): BiomeAsset {
  const kits = project.art.assets.filter((a): a is BiomeAsset => a.kind === "biome" && !!a.kit);
  const byId = (id?: string) => kits.find((b) => b.id === id);
  const near = project.world.rooms.find((r) => r.regionId === room.regionId && byId(r.dressing?.biome));
  const biome = byId(room.dressing?.biome) ?? byId(near?.dressing?.biome) ?? (kits.length === 1 ? kits[0] : undefined);
  if (!biome) throw new StageError(`dress ${room.name} with a biome first (its props are drawn from the biome's kit)`);
  return biome;
}

/**
 * Draw a room's props: one cheap text call picks the best kit piece of the room's
 * biome for each prop without art (from its name, size, colors and handlers), or
 * describes a piece to paint when none fits; missing pieces are painted on one
 * small transparent sheet and added to the kit. Then each prop gets its art.
 */
export async function propArtStage(ctx: ArtContext, input: PropArtInput): Promise<StageResult> {
  const project = ctx.project();
  const room = project.world.rooms.find((r) => r.id === input.worldRoomId);
  if (!room) throw new StageError(`no world room "${input.worldRoomId}"`);
  const props = room.props.filter((p) => !p.art);
  if (props.length === 0) throw new StageError(`every prop in ${room.name} has art already`);
  const biome = biomeForRoom(project, room);
  const kit = biome.kit!;
  const picks = await ask(
    ctx,
    PropPicks,
    {
      system: "You are a 2D game artist choosing sprites for the objects of a side-view platformer room. You go by what each object is and does in the game.",
      content: [{ type: "text", text: propPickPrompt(biome, kit.pieces, props.map((p) => propData(p, project))) }],
      maxTokens: 3000,
    },
    "choosing pieces for the props",
  );
  const pieceIds = new Set(kit.pieces.map((p) => p.id));
  const chosen = new Map<string, string>();
  const toPaint: { prop: Prop; name: string; description: string; kind: z.infer<typeof PieceKind>; glow?: string }[] = [];
  for (const prop of props) {
    const pick = picks.props.find((p) => p.id === prop.id);
    if (pick?.piece && pieceIds.has(pick.piece)) chosen.set(prop.id, pick.piece);
    else toPaint.push({ prop, name: pick?.paint?.name ?? prop.name ?? prop.id, description: pick?.paint?.description ?? prop.name ?? prop.id, kind: pick?.paint?.kind ?? "decor", glow: pick?.paint?.glow });
  }

  const operations: OperationCall[] = [];
  const space = KIT_MAX - kit.pieces.length;
  const painting = toPaint.slice(0, Math.min(PER_SHEET, space));
  if (toPaint.length > painting.length) ctx.log({ text: `${toPaint.length - painting.length} prop(s) keep their color (the kit is full or one sheet is enough for now)` });
  if (painting.length > 0) {
    const what = painting.map(({ prop, description }) => {
      const shape = prop.width > prop.height * 1.3 ? "wider than tall" : prop.height > prop.width * 1.3 ? "taller than wide" : "about as wide as tall";
      return `${description} (${shape}, its color around ${prop.color})`;
    });
    const sheet = (cells: string, side: number) =>
      `Sprite sheet: ${grid(side, "objects", "object")} for a 2D side-view platformer set in ${biome.brief}. ${cells} Each object isolated and centred${side > 1 ? " in its cell" : ""}, filling most of it, with empty space around it, side view, on a fully transparent background. ${style(project.art.direction)}`;
    const cells = await paintCells(ctx, what, sheet, kit.quality === "final" ? "medium" : "low", `painting ${painting.length} piece(s) for props`, 384);
    const added: WorldPiece[] = [];
    for (const [i, want] of painting.entries()) {
      const cell = cells.get(i);
      if (!cell) {
        ctx.log({ text: `nothing came back for ${want.prop.id}; it keeps its color` });
        continue;
      }
      const id = uniqueId(`prop_${slug(want.name, "piece")}`.slice(0, 50), [...kit.pieces, ...added].map((p) => p.id));
      if (!Id.safeParse(id).success) continue;
      added.push({
        id,
        file: await ctx.files.put(cell.png, "png"),
        name: want.name,
        kind: want.kind === "span" ? "decor" : want.kind,
        width: cell.width,
        height: cell.height,
        size: Math.min(1200, Math.max(8, want.prop.height)),
        ...(want.glow ? { glow: want.glow } : {}),
      });
      chosen.set(want.prop.id, id);
    }
    if (added.length) {
      operations.push({ name: "setBiomeKit", input: { assetId: biome.id, kit: { ...kit, pieces: [...kit.pieces, ...added] } } });
      ctx.log({ text: `added ${added.map((p) => p.name).join(", ")} to ${biome.name}'s kit` });
    }
  }
  for (const [propId, piece] of chosen) operations.push({ name: "updateProp", input: { roomId: room.id, propId, changes: { art: { biome: biome.id, piece } } } });
  return { operations, summary: `drew ${chosen.size} of ${props.length} prop(s) in ${room.name}${painting.length ? ` (${painting.length} painted)` : ""}` };
}

function propPickPrompt(biome: BiomeAsset, pieces: WorldPiece[], props: ReturnType<typeof propData>[]): string {
  return [
    `Choose a sprite for each object (prop) of a room in a 2D side-view platformer. Biome: ${biome.brief}.`,
    "A prop is a rectangle in the room (x right, y down, characters are about 40px tall); the sprite is drawn fitted to its rectangle. What it is comes from its name, size, color and handlers (what happens when the player touches, uses (interact), hits or destroys it, with conditions on the run's flags and items).",
    `Kit pieces (JSON): ${JSON.stringify(pieces.map((p) => ({ id: p.id, name: p.name, kind: p.kind, aspect: +(p.width / p.height).toFixed(2) })))}`,
    `Props (JSON): ${JSON.stringify(props)}`,
    "For each prop give the id of the kit piece that best shows what it is, with a similar shape (aspect = width/height) to its rectangle. If no piece fits well, set piece to null and describe one to paint: a short name, a one-sentence description of the object (what it looks like, not what it does), its kind (structure, decor, light, hanging) and glow '#rrggbb' if it gives off light. Props that do different things should look different.",
    'Reply with JSON only: {"props": [{"id", "piece": "<piece id>" | null, "paint"?: {"name", "description", "kind", "glow"?}}]}',
  ].join("\n");
}

// --- modals --------------------------------------------------------------------------

export interface ModalArtInput {
  modalId: string;
  /** Extra direction from the creator. */
  feedback?: string;
}

/** Illustrate a modal from its title and text, in the game's art direction (one image). */
export async function modalArtStage(ctx: ArtContext, input: ModalArtInput): Promise<StageResult> {
  const project = ctx.project();
  const modal = project.world.modals.find((m) => m.id === input.modalId);
  if (!modal) throw new StageError(`no modal "${input.modalId}"`);
  if (ctx.signal?.aborted) throw new StageError("cancelled");
  const img = await ctx.image.generate({ prompt: modalPrompt(project, modal, input.feedback), aspectRatio: "3:2", quality: "low", signal: ctx.signal });
  ctx.spend(img.usage);
  const file = await ctx.files.put(img.image, img.ext);
  ctx.log({ text: `illustration (${img.model}, low)`, cost: img.usage.cost, file });
  return { operations: [{ name: "updateModal", input: { modalId: modal.id, changes: { image: file } } }], summary: `illustrated "${modal.title || modal.id}"` };
}

export function modalPrompt(project: ProjectSpec, modal: { title: string; body: string }, feedback?: string): string {
  const d = project.art.direction;
  const words = [modal.title && `"${modal.title}"`, modal.body && `It says: ${modal.body.slice(0, 600)}`].filter(Boolean).join(". ");
  return [
    `A wide illustration for a screen of the 2D side-view platformer "${project.name}". The screen: ${words || "a pause between scenes"}.`,
    "Paint the scene or mood it describes, as a single evocative image with a clear focal point and room to breathe; it is shown above the screen's text.",
    feedback?.trim() ? `Creator's direction: ${feedback.trim()}.` : "",
    `Style: ${d.style} Preferred palette: ${d.palette.join(", ")}. No text, no letters, no logos, no UI, no borders or frames.`,
  ]
    .filter(Boolean)
    .join(" ");
}

// --- items ---------------------------------------------------------------------------

/** Draw icons for every item that has none: one generated sheet per 9 items, cut into icons. */
export async function itemArtStage(ctx: ArtContext): Promise<StageResult> {
  const project = ctx.project();
  const items = project.world.items.filter((i) => !i.icon);
  if (items.length === 0) throw new StageError("every item has an icon already");
  const operations: OperationCall[] = [];
  for (let start = 0; start < items.length; start += PER_SHEET) {
    const batch = items.slice(start, start + PER_SHEET);
    const what = batch.map((item) => `${item.name}${item.description ? ` (${item.description.slice(0, 160)})` : ""}, mostly ${item.color}`);
    const sheet = (cells: string, side: number) =>
      `Sprite sheet: ${grid(side, "item icons", "item icon")} for a 2D platformer game. ${cells} Each one a single object, centred${side > 1 ? " in its cell" : ""} with empty space around it, a bold readable silhouette at small size, three-quarter view, on a fully transparent background. ${style(project.art.direction)}`;
    const sliced = await paintCells(ctx, what, sheet, "low", `icons for ${batch.map((i) => i.name).join(", ")}`, 128);
    for (const [i, item] of batch.entries()) {
      const cell = sliced.get(i);
      if (!cell) {
        ctx.log({ text: `nothing came back for ${item.name}` });
        continue;
      }
      operations.push({ name: "updateItem", input: { itemId: item.id, changes: { icon: await ctx.files.put(cell.png, "png") } } });
    }
  }
  if (operations.length === 0) throw new StageError("the icon sheet came back empty");
  return { operations, summary: `drew icons for ${operations.length} item(s)` };
}
