import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Inputs that edit the project without flooding it: a field keeps a local draft
 * while the creator works and commits it as one operation (one revision, one
 * undo step) when they pause, leave the field, or press Enter. A draft follows
 * the project when nothing is pending, so Undo and other writers show up.
 */

/** `commit` resolves false when the edit was refused (the draft then goes back to the project's value). */
export type Commit<T> = (value: T) => Promise<boolean> | boolean | void;

export function useDraft<T>(value: T, commit: Commit<T>, delay: number, same: (a: T, b: T) => boolean = Object.is) {
  const [draft, setDraft] = useState(value);
  const pending = useRef<{ value: T; timer: ReturnType<typeof setTimeout> } | null>(null);
  const latest = useRef({ value, commit, same });
  latest.current = { value, commit, same };

  useEffect(() => {
    if (!pending.current) setDraft(value);
  }, [value]);

  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    const { value: current, commit: save, same: eq } = latest.current;
    if (eq(p.value, current)) return;
    void Promise.resolve(save(p.value)).then((ok) => {
      if (ok === false && !pending.current) setDraft(latest.current.value);
    });
  }, []);

  const change = useCallback(
    (next: T) => {
      setDraft(next);
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = { value: next, timer: setTimeout(flush, delay) };
    },
    [delay, flush],
  );

  /** Drop the draft (Escape): back to the project's value. */
  const revert = useCallback(() => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    setDraft(latest.current.value);
  }, []);

  // Leaving the view keeps what was typed.
  useEffect(() => () => flush(), [flush]);

  return { draft, change, flush, revert };
}

interface TextProps {
  value: string;
  onCommit: Commit<string>;
  label: string;
  /** Visible label text (default: none, `label` is the accessible name). */
  caption?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  className?: string;
  testId?: string;
}

/** Free text: commits a second after the last keystroke, or on leaving the field. */
export function DraftText({ value, onCommit, label, caption, placeholder, disabled, multiline, rows = 3, maxLength, className, testId }: TextProps) {
  const { draft, change, flush, revert } = useDraft(value, onCommit, 1000);
  const common = {
    "aria-label": label,
    value: draft,
    placeholder,
    disabled,
    maxLength,
    "data-testid": testId,
    onBlur: flush,
  };
  const field = multiline ? (
    <textarea {...common} rows={rows} onChange={(e) => change(e.target.value)} onKeyDown={(e) => e.key === "Escape" && revert()} />
  ) : (
    <input
      {...common}
      type="text"
      onChange={(e) => change(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") flush();
        if (e.key === "Escape") revert();
      }}
    />
  );
  return caption ? (
    <label className={`arch-field ${className ?? ""}`}>
      <span className="arch-caption">{caption}</span>
      {field}
    </label>
  ) : (
    <span className={`arch-field ${className ?? ""}`}>{field}</span>
  );
}

interface NumberProps {
  value: number;
  onCommit: Commit<number>;
  label: string;
  min: number;
  max: number;
  disabled?: boolean;
  className?: string;
}

/** A whole number: commits on Enter or leaving the field, clamped to its range; anything unreadable goes back. */
export function NumberInput({ value, onCommit, label, min, max, disabled, className }: NumberProps) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    editing.current = false;
    const n = Math.round(Number(draft));
    if (draft.trim() === "" || !Number.isFinite(n)) return setDraft(String(value));
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) {
      void Promise.resolve(onCommit(clamped)).then((ok) => {
        if (ok === false) setDraft(String(value));
      });
    }
  };
  return (
    <input
      type="number"
      className={`arch-number ${className ?? ""}`}
      aria-label={label}
      value={draft}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => {
        editing.current = true;
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          editing.current = false;
          setDraft(String(value));
        }
      }}
    />
  );
}

interface SliderProps {
  value: number;
  onCommit: Commit<number>;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** 0..1 knob: one commit per drag (on release, or a moment after the last key press). */
export function Slider({ value, onCommit, label, hint, disabled }: SliderProps) {
  const { draft, change, flush } = useDraft(value, onCommit, 400);
  return (
    <label className="arch-slider" title={hint}>
      <span className="arch-caption">{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        aria-label={label}
        value={draft}
        disabled={disabled}
        onChange={(e) => change(Number(e.target.value))}
        onPointerUp={flush}
        onBlur={flush}
      />
      <span className="arch-slider-value">{Math.round(draft * 100)}%</span>
    </label>
  );
}

/** Toggle chips for a set of ids (abilities a link requires, an enemy grants). */
export function IdToggles({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: { id: string; name: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  label: string;
  disabled?: boolean;
}) {
  const unknown = value.filter((id) => !options.some((o) => o.id === id));
  return (
    <span className="arch-toggles" role="group" aria-label={label}>
      {[...options, ...unknown.map((id) => ({ id, name: id }))].map((o) => {
        const on = value.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            className={`arch-toggle${on ? " on" : ""}`}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((v) => v !== o.id) : [...value, o.id])}
          >
            ◆ {o.name}
          </button>
        );
      })}
      {options.length === 0 && unknown.length === 0 && <span className="hint">no abilities or keys in the progression</span>}
    </span>
  );
}
