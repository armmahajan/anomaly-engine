import { z } from "zod";
import { Id } from "../common.ts";
import { allHandlers } from "../events/lint.ts";
import type { Effect } from "../events/events.ts";
import { slugify, uniqueId } from "../ids.ts";
import type { OperationResult } from "../operations.ts";
import type { ProjectSpec } from "../schema.ts";
import { fail, known, parse, withWorld } from "../world/opHelpers.ts";
import { Modal } from "../world/world.ts";

/** Modal and map operations: screens over the game (text, an image, buttons that run effects) and the optional map. */

const ModalChanges = {
  title: z.string().max(120).optional(),
  body: z.string().max(4000).optional(),
  image: Modal.shape.image.removeDefault().optional().describe("A file in the project's asset store, or null for none."),
  buttons: Modal.shape.buttons.removeDefault().optional().describe("Each runs its effects, then closes the modal; none = one Continue button."),
};

export const CreateModalInput = z.strictObject({ id: Id.optional().describe("Defaults to the title in snake_case."), ...ModalChanges });

export function createModal(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(CreateModalInput, input, "createModal");
  if (!p.ok) return p;
  const taken = project.world.modals.map((m) => m.id);
  if (p.data.id && taken.includes(p.data.id)) return fail("invalid_input", `a modal "${p.data.id}" already exists`);
  const { id = uniqueId(slugify(p.data.title ?? "", "modal"), taken), ...rest } = p.data;
  return withWorld(project, { modals: [...project.world.modals, Modal.parse({ ...rest, id })] });
}

export const UpdateModalInput = z.strictObject({ modalId: Id, changes: z.strictObject(ModalChanges) });

export function updateModal(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(UpdateModalInput, input, "updateModal");
  if (!p.ok) return p;
  const modals = project.world.modals.slice();
  const i = modals.findIndex((m) => m.id === p.data.modalId);
  if (i < 0) return fail("not_found", `no modal "${p.data.modalId}"${known(modals.map((m) => m.id))}`);
  const changes = Object.fromEntries(Object.entries(p.data.changes).filter(([, v]) => v !== undefined));
  modals[i] = { ...modals[i]!, ...changes };
  return withWorld(project, { modals });
}

export const DeleteModalInput = z.strictObject({ modalId: Id });

export function deleteModal(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(DeleteModalInput, input, "deleteModal");
  if (!p.ok) return p;
  const { modalId } = p.data;
  const { modals } = project.world;
  if (!modals.some((m) => m.id === modalId)) return fail("not_found", `no modal "${modalId}"${known(modals.map((m) => m.id))}`);
  const users = modalUses(project, modalId).filter((u) => u.modal !== modalId);
  if (users.length > 0) {
    const where = [...new Set(users.map((u) => placeOf(project, u.path)))];
    return fail("invalid_input", `modal "${modalId}" is shown by ${where.join(", ")}; change those first`);
  }
  return withWorld(project, { modals: modals.filter((m) => m.id !== modalId) });
}

export const SetMapInput = z.strictObject({ enabled: z.boolean().describe("M / Tab opens a map of the rooms visited or revealed.") });

export function setMap(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetMapInput, input, "setMap");
  if (!p.ok) return p;
  return withWorld(project, { map: { enabled: p.data.enabled } });
}

export const modalOperations = { createModal, updateModal, deleteModal, setMap };

/** The modal an effect shows (showModal, or endGame with a modal), if any. */
export const shownModal = (effect: Effect): string | undefined => (effect.type === "showModal" || effect.type === "endGame" ? effect.modal : undefined);

/** Every place that shows `modalId` (handlers and modal buttons), as dotted paths; `modal` is the modal a button belongs to. */
export function modalUses(project: ProjectSpec, modalId: string): { path: string; modal?: string }[] {
  const uses: { path: string; modal?: string }[] = [];
  for (const { path, handlers } of allHandlers(project)) {
    handlers.forEach((h, i) => h.do.some((e) => shownModal(e) === modalId) && uses.push({ path: `${path}.${i}` }));
  }
  project.world.modals.forEach((m, i) =>
    m.buttons.forEach((b, j) => b.do.some((e) => shownModal(e) === modalId) && uses.push({ path: `world.modals.${i}.buttons.${j}`, modal: m.id })),
  );
  return uses;
}

/** Images a modal can show: those already in the project (biome backdrops, chosen character concepts and renders). */
export function modalImageChoices(project: ProjectSpec): { file: string; label: string }[] {
  const out = new Map<string, string>();
  for (const asset of project.art.assets) {
    if (asset.kind === "biome" && asset.kit) out.set(asset.kit.backdrop, `${asset.name} backdrop`);
    if (asset.chosen) out.set(asset.chosen.file, `${asset.name} concept`);
    if (asset.kind === "character" && asset.preview) out.set(asset.preview.file, `${asset.name} render`);
  }
  for (const modal of project.world.modals) if (modal.image && !out.has(modal.image)) out.set(modal.image, modal.image);
  return [...out].map(([file, label]) => ({ file, label }));
}

/** Where a handler or button path is, in the creator's words: "the Pulse Pistol prop in Server Catacombs 3". */
export function placeOf(project: ProjectSpec, path: string): string {
  const rooms = project.world.rooms;
  const room = /^world\.rooms\.(\d+)\.(props|spawns|handlers)(?:\.(\d+))?/.exec(path);
  if (room) {
    const r = rooms[Number(room[1])];
    const roomName = r ? `"${r.name}"` : "a room";
    const i = room[3] === undefined ? -1 : Number(room[3]);
    if (room[2] === "props") return `the ${r?.props[i] ? `"${r.props[i]!.name}"` : ""} prop in ${roomName}`.replace("the  prop", "a prop");
    if (room[2] === "spawns") return `the ${r?.spawns[i] ? `"${r.spawns[i]!.characterId}"` : ""} spawn in ${roomName}`.replace("the  spawn", "a spawn");
    return `a handler of the room ${roomName}`;
  }
  if (/^world\.handlers/.test(path)) return "a game handler (Game > Game handlers)";
  const modal = /^world\.modals\.(\d+)/.exec(path);
  if (modal) {
    const m = project.world.modals[Number(modal[1])];
    return `a button of the screen "${m?.title || m?.id || "?"}"`;
  }
  return path;
}
