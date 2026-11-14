import {
  decodeRuntimeMessage,
  encodeStudioMessage,
  type RuntimeToStudio,
  type StudioToRuntime,
} from "@anomaly/core";

type StateMessage = Extract<RuntimeToStudio, { type: "state" }>;

/**
 * Transport between the studio and the game runtime running in an iframe.
 * Knows nothing about project semantics: it validates, routes and correlates
 * messages. Session logic lives in session.ts.
 */
export class RuntimeBridge {
  private frame: HTMLIFrameElement | null = null;
  private nextRequestId = 1;
  private pending = new Map<string, { resolve: (m: StateMessage) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly onMessage: (message: RuntimeToStudio) => void,
    private readonly onProblem: (problem: string) => void,
  ) {}

  /** Start listening to the given iframe. Returns a detach function. */
  attach(frame: HTMLIFrameElement): () => void {
    this.frame = frame;
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
      const decoded = decodeRuntimeMessage(event.data);
      if (decoded.kind === "foreign") return;
      if (decoded.kind === "invalid") {
        this.onProblem(`ignored malformed runtime message: ${decoded.reason}`);
        return;
      }
      const message = decoded.message;
      if (message.type === "state") {
        const waiter = this.pending.get(message.requestId);
        this.pending.delete(message.requestId);
        waiter?.resolve(message);
        return;
      }
      this.onMessage(message);
    };
    window.addEventListener("message", listener);
    return () => {
      window.removeEventListener("message", listener);
      if (this.frame === frame) this.frame = null;
      this.rejectAll("runtime detached");
    };
  }

  send(message: StudioToRuntime): boolean {
    const target = this.frame?.contentWindow;
    if (!target) {
      this.onProblem(`cannot send "${message.type}": runtime is not attached`);
      return false;
    }
    target.postMessage(encodeStudioMessage(message), window.location.origin);
    return true;
  }

  requestState(timeoutMs = 2000): Promise<StateMessage> {
    const requestId = `req_${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`runtime did not answer getState within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      if (!this.send({ type: "getState", requestId })) {
        this.pending.get(requestId)?.reject(new Error("runtime is not attached"));
        this.pending.delete(requestId);
      }
    });
  }

  /** Fail in-flight requests, e.g. when the runtime reboots. */
  rejectAll(reason: string): void {
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
    this.pending.clear();
  }
}
