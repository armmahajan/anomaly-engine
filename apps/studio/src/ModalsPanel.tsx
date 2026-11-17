import { useEffect, useState } from "react";
import { modalImageChoices, type ChangeResult, type Effect, type Modal, type ProjectSpec } from "@anomaly/core";
import type { Session } from "./session.ts";
import { fileUrl } from "./api.ts";
import { EffectList } from "./HandlerEditor.tsx";

const MAX_BUTTONS = 4;
type Button = Modal["buttons"][number];

/** Game tab: the game's modals: create, edit (title, text, image, buttons and their effects), preview in the runtime, delete. */
export function ModalsPanel({ project, session, locked }: { project: ProjectSpec; session: Session; locked: boolean }) {
  const { modals } = project.world;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const modal = modals.find((m) => m.id === selectedId) ?? modals[0] ?? null;

  const run = async (op: string, input: unknown): Promise<ChangeResult> => {
    const result = await session.applyOperation(op, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result;
  };
  const update = (changes: Partial<Omit<Modal, "id">>) => modal && void run("updateModal", { modalId: modal.id, changes });

  // The preview follows the selected modal and its edits (the runtime has the new project by now); playing ends it.
  const shown = previewing && !locked && modal ? JSON.stringify(modal) : null;
  useEffect(() => {
    if (shown) session.previewModal(modal!.id);
    else session.previewModal(null);
  }, [shown]);
  useEffect(() => () => void session.previewModal(null), [session]);

  const create = async () => {
    const result = await run("createModal", { title: "New modal" });
    if (result.ok) setSelectedId(result.project.world.modals.at(-1)!.id);
  };
  const setButton = (i: number, button: Button) => update({ buttons: modal!.buttons.map((b, j) => (j === i ? button : b)) });

  return (
    <div className="modals-panel" data-testid="modals-panel">
      <h3>Modals</h3>
      <p className="hint">Screens over the game (title, text, image, buttons). Gameplay pauses while one is open. Show one with showModal, or endGame to end the run after it.</p>
      <div className="modal-list" role="list">
        {modals.map((m) => (
          <button key={m.id} type="button" role="listitem" className={m === modal ? "modal-chip selected" : "modal-chip"} aria-pressed={m === modal} onClick={() => setSelectedId(m.id)}>
            {m.title || m.id}
          </button>
        ))}
        <button type="button" disabled={locked} onClick={() => void create()}>
          + Modal
        </button>
      </div>
      {modal && (
        <div className="modal-editor" data-testid={`modal-${modal.id}`}>
          <div className="modal-editor-head">
            <code>{modal.id}</code>
            <button type="button" aria-pressed={previewing} disabled={locked} onClick={() => setPreviewing(!previewing)}>
              {previewing ? "Hide preview" : "Preview"}
            </button>
            <button type="button" disabled={locked} onClick={() => void run("deleteModal", { modalId: modal.id })}>
              Delete
            </button>
          </div>
          <div className="field">
            <label htmlFor="modal-title">Title</label>
            <TextBox id="modal-title" value={modal.title} disabled={locked} onCommit={(title) => update({ title })} />
          </div>
          <div className="field">
            <label htmlFor="modal-body">Text</label>
            <TextBox id="modal-body" multiline value={modal.body} disabled={locked} onCommit={(body) => update({ body })} />
          </div>
          <div className="field">
            <label htmlFor="modal-image">Image</label>
            <select id="modal-image" value={modal.image ?? ""} disabled={locked} onChange={(e) => update({ image: e.target.value || null })}>
              <option value="">(none)</option>
              {modalImageChoices(project).map((c) => (
                <option key={c.file} value={c.file}>
                  {c.label}
                </option>
              ))}
            </select>
            {modal.image && <img className="modal-image" src={fileUrl(modal.image)} alt="" />}
          </div>
          <span className="muted">Buttons {modal.buttons.length === 0 && "(none: one Continue button)"}</span>
          {modal.buttons.map((b, i) => (
            <div className="handler" key={i} data-testid={`modal-button-${i}`}>
              <div className="handler-row">
                <TextBox label={`button ${i} label`} value={b.label} disabled={locked} onCommit={(label) => label && setButton(i, { ...b, label })} />
                <button type="button" className="icon-button" aria-label={`remove button ${i}`} disabled={locked} onClick={() => update({ buttons: modal.buttons.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
              <EffectList effects={b.do} project={project} locked={locked} label={`button ${i} effect`} onChange={(effects: Effect[]) => setButton(i, { ...b, do: effects })} />
            </div>
          ))}
          <button
            type="button"
            className="link-button"
            disabled={locked || modal.buttons.length >= MAX_BUTTONS}
            onClick={() => update({ buttons: [...modal.buttons, { label: modal.buttons.length ? `Button ${modal.buttons.length + 1}` : "Continue", do: [] }] })}
          >
            + Button
          </button>
        </div>
      )}
    </div>
  );
}

/** A text box that commits on Enter (single line) or on leaving it: one edit, not one per keystroke. */
function TextBox({ value, onCommit, multiline, label, ...rest }: { value: string; onCommit: (text: string) => void; multiline?: boolean; label?: string; id?: string; disabled: boolean }) {
  const props = {
    ...rest,
    "aria-label": label,
    defaultValue: value,
    className: "art-text",
    onBlur: (e: { currentTarget: { value: string } }) => e.currentTarget.value !== value && onCommit(e.currentTarget.value),
  };
  return multiline ? (
    <textarea key={value} {...props} rows={3} />
  ) : (
    <input key={value} {...props} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
  );
}
