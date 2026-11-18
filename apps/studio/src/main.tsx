import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { fetchProject, UnauthorizedError } from "./api.ts";
import { Session } from "./session.ts";
import "./styles.css";

const STUDIO_API = [
  "getProject",
  "applyOperation",
  "applyBatch",
  "updateCharacter",
  "undo",
  "play",
  "stop",
  "getRuntimeState",
  "sendChat",
  "cancelChat",
  "resetProject",
  "setLive",
] as const;
type StudioApi = Pick<Session, (typeof STUDIO_API)[number]>;

declare global {
  interface Window {
    /** Programmatic editing API (stand-in for future AI tool calls). */
    studio?: StudioApi;
  }
}

const root = document.getElementById("root")!;

async function start() {
  const session = new Session(await fetchProject());
  session.connectServer();
  window.studio = Object.fromEntries(STUDIO_API.map((key) => [key, session[key]])) as StudioApi;

  createRoot(root).render(
    <StrictMode>
      <App session={session} />
    </StrictMode>,
  );
}

if (window.self !== window.top) {
  // If the game build is missing, Vite serves this page inside the game iframe.
  root.textContent = "Game runtime not found. Run `npm run build:game`.";
} else {
  start().catch((error: unknown) => {
    root.textContent =
      error instanceof UnauthorizedError
        ? "This studio needs its access token. Open it with the link printed in the terminal where the server is running (it ends in ?token=…)."
        : `Could not load the project from the studio server: ${String(error)}`;
  });
}
