import { useState, type ReactNode } from "react";

/**
 * Small pieces for the content views' long side lists (wiki pages, progression
 * items): a filter box, a collapsible group with a count, and an in-page
 * confirmation (never window.confirm, which blocks automation).
 */

/** A search box for a side list. `matches` is the helper to filter with. */
export function ListFilter({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <div className="list-filter">
      <input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button type="button" className="list-filter-clear" aria-label="Clear filter" onClick={() => onChange("")}>
          ×
        </button>
      )}
    </div>
  );
}

/** Case-insensitive: every word of the query appears somewhere in the text. */
export function matches(query: string, ...texts: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * A titled group that folds away. The title stays a heading (h3) so the list
 * reads as an outline; `extra` sits at the right of the header (e.g. a draft count).
 */
export function ListSection({
  title,
  count,
  extra,
  defaultOpen = true,
  forceOpen = false,
  children,
  testId,
}: {
  title: string;
  count?: number;
  extra?: ReactNode;
  defaultOpen?: boolean;
  /** Open regardless (e.g. while filtering, so matches are never hidden). */
  forceOpen?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = open || forceOpen;
  return (
    <div className={`list-section${shown ? " open" : ""}`} data-testid={testId}>
      <h3 className="list-section-head">
        <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)}>
          <span className="list-section-caret caret" aria-hidden />
          <span className="list-section-title">{title}</span>
          {count !== undefined && <span className="list-section-count">{count}</span>}
          {extra}
        </button>
      </h3>
      {shown && <div className="list-section-body">{children}</div>}
    </div>
  );
}

/**
 * A button that asks before it acts, in place: the button turns into the
 * question with confirm / cancel. For actions that are big or hard to spot
 * undoing (accepting every draft, replacing a plan).
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel,
  onConfirm,
  disabled,
  className,
  title,
}: {
  label: ReactNode;
  question: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button type="button" className={className} disabled={disabled} title={title} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <span className="confirm-inline" role="group" aria-label="Confirm">
      <span className="confirm-question">{question}</span>
      <button
        type="button"
        className="confirm-yes"
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
