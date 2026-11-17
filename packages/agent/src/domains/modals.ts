import { z } from "zod";
import { DeleteModalInput, Id, SetMapInput } from "@anomaly/core";
import type { DomainTools } from "./types.ts";

/** A compact button spec for the model (the operations validate fully). */
const Buttons = z
  .array(z.strictObject({ label: z.string(), do: z.array(z.record(z.string(), z.unknown())).optional() }))
  .max(4)
  .describe("Each runs its effects (as a handler's do), then closes. None = one Continue.");
const fields = {
  title: z.string().optional(),
  body: z.string().optional(),
  image: z.string().nullable().optional().describe("A file ref already in the project, or null."),
  buttons: Buttons.optional(),
};

export const modalTools: DomainTools<"createModal" | "updateModal" | "deleteModal" | "setMap"> = {
  descriptions: {
    createModal:
      "Create a modal: a screen over the game (title, body, image, buttons); gameplay pauses while open. Shown by the showModal effect, or endGame {modal} (the game restarts after). Title screens, endings, credits are modals.",
    updateModal: "Change a modal's fields (buttons replace the list).",
    deleteModal: "Delete a modal (fails while a handler or another modal's button shows it).",
    setMap: "Turn the map screen (M / Tab) on or off: visited rooms plus those revealed by the revealMap effect.",
  },
  schemas: {
    createModal: z.strictObject({ id: Id.optional(), ...fields }),
    updateModal: z.strictObject({ modalId: Id, changes: z.strictObject(fields) }),
    deleteModal: DeleteModalInput,
    setMap: SetMapInput,
  },
  summary: (project) => {
    const { modals, map } = project.world;
    const effects = (list: object[]) => list.map((e) => JSON.stringify(e)).join(", ") || "close";
    return [
      modals.length ? "Modals:" : "Modals: none.",
      ...modals.map((m) => `- ${m.id} "${m.title}": ${m.buttons.length ? m.buttons.map((b) => `[${b.label}] → ${effects(b.do)}`).join("; ") : "[Continue]"}`),
      `Map: ${map.enabled ? "on" : "off"}.`,
    ];
  },
};
