import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

/**
 * In-page confirmation, instead of window.confirm (which blocks the page and
 * the browser extension driving it). Anywhere in the studio:
 *
 *   if (!(await askConfirm({ title: "Delete Arena?", message: "Undo can restore it.", confirmLabel: "Delete", danger: true }))) return;
 *
 * <ConfirmHost /> (mounted once, in App) shows the question.
 */
export interface ConfirmRequest {
  title: string;
  message?: ReactNode;
  /** The confirming button's label (default "OK"); say what it does, e.g. "Start over". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: the button is red and Cancel has the focus. */
  danger?: boolean;
}

interface Pending extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

let current: Pending | null = null;
const listeners = new Set<() => void>();
const show = (next: Pending | null) => {
  current = next;
  for (const l of listeners) l();
};

export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  current?.resolve(false); // a newer question replaces an unanswered one
  return new Promise((resolve) => show({ ...request, resolve }));
}

function answer(ok: boolean) {
  const pending = current;
  show(null);
  pending?.resolve(ok);
}

export function ConfirmHost() {
  const request = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!request) return;
    const previous = document.activeElement as HTMLElement | null;
    (request.danger ? cancelRef : okRef).current?.focus();
    return () => previous?.focus?.();
  }, [request]);

  if (!request) return null;
  return (
    <div className="confirm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && answer(false)}>
      <div
        ref={dialogRef}
        className={`confirm-dialog${request.danger ? " danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={request.message ? "confirm-message" : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            answer(false);
          } else if (e.key === "Tab") {
            // Keep the focus on the dialog's two buttons.
            const buttons = [cancelRef.current, okRef.current].filter((b): b is HTMLButtonElement => b !== null);
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
            e.preventDefault();
            buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
          }
        }}
      >
        <h2 id="confirm-title">{request.title}</h2>
        {request.message && (
          <div id="confirm-message" className="confirm-message">
            {request.message}
          </div>
        )}
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" onClick={() => answer(false)}>
            {request.cancelLabel ?? "Cancel"}
          </button>
          <button ref={okRef} type="button" className={request.danger ? "danger" : "primary"} onClick={() => answer(true)}>
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
