import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Small inputs for the weapon and loadout editors: each commits one operation (one undo step)
 * on Enter or on leaving the field, never per keystroke, and follows the project otherwise.
 */

/** A labelled control in a compact grid cell. */
export function Cell({ label, children, title, wide }: { label: string; children: ReactNode; title?: string; wide?: boolean }) {
  return (
    <label className={`wpn-cell${wide ? " wide" : ""}`} title={title}>
      <span className="wpn-caption">{label}</span>
      {children}
    </label>
  );
}

/** Free text: commits on Enter (single line) or leaving the field; Escape goes back. Empty text is refused when `required`. */
export function Text({ value, onCommit, label, multiline, required, placeholder, disabled, maxLength }: {
  value: string;
  onCommit: (text: string) => void;
  label: string;
  multiline?: boolean;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
}) {
  const commit = (el: HTMLInputElement | HTMLTextAreaElement) => {
    const text = multiline ? el.value : el.value.trim();
    if (required && !text) el.value = value;
    else if (text !== value) onCommit(text);
  };
  const props = { "aria-label": label, defaultValue: value, placeholder, disabled, maxLength, className: "art-text" };
  return multiline ? (
    <textarea key={value} {...props} rows={2} onBlur={(e) => commit(e.currentTarget)} onKeyDown={(e) => e.key === "Escape" && (e.currentTarget.value = value)} />
  ) : (
    <input
      key={value}
      {...props}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") e.currentTarget.value = value;
      }}
    />
  );
}

/** A number in [min, max]: commits on Enter or leaving the field, clamped; anything unreadable goes back. */
export function Num({ value, onCommit, label, min, max, step = 1, disabled }: { value: number; onCommit: (n: number) => void; label: string; min: number; max: number; step?: number; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    editing.current = false;
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n)) return setDraft(String(value));
    const decimals = step < 1 ? String(step).split(".")[1]?.length ?? 2 : 0;
    const clamped = Number(Math.min(max, Math.max(min, n)).toFixed(decimals));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      type="number"
      className="wpn-number"
      aria-label={label}
      value={draft}
      min={min}
      max={max}
      step={step}
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

/** A colour swatch (like the items' colours: each pick is an edit). */
export function Swatch({ value, onCommit, label, disabled }: { value: string; onCommit: (color: string) => void; label: string; disabled?: boolean }) {
  return <input type="color" aria-label={label} value={value} disabled={disabled} onChange={(e) => e.target.value !== value && onCommit(e.target.value)} />;
}

export function Pick<T extends string>({ value, options, onPick, label, disabled }: { value: T; options: readonly { id: T; label: string; disabled?: boolean }[]; onPick: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onPick(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.id} value={o.id} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
