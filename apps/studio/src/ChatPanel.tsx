import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import type { AgentId, ChatEntry, ChatState } from "@anomaly/core";
import type { Session } from "./session.ts";
import { AutoGrowTextarea, planEdit, Reply, UserMessage, Working, type EditPlan } from "./ChatMessages.tsx";
import "./chat.css";

interface AgentText {
  title: string;
  /** One line under the name: what this assistant is for. */
  role: string;
  /** Where it lives (each tab has its own assistant). */
  tabs: string;
  /** Shown before the first message. */
  intro: string;
  examples: string[];
}

const AGENT_TEXT: Record<AgentId, AgentText> = {
  narrative: {
    title: "Director",
    role: "Designs the game: writes the wiki and the progression as drafts for you to review.",
    tabs: "Wiki and Progression tabs",
    intro: "Describe your game: the world, the tone, who the player is, how it ends, how the world opens up. The Director fills in the wiki and the progression as drafts for you to review.",
    examples: ["A lonely descent through a flooded city; the player is the last lamplighter.", "Draft the progression: four regions and two abilities."],
  },
  build: {
    title: "Build assistant",
    role: "Builds and tunes the game: characters, rooms, items, rules and art.",
    tabs: "Playtest, Rooms, Scenery, Characters and Game tabs",
    intro: "Describe a change to the game and the Build assistant makes it. Every turn is one undo step.",
    examples: ["Make the Charger wind up longer and hit harder.", "Add a Crawler to the first room."],
  },
  architect: {
    title: "Architect",
    role: "Plans the world's rooms from the Director's design, builds them and proves the game can be finished.",
    tabs: "Architect tab",
    intro: "Ask for the world you want. The Architect plans rooms from the Director's design; code builds them and proves the game can be finished.",
    examples: ["Make the canopy a tall vertical climb.", "Build the game."],
  },
};

const AGENT_ORDER: AgentId[] = ["narrative", "build", "architect"];

/** Unsent drafts per assistant: the panel remounts when the assistant changes (switching tabs). */
const drafts = new Map<AgentId, string>();

const WIDTH_KEY = "anomaly.chatWidth";
const WIDTH_DEFAULT = 420;
const WIDTH_MIN = 300;
const WIDTH_MAX = 800;

function loadWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    return raw >= WIDTH_MIN && raw <= WIDTH_MAX ? raw : WIDTH_DEFAULT;
  } catch {
    return WIDTH_DEFAULT;
  }
}

function saveWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // private mode or blocked storage: keep the in-memory width only
  }
}

const clampWidth = (w: number) => Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, w)));

/**
 * The chat column's width (per browser), dragged from its left edge. The studio grid reads it as
 * --chat-w (styles.css); the panel sets it on its .studio ancestor, capped at half the window.
 */
function useChatWidth(panel: React.RefObject<HTMLElement | null>, open: boolean) {
  const [width, setWidth] = useState(loadWidth);
  useLayoutEffect(() => {
    const studio = panel.current?.closest<HTMLElement>(".studio");
    if (!studio) return;
    if (open) studio.style.setProperty("--chat-w", `min(${width}px, 50vw)`);
    else studio.style.removeProperty("--chat-w");
  }, [panel, open, width]);

  const startResize = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = panel.current?.getBoundingClientRect().width ?? width;
      let latest = startWidth;
      const move = (ev: globalThis.PointerEvent) => {
        latest = clampWidth(Math.min(startWidth + (startX - ev.clientX), window.innerWidth / 2));
        setWidth(latest);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing");
        saveWidth(latest);
      };
      // The game iframe would swallow pointer events mid-drag; .resizing turns them off.
      document.body.classList.add("resizing");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [panel, width],
  );
  const set = (w: number) => {
    const next = clampWidth(w);
    setWidth(next);
    saveWidth(next);
  };
  return { width, startResize, set };
}

interface Props {
  session: Session;
  agent: AgentId;
  chat: ChatState;
  /** Current project revision and whether the latest change can be undone. */
  revision: number;
  canUndo: boolean;
  playing: boolean;
  connected: boolean;
  /** Collapsed to a thin strip (more room for the workbench). */
  open: boolean;
  onToggle: () => void;
  /** Open a tab where another assistant lives. */
  onSwitchAgent?: (agent: AgentId) => void;
}

