import { useEffect, useRef, useState } from "react";
import { askConfirm } from "../ui/confirm.tsx";
import { menuKeyDown, usePopover } from "../ui/usePopover.ts";

/**
 * The game's name, at the left of the toolbar: click it to open the project
 * menu (rename, export the game, load the example game, start over); double-click to rename.
 * The two rare, destructive actions live here, each behind an in-page confirmation.
 */
export function ProjectMenu({
  name,
  locked,
  onRename,
  onExample,
  onReset,
  onExport,
}: {
  name: string;
  /** Editing is locked (a playtest or the AI is running): renaming and the destructive actions wait. */
  locked: boolean;
  onRename: (name: string) => Promise<boolean>;
  onExample: () => void;
  onReset: () => void;
  /** Export the game as a standalone web game (works while locked: it only reads the project). */
  onExport: () => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const [renaming, setRenaming] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  const loadExample = async () => {
    const ok = await askConfirm({
      title: "Load the example game?",
      message: "It replaces this project: a small game made from the primitives (props, items, modals, a sealed fight, an ability gate). The current project and chats are backed up first.",
      confirmLabel: "Load the example",
      danger: true,
    });
    if (ok) onExample();
  };

  const startOver = async () => {
    const ok = await askConfirm({
      title: "Start over?",
      message: "The project is replaced by the starter project (one room, the player and two enemies). The current project and chats are backed up first.",
      confirmLabel: "Start over",
      danger: true,
    });
    if (ok) onReset();
  };

  if (renaming)
    return (
      <NameField
        name={name}
        onRename={onRename}
        onDone={(refocus) => {
          setRenaming(false);
          // Back on the name, as after closing the menu.
          if (refocus) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(".project-name")?.focus());
        }}
      />
    );

  return (
    <div className="project-menu" ref={ref}>
      <button
        type="button"
        className="project-name"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name}: project menu`}
        title="Project: rename, export, example game, start over (double-click to rename)"
        onClick={() => setOpen(!open)}
        onDoubleClick={() => {
          if (locked) return;
          setOpen(false);
          setRenaming(true);
        }}
      >
        <span className="project-name-text">{name}</span>
        <span className="caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="menu project-menu-list" role="menu" aria-label="Project" ref={menuRef} onKeyDown={menuKeyDown}>
          <button type="button" role="menuitem" disabled={locked} onClick={() => choose(() => setRenaming(true))}>
            Rename game
          </button>
          <button type="button" role="menuitem" onClick={() => choose(onExport)}>
            Export game…
            <small>A web build anyone can play in a browser</small>
          </button>
          <div className="menu-separator" role="separator" />
          <button type="button" role="menuitem" disabled={locked} onClick={() => choose(() => void loadExample())}>
            Load the example game…
            <small>A small finished game to explore</small>
          </button>
          <button type="button" role="menuitem" className="danger" disabled={locked} onClick={() => choose(() => void startOver())}>
            Start over…
            <small>Back to the starter project</small>
          </button>
          <p className="menu-note">{locked ? "Stop the playtest or wait for the AI first." : "Both back up the current project and chats first."}</p>
        </div>
      )}
    </div>
  );
}

/** The name, editable in place: Enter or leaving the field saves, Escape cancels. */
function NameField({ name, onRename, onDone }: { name: string; onRename: (name: string) => Promise<boolean>; onDone: (refocus: boolean) => void }) {
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => inputRef.current?.select(), []);

  const commit = async (refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    if (next && next !== name) await onRename(next);
    onDone(refocus);
  };

  return (
    <input
      ref={inputRef}
      className="project-name-input"
      aria-label="Game name"
      value={value}
      maxLength={120}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          done.current = true;
          onDone(true);
        }
      }}
      style={{ width: `${Math.max(10, value.length + 2)}ch` }}
    />
  );
}
