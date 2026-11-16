import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { createProjectServer, loadOrCreateToken } from "@anomaly/server";

// Godot's web runtime only starts in a secure context (HTTPS or localhost).
// For access from another machine, `npm run dev:remote` serves over HTTPS
// with a self-signed certificate.
const https = process.env.STUDIO_HTTPS === "1";
const port = Number(process.env.STUDIO_PORT ?? 5173);
const dataDir = process.env.STUDIO_DATA_DIR ?? fileURLToPath(new URL("../../projects/default", import.meta.url));
const tokenFile = fileURLToPath(new URL("../../.studio-token", import.meta.url));

/** Serves the local project API (/api/*) from the same process and port, behind the studio token. */
function projectApi(): Plugin {
  const mount = async (server: ViteDevServer | PreviewServer) => {
    const token = process.env.STUDIO_TOKEN ?? (await loadOrCreateToken(tokenFile));
    const { handler } = await createProjectServer(dataDir, { token });
    server.middlewares.use(handler);

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

export default defineConfig({
  plugins: [react(), projectApi(), ...(https ? [basicSsl()] : [])],
  // host: listen on all interfaces so the studio is reachable over the VPN/LAN.
  server: { port, strictPort: true, host: true },
  preview: { host: true },
});