export function ChatPanel({ session, agent, chat, revision, canUndo, playing, connected, open, onToggle, onSwitchAgent }: Props) {
  const text = AGENT_TEXT[agent];
  const studio = useSyncExternalStore(session.subscribe, session.getState);
  const [draft, setDraftState] = useState(() => drafts.get(agent) ?? "");
  const setDraft = (value: string) => {
    drafts.set(agent, value);
    setDraftState(value);
  };
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const width = useChatWidth(panelRef, open);
  const [atBottom, setAtBottom] = useState(true);

  const stick = useRef(true);
  const focusNext = useRef(false);

  /** One edit (of the latest message) or retry (of the latest reply) open at a time. */
  const [pending, setPending] = useState<"edit" | "retry" | null>(null);
  const running = chat.running !== null;
  const lastUser = lastIndex(chat.entries, "user");
  const lastReply = lastIndex(chat.entries, "assistant");
  // A new exchange (or a replaced one) closes an open edit or retry.
  useEffect(() => setPending(null), [lastUser, lastReply, running]);
  // One AI turn holds the project at a time, whichever assistant (or an Architect run) it is.
  const otherAgent = AGENT_ORDER.find((a) => a !== agent && studio.chats[a].running !== null);
  const blockedBy = otherAgent
    ? `The ${AGENT_TEXT[otherAgent].title} is working. One assistant works at a time; you can send when it's done.`
    : studio.architect.running
      ? "An Architect build run is working on the project; you can send when it's done."
      : studio.art.runningJobs.some((j) => j.underLock)
        ? "Game art is being made; you can send when it's done."
        : null;
  const busy = sending || running || blockedBy !== null;
  const canAct = connected && !busy;

  // Follow new messages only while the log is scrolled to the bottom (don't yank someone reading).
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && stick.current) log.scrollTop = log.scrollHeight;
  }, [chat, open]);
  // ...and when the log itself shrinks or grows (the composer grows, a note appears, the panel is resized).
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) log.scrollTop = log.scrollHeight;
    });
    observer.observe(log);
    return () => observer.disconnect();
  }, [open]);
  // When this turn started, by this browser's clock (the server's may differ).
  const [runningSince, setRunningSince] = useState(() => Date.now());
  useEffect(() => {
    if (running) setRunningSince(Date.now());
  }, [running]);
  const onScroll = () => {
    const log = logRef.current;
    if (!log) return;
    const below = log.scrollHeight - log.scrollTop - log.clientHeight;
    stick.current = below < 40;
    setAtBottom(below < 160);
  };
  const jumpToLatest = () => {
    stick.current = true;
    setAtBottom(true);
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  };

  useEffect(() => {
    if (open && focusNext.current) {
      focusNext.current = false;
      inputRef.current?.focus();
    }
  }, [open]);

  const sendMessage = async (message: string, edit?: { replace?: number; undoRevision?: number }): Promise<string | null> => {
    setSending(true);
    setError(null);
    stick.current = true;
    const result = await session.sendChat(agent, message, edit);
    setSending(false);
    return result.ok ? null : result.error;
  };

  const send = async () => {
    const message = draft.trim();
    if (!message || busy || !connected) return;
    const failed = await sendMessage(message);
    if (failed) setError(failed);
    else setDraft("");
    inputRef.current?.focus();
  };

  const edit = (message: string, plan: EditPlan) =>
    plan.kind === "new" ? sendMessage(message) : sendMessage(message, { replace: plan.replace, undoRevision: plan.undoRevision });

  /** Put text in the message box (after what's already typed there, never over it). */
  const reuse = (message: string) => {
    const typed = draft.trim();
    const next = typed && typed !== message ? `${draft.trimEnd()}\n\n${message}` : message;
    setDraft(next);
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(next.length, next.length));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  if (!open) {
    return (
      <aside className={`chat chat-collapsed chat-agent-${agent}`} aria-label="Chat" data-testid={`chat-${agent}`} ref={panelRef}>
        <button
          type="button"
          className="chat-toggle"
          onClick={() => {
            focusNext.current = true;
            onToggle();
          }}
          title={`Open the chat with the ${text.title}`}
          aria-label="Open chat"
        >
          💬
        </button>
        {running && <span className="chat-busy" title={`The ${text.title} is working`} />}
        <span className="chat-collapsed-name" aria-hidden>
          {text.title}
        </span>
      </aside>
    );
  }

  const turns = groupTurns(chat.entries);
  const latestPlan = lastUser >= 0 && !running ? planEdit(chat, lastUser, revision, canUndo) : null;

  return (
    <aside className={`chat chat-agent-${agent}`} aria-label="Chat" data-testid={`chat-${agent}`} ref={panelRef}>
      <div
        className="chat-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the chat"
        aria-valuenow={width.width}
        aria-valuemin={WIDTH_MIN}
        aria-valuemax={WIDTH_MAX}
        tabIndex={0}
        title="Drag to resize the chat (double-click to reset)"
        onPointerDown={width.startResize}
        onDoubleClick={() => width.set(WIDTH_DEFAULT)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") width.set(width.width + 20);
          if (e.key === "ArrowRight") width.set(width.width - 20);
        }}
      />
      <header className="chat-head">
        <div className="chat-who">
          <h2>
            <span className="chat-dot" aria-hidden />
            {text.title}
          </h2>
          <button type="button" className="chat-toggle" onClick={onToggle} title="Collapse the chat" aria-label="Collapse chat">
            ⇥
          </button>
        </div>
        <p className="chat-role">{text.role}</p>
        <nav className="chat-switch" aria-label="Other assistants">
          <span title="Each tab has its own assistant and conversation; switching tabs switches assistants.">Other assistants:</span>
          {AGENT_ORDER.filter((a) => a !== agent).map((a) =>
            onSwitchAgent ? (
              <button key={a} type="button" className={`chat-switch-to chat-agent-${a}`} onClick={() => onSwitchAgent(a)} title={`The ${AGENT_TEXT[a].title} lives in the ${AGENT_TEXT[a].tabs}. Click to go there.`}>
                <span className="chat-dot" aria-hidden />
                {AGENT_TEXT[a].title}
                {studio.chats[a].running && <span className="chat-busy" title="Working" />}
              </button>
            ) : (
              <span key={a} className={`chat-switch-to chat-agent-${a}`} title={`In the ${AGENT_TEXT[a].tabs}`}>
                <span className="chat-dot" aria-hidden />
                {AGENT_TEXT[a].title}
              </span>
            ),
          )}
        </nav>
      </header>

      <div className="chat-log" ref={logRef} onScroll={onScroll} aria-live="polite" aria-relevant="additions">
        {chat.entries.length === 0 && !running && (
          <div className="chat-intro">
            <p>{text.intro}</p>
            <p className="chat-intro-label">Try:</p>
            {text.examples.map((example) => (
              <button key={example} type="button" className="chat-example" onClick={() => reuse(example)} title="Put this in the message box">
                {example}
              </button>
            ))}
          </div>
        )}
        {turns.map((turn) => (
          <section className="chat-turn" key={turn[0]!.index}>
            {turn.map(({ entry, index }) =>
              entry.role === "user" ? (
                <UserMessage
                  key={index}
                  entry={entry}
                  plan={index === lastUser ? latestPlan : null}
                  canAct={canAct}
                  actions={!(running && index === lastUser)}
                  onReuse={() => reuse(entry.text)}
                  onEdit={edit}
                  editing={index === lastUser && pending === "edit"}
                  setEditing={(open) => setPending(open ? "edit" : null)}
                />
              ) : (
                <Reply
                  key={index}
                  entry={entry}
                  undone={entry.revision !== null && chat.undone.includes(entry.revision)}
                  undoable={!busy && !playing && canUndo && entry.revision === revision}
                  onUndo={() => void session.undo()}
                  confirming={index === lastReply && pending === "retry"}
                  setConfirming={(open) => setPending(open ? "retry" : null)}
                  replacing={index > lastUser && pending === "edit" && latestPlan?.kind === "replace"}
                  retry={
                    index === lastReply && lastReply > lastUser && latestPlan?.kind === "replace" && canAct
                      ? { plan: latestPlan, onRetry: () => edit((chat.entries[lastUser] as Extract<ChatEntry, { role: "user" }>).text, latestPlan) }
                      : null
                  }
                />
              ),
            )}
          </section>
        ))}
        {running && <Working activity={chat.running!.activity} since={runningSince} name={text.title} />}
        {!atBottom && pending !== "edit" && (
          <button type="button" className="chat-jump" onClick={jumpToLatest}>
            ↓ Latest
          </button>
        )}
      </div>

      <div className="chat-input">
        {blockedBy && <p className="chat-blocked">{blockedBy}</p>}
        {!connected && <p className="chat-blocked">Reconnecting to the studio server…</p>}
        {error && (
          <p className="msg-note" role="alert">
            Not sent: {error}
          </p>
        )}
        <div className="chat-compose">
          <AutoGrowTextarea
            label="Message"
            inputRef={inputRef}
            value={draft}
            placeholder={`Message the ${text.title}…`}
            onChange={setDraft}
            onKeyDown={onKeyDown}
            disabled={!connected}
          />
          {running ? (
            <button type="button" className="chat-send chat-stop" onClick={() => void session.cancelChat(agent)} title="Stop this turn; nothing it did is saved">
              <span aria-hidden>■</span> Stop
            </button>
          ) : (
            <button type="button" className="chat-send primary" onClick={() => void send()} disabled={busy || !connected || !draft.trim()}>
              Send
            </button>
          )}
        </div>
        <p className="chat-hint">
          {playing ? "Sending stops the playtest. " : ""}
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
        </p>
      </div>
    </aside>
  );
}

function lastIndex(entries: ChatEntry[], role: ChatEntry["role"]): number {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.role === role) return i;
  return -1;
}

/** Each user message starts a turn with the replies that follow it. */
function groupTurns(entries: ChatEntry[]): { entry: ChatEntry; index: number }[][] {
  const turns: { entry: ChatEntry; index: number }[][] = [];
  entries.forEach((entry, index) => {
    if (entry.role === "user" || turns.length === 0) turns.push([]);
    turns.at(-1)!.push({ entry, index });
  });
  return turns;
}
