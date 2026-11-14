import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { createProjectServer } from "@anomaly/server";

// Godot's web runtime only starts in a secure context (HTTPS or localhost).
// For access from another machine, `npm run dev:remote` serves over HTTPS
// with a self-signed certificate.
const https = process.env.STUDIO_HTTPS === "1";
const port = Number(process.env.STUDIO_PORT ?? 5173);
const dataDir = process.env.STUDIO_DATA_DIR ?? fileURLToPath(new URL("../../projects/default", import.meta.url));

/** Serves the local project API (/api/*) from the same process and port. */
function projectApi(): Plugin {
  return {
    name: "anomaly-project-api",
    async configureServer(server) {
      const { handler } = await createProjectServer(dataDir);
      server.middlewares.use(handler);
    },
    async configurePreviewServer(server) {
      const { handler } = await createProjectServer(dataDir);
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), projectApi(), ...(https ? [basicSsl()] : [])],
  // host: listen on all interfaces so the studio is reachable over the VPN/LAN.
  server: { port, strictPort: true, host: true },
  preview: { host: true },
});
