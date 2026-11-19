import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ChatActivity, ChatEntry, ChatState } from "@anomaly/core";

export type UserEntry = Extract<ChatEntry, { role: "user" }>;
export type AssistantEntry = Extract<ChatEntry, { role: "assistant" }>;

const OUTCOME_NOTE: Partial<Record<AssistantEntry["outcome"], string>> = {
  commit_failed: "Couldn't save the changes.",
  step_limit: "Stopped after too many steps. Nothing was saved.",
  cancelled: "Stopped. Nothing was saved.",
  model_error: "The AI request failed. Nothing was saved.",
};

/**
 * What editing (or retrying) the latest exchange does to it, in plain words. "replace" swaps the
 * message and its reply for the new one, undoing the turn's saved changes first when they are the
 * latest revision; "new" keeps the exchange (its changes can't be undone any more) and sends a new message.
 */
export type EditPlan = { kind: "replace"; replace: number; undoRevision?: number; note: string; confirm: boolean } | { kind: "new"; note: string; confirm: true };

export function planEdit(chat: ChatState, index: number, revision: number, canUndo: boolean): EditPlan {
  const reply = chat.entries.slice(index + 1).find((e): e is AssistantEntry => e.role === "assistant");
  if (!reply) return { kind: "replace", replace: index, note: "Replaces this message.", confirm: false };
  const queued = reply.changes.some((c) => c.startsWith("queued"));
  const keepsQueued = queued ? " The work it queued (art, build runs) keeps going." : "";
  if (reply.revision === null) {
    return { kind: "replace", replace: index, note: `Replaces this message and its reply.${keepsQueued}`, confirm: queued };
  }
  if (chat.undone.includes(reply.revision)) {
    return { kind: "replace", replace: index, note: `Replaces this message and its reply (its changes were already undone).${keepsQueued}`, confirm: false };
  }
  const saved = countChanges(reply.changes).saved;
  if (reply.revision === revision && canUndo) {
    return {
      kind: "replace",
      replace: index,
      undoRevision: reply.revision,
      note: `Undoes this turn's ${plural(saved, "change")} first, then replaces the message and its reply.${keepsQueued}`,
      confirm: true,
    };
  }
  return {
    kind: "new",
    note: "This turn's changes can't be undone automatically (the project has changed since), so they stay. Your message is sent as a new message below.",
    confirm: true,
  };
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Saved changes vs work queued for later (art jobs, build runs). */
function countChanges(changes: string[]): { saved: number; queued: number } {
  const queued = changes.filter((c) => c.startsWith("queued")).length;
  return { saved: changes.length - queued, queued };
}

/** "createItem" (an operation without a plain-language description) reads as "create item". */
export function humanize(text: string): string {
  return /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(text) ? text.replace(/([A-Z])/g, " $1").toLowerCase() : text;
}

/** "14:02", or "Nov 17, 14:02" for another day; the full date and time as a tooltip. */
function Time({ at, extra }: { at: string; extra?: string }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = date.toDateString() === new Date().toDateString();
  const label = today ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
  return (
    <time className="msg-time" dateTime={at} title={[date.toLocaleString(), extra].filter(Boolean).join("\n")}>
      {label}
    </time>
  );
}

interface UserMessageProps {
  entry: UserEntry;
  /** Edit (latest message) or reuse (earlier ones); neither while a turn runs. */
  plan: EditPlan | null;
  canAct: boolean;
  /** False for the message whose turn is running. */
  actions: boolean;
  onReuse: () => void;
  onEdit: (text: string, plan: EditPlan) => Promise<string | null>;
  /** Editing is open (one edit or retry at a time; the panel owns the switch). */
  editing: boolean;
  setEditing: (editing: boolean) => void;
}

export function UserMessage({ entry, plan, canAct, actions, onReuse, onEdit, editing: open, setEditing: setOpen }: UserMessageProps) {
  const [text, setText] = useState(entry.text);
  const editing = open ? text : null;
  const setEditing = (value: string | null) => {
    if (value === null) setOpen(false);
    else setText(value);
  };
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) box.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const [sending, setSending] = useState(false);

  const submit = async () => {
    const text = editing?.trim();
    if (!text || !plan || sending) return;
    setSending(true);
    setError(null);
    const failed = await onEdit(text, plan);
    setSending(false);
    if (failed) setError(failed);
    else setEditing(null);
  };

  if (editing !== null && plan) {
    return (
      <div className="msg msg-user msg-editing" data-testid="chat-message" ref={box}>
        <div className="msg-head">
          <span className="msg-who">Edit your message</span>
        </div>
        <AutoGrowTextarea
          label="Edit message"
          value={editing}
          onChange={setEditing}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(null);
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <p className="msg-edit-note">{plan.note}</p>
        {error && <p className="msg-note" role="alert">{error}</p>}
        <div className="msg-edit-actions">
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void submit()} disabled={!canAct || sending || !editing.trim()}>
            {plan.kind === "new" ? "Send as new" : "Send edit"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="msg msg-user" data-testid="chat-message">
      <div className="msg-head">
        <span className="msg-who">You</span>
        <Time at={entry.at} />
        <span className="msg-actions">
          {!actions ? null : plan ? (
            <button
              type="button"
              className="link"
              onClick={() => {
                setText(entry.text);
                setError(null);
                setOpen(true);
              }}
              disabled={!canAct}
              title="Change this message and send it again"
            >
              Edit
            </button>
          ) : (
            <button type="button" className="link" onClick={onReuse} disabled={!canAct} title="Copy this message into the message box to send it again">
              Reuse
            </button>
          )}
        </span>
      </div>
      <div className="msg-user-text">{entry.text}</div>
    </div>
  );
}

interface ReplyProps {
  entry: AssistantEntry;
  undone: boolean;
  undoable: boolean;
  onUndo: () => void;
  /** Retry the latest turn (same message, its exchange replaced); null when it can't be. */
  retry: { plan: Extract<EditPlan, { kind: "replace" }>; onRetry: () => Promise<string | null> } | null;
  /** The Retry confirmation is open (the panel owns it: one edit or retry at a time). */
  confirming: boolean;
  setConfirming: (open: boolean) => void;
  /** An edit of its message is open: this reply is about to be replaced. */
  replacing: boolean;
}

export function Reply({ entry, undone, undoable, onUndo, retry, confirming, setConfirming, replacing }: ReplyProps) {
  const note = OUTCOME_NOTE[entry.outcome];
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (confirming) confirmRef.current?.scrollIntoView({ block: "nearest" });
  }, [confirming]);
  const doRetry = async () => {
    setError(await retry!.onRetry());
    setConfirming(false);
  };
  const failed = entry.outcome !== "committed" && entry.outcome !== "no_changes";
  return (
    <div className={`msg msg-ai${undone ? " msg-undone" : ""}${failed ? " msg-failed" : ""}${replacing || confirming ? " msg-replacing" : ""}`} data-testid="chat-reply">
      {entry.text && <FormattedText text={entry.text} />}
      {note && (
        <p className="msg-note">
          {note}
          {entry.error && ` (${entry.error})`}
        </p>
      )}
      {entry.changes.length > 0 && <Changes changes={entry.changes} />}
      {confirming && retry && (
        <div className="msg-confirm" role="group" aria-label="Retry" ref={confirmRef}>
          <p>{retry.plan.note}</p>
          <button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void doRetry()}>
            Retry
          </button>
        </div>
      )}
      {error && <p className="msg-note" role="alert">{error}</p>}
      <div className="msg-meta">
        <Time at={entry.at} extra={formatUsage(entry.usage)} />
        {undone && <span className="msg-badge">Undone</span>}
        <span className="msg-actions">
          {undoable && (
            <button type="button" className="link" onClick={onUndo} title="Undo the changes this turn saved">
              Undo this
            </button>
          )}
          {retry && !confirming && !replacing && (
            <button
              type="button"
              className="link"
              onClick={() => (retry.plan.confirm ? setConfirming(true) : void doRetry())}
              title="Send the same message again, replacing this reply"
            >
              Retry
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

/** The turn's changes as one line ("12 changes · 2 queued ▸") that opens into the list. */
function Changes({ changes }: { changes: string[] }) {
  const { saved, queued } = countChanges(changes);
  const summary = [saved > 0 && plural(saved, "change"), queued > 0 && `${queued} queued`].filter(Boolean).join(" · ");
  return (
    <details
      className="msg-changes"
      onToggle={(e) => {
        const details = e.currentTarget;
        if (details.open) details.scrollIntoView({ block: "nearest" });
      }}
    >
      <summary>{summary}</summary>
      <ul>
        {changes.map((change, i) => (
          <li key={i}>{humanize(change)}</li>
        ))}
      </ul>
    </details>
  );
}

export function Working({ activity, since, name }: { activity: ChatActivity[]; since: number; name: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const tools = activity.filter((a) => a.kind === "tool");
  return (
    <div className="msg msg-ai msg-working" data-testid="chat-working" aria-live="polite">
      {activity.map((a, i) =>
        a.kind === "text" ? (
          <FormattedText key={i} text={a.text} />
        ) : (
          <p key={i} className="msg-tool">
            <span className={a.ok === undefined ? "tool-pending" : a.ok ? "tool-ok" : "tool-failed"}>{a.ok === undefined ? "…" : a.ok ? "✓" : "✗"}</span> {humanize(a.text)}
          </p>
        ),
      )}
      <div className="msg-meta">
        <span className="chat-busy" aria-hidden />
        <span>
          {name} is working… {elapsed}
          {tools.length > 0 && ` · ${plural(tools.length, "step")}`}
        </span>
      </div>
    </div>
  );
}

/** A textarea that grows with its text up to a limit (then scrolls). */
export function AutoGrowTextarea({
  label,
  value,
  onChange,
  onKeyDown,
  placeholder,
  disabled,
  autoFocus,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? own;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value, ref]);
  useLayoutEffect(() => {
    if (!autoFocus || !ref.current) return;
    const el = ref.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus, ref]);
  return (
    <textarea
      ref={ref}
      aria-label={label}
      rows={1}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}

/** A Markdown table row's cells ("| a | b |"), or null when the line isn't one. */
export function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|") || t.length < 2) return null;
  return t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** The header/body divider ("|---|:---:|"). */
const isDivider = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

/** The Markdown models write: paragraphs, headings, "-"/"1." lists, tables, **bold**, *emphasis*, `code` and fenced code. */
export function FormattedText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  let table: string[][] | null = null;
  const flushTable = () => {
    if (!table) return;
    const rows: string[][] = table;
    table = null;
    // A header row only when a divider follows it; otherwise every row is body.
    const header = rows.length > 1 && isDivider(rows[1]!) ? rows[0]! : null;
    const body = rows.filter((r, i) => !isDivider(r) && !(header && i === 0));
    blocks.push(
      <div key={blocks.length} className="msg-table-wrap">
        <table className="msg-table">
          {header && (
            <thead>
              <tr>
                {header.map((c, i) => (
                  <th key={i}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{inline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
  };
  const flush = () => {
    flushTable();
    if (!list) return;
    const items = list.items.map((b, i) => <li key={i}>{inline(b)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (code) {
        blocks.push(<pre key={blocks.length}>{code.join("\n")}</pre>);
        code = null;
      } else {
        flush();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const cells = tableCells(line);
    if (cells) {
      if (list) flush();
      (table ??= []).push(cells);
      continue;
    }
    flushTable();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = !bullet;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[1]!);
      continue;
    }
    flush();
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) blocks.push(<p key={blocks.length} className="msg-heading">{inline(heading[1]!)}</p>);
    else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) blocks.push(<hr key={blocks.length} />);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  if (code) blocks.push(<pre key={blocks.length}>{(code as string[]).join("\n")}</pre>);
  flush();
  return <div className="msg-text">{blocks}</div>;
}

function inline(line: string): ReactNode[] {
  return line.split(/(`[^`]+`|\*\*.+?\*\*|\*[^*\s][^*]*\*)/g).map((part, i) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

function formatUsage({ promptTokens, completionTokens, cost }: AssistantEntry["usage"]): string {
  const tokens = promptTokens + completionTokens;
  if (tokens === 0) return "";
  const size = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  return `${size} tokens${cost === undefined ? "" : ` · ~$${cost.toFixed(3)}`}`;
}
