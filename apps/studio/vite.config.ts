import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin, type PreviewServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { artOptionsFromEnv, createProjectServer, liveSettingsFromEnv, loadOrCreateToken } from "@anomaly/server";
import { DEFAULT_CLAUDE_MODEL, runClaudeCodeTurn, type TurnRunner } from "@anomaly/agent";

// Godot's web runtime only starts in a secure context (HTTPS or localhost).
// For access from another machine, `npm run dev:remote` serves over HTTPS
// with a self-signed certificate.
const https = process.env.STUDIO_HTTPS === "1";
const port = Number(process.env.STUDIO_PORT ?? 5173);
const dataDir = process.env.STUDIO_DATA_DIR ?? fileURLToPath(new URL("../../projects/default", import.meta.url));
const tokenFile = fileURLToPath(new URL("../../.studio-token", import.meta.url));
const chatModel = process.env.STUDIO_CHAT_MODEL ?? DEFAULT_CLAUDE_MODEL;
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const gameDir = fileURLToPath(new URL("./public/game", import.meta.url));

/** STUDIO_CHAT_BACKEND: "claude-code" (default; your local Claude Code login) or "fake" (e2e). */
async function chatRunner(): Promise<TurnRunner> {
  if (process.env.STUDIO_CHAT_BACKEND === "fake") return (await import("../../e2e/fakeChat.ts")).fakeChatRunner;
  return (request) => runClaudeCodeTurn({ ...request, model: chatModel });
}

/** Serves the local project API (/api/*) from the same process and port, behind the studio token. */
function projectApi(mode: string): Plugin {
  const mount = async (server: ViteDevServer | PreviewServer) => {
    const token = process.env.STUDIO_TOKEN ?? (await loadOrCreateToken(tokenFile));
    // Server-side secrets (OPENROUTER_API_KEY) come from the repo's .env; the process env wins.
    const env = { ...loadEnv(mode, repoRoot, ["OPENROUTER_", "STUDIO_"]), ...process.env };
    const art = artOptionsFromEnv(env, gameDir);
    // STUDIO_LIVE (default on): wiki characters become game characters and the progression becomes rooms as the creator designs.
    const { handler } = await createProjectServer(dataDir, { token, runner: await chatRunner(), art, live: liveSettingsFromEnv(env) });
    server.middlewares.use(handler);
    server.httpServer?.on("close", () => void art.renderer.close());

    // Print a ready-to-open link next to Vite's own URLs.
    const printUrls = server.printUrls.bind(server);
    server.printUrls = () => {
      printUrls();
      const urls = [server.resolvedUrls?.local[0], server.resolvedUrls?.network[0]].filter(Boolean);
      server.config.logger.info(`  ➜  Open the studio with its access token:`);
      for (const url of urls) server.config.logger.info(`       ${url}?token=${token}`);
      server.config.logger.info(`     (or add ?token=… to any Network URL above; API/curl: header "x-studio-token: ${token}")\n`);
    };
  };
  return {
    name: "anomaly-project-api",
    configureServer: mount,
    configurePreviewServer: mount,
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), projectApi(mode), ...(https ? [basicSsl()] : [])],
  // host: listen on all interfaces so the studio is reachable over the VPN/LAN.
  server: { port, strictPort: true, host: true },
  preview: { host: true },
}));
