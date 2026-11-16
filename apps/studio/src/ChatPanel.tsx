import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ChatActivity, ChatEntry, ChatState } from "@anomaly/core";
import type { Session } from "./session.ts";

type AssistantEntry = Extract<ChatEntry, { role: "assistant" }>;

const OUTCOME_NOTE: Partial<Record<AssistantEntry["outcome"], string>> = {
  commit_failed: "Couldn't save the changes.",
  step_limit: "Stopped after too many steps. Nothing was saved.",
  cancelled: "Cancelled. Nothing was saved.",
  model_error: "The AI request failed. Nothing was saved.",
};

interface Props {
  session: Session;
  chat: ChatState;
  /** Current project revision and whether the latest change can be undone. */
  revision: number;
  canUndo: boolean;
  playing: boolean;
  connected: boolean;
}

export function ChatPanel({ session, chat, revision, canUndo, playing, connected }: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const busy = sending || chat.running !== null;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [chat]);

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setSending(true);
    if (await session.sendChat(message)) setDraft("");
    setSending(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <aside className="chat" aria-label="Chat">
      <h2>Chat</h2>
      <div className="chat-log" ref={logRef}>
        {chat.entries.length === 0 && !busy && (
          <p className="hint">Describe a change, e.g. “make the Charger wind up longer and hit harder”.</p>
        )}
        {chat.entries.map((entry, i) =>
          entry.role === "user" ? (
            <div key={i} className="msg msg-user">
              {entry.text}
            </div>
          ) : (
            <Reply
              key={i}
              entry={entry}
              undone={entry.revision !== null && chat.undone.includes(entry.revision)}
              undoable={!busy && !playing && canUndo && entry.revision === revision}
              onUndo={() => void session.undo()}
            />
          ),
        )}
        {chat.running && <Working activity={chat.running.activity} onCancel={() => void session.cancelChat()} />}
      </div>
      <div className="chat-input">
        <textarea
          aria-label="Message"
          rows={3}
          value={draft}
          placeholder={playing ? "Describe a change (sending stops the playtest)" : "Describe a change…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!connected}
        />
        <button type="button" onClick={() => void send()} disabled={busy || !connected || !draft.trim()}>
          Send
        </button>
      </div>
    </aside>
  );
}

interface ReplyProps {
  entry: AssistantEntry;
  undone: boolean;
  undoable: boolean;
  onUndo: () => void;
}

function Reply({ entry, undone, undoable, onUndo }: ReplyProps) {
  const note = OUTCOME_NOTE[entry.outcome];
  return (
    <div className={`msg msg-ai${undone ? " msg-undone" : ""}`} data-testid="chat-reply">
      {entry.text && <FormattedText text={entry.text} />}
      {note && (
        <p className="msg-note">
          {note}
          {entry.error && ` (${entry.error})`}
        </p>
      )}
      {entry.changes.length > 0 && (
        <ul className="msg-changes">
          {entry.changes.map((change, i) => (
            <li key={i}>{change}</li>
          ))}
        </ul>
      )}
      <div className="msg-meta">
        <span>{formatUsage(entry.usage)}</span>
        {undone && <span className="msg-badge">Undone</span>}
        {undoable && (
          <button type="button" onClick={onUndo}>
            Undo this
          </button>
        )}
      </div>
    </div>
  );
}

function Working({ activity, onCancel }: { activity: ChatActivity[]; onCancel: () => void }) {
  return (
    <div className="msg msg-ai msg-working" data-testid="chat-working">
      {activity.map((a, i) =>
        a.kind === "text" ? (
          <p key={i}>{a.text}</p>
        ) : (
          <p key={i} className="msg-tool">
            {a.ok === undefined ? "…" : a.ok ? "✓" : "✗"} {a.text}
          </p>
        ),
      )}
      <div className="msg-meta">
        <span>Working…</span>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Paragraphs, "- " bullet lists and **bold**: the Markdown models use even when asked not to. */
function FormattedText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={blocks.length}>
        {bullets.map((b, i) => (
          <li key={i}>{bold(b)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  for (const line of text.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1]!);
      continue;
    }
    flush();
    if (line.trim()) blocks.push(<p key={blocks.length}>{bold(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

function bold(line: string): ReactNode[] {
  return line.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part));
}

function formatUsage({ promptTokens, completionTokens, cost }: AssistantEntry["usage"]): string {
  const tokens = promptTokens + completionTokens;
  if (tokens === 0) return "";
  const size = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  return `${size} tokens${cost === undefined ? "" : ` · ~$${cost.toFixed(3)}`}`;
}
