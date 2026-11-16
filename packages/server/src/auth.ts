import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { fail } from "@anomaly/core";
import type { Middleware } from "./http.ts";

/**
 * Access control for the local API. The dev server listens on the network
 * (for VPN access) and will soon front paid model calls, so every /api/*
 * request needs the studio token:
 *   - browsers: open the studio once with `?token=…`; we set an HttpOnly,
 *     SameSite=Strict cookie and redirect to the clean URL
 *   - scripts:  send the `x-studio-token` header
 * Static files (the studio page, the game build) stay public.
 */

export const TOKEN_HEADER = "x-studio-token";
export const TOKEN_COOKIE = "anomaly_token";

export function generateToken(): string {
  return randomBytes(18).toString("base64url");
}

/** Read the token from `path`, creating it (mode 600) on first run. */
export async function loadOrCreateToken(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return existing;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const token = generateToken();
  await writeFile(path, token + "\n", { mode: 0o600 });
  return token;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

export function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers[TOKEN_HEADER];
  const offered = (Array.isArray(header) ? header[0] : header) ?? cookie(req, TOKEN_COOKIE);
  return offered !== undefined && safeEqual(offered, token);
}

export function createAuthMiddleware(token: string): Middleware {
  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const isApi = url.pathname.startsWith("/api/");

    // Page opened with ?token=… : remember it in a cookie and drop it from the URL.
    const offered = url.searchParams.get("token");
    if (!isApi && req.method === "GET" && offered !== null && safeEqual(offered, token)) {
      url.searchParams.delete("token");
      res.statusCode = 302;
      res.setHeader("set-cookie", `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
      res.setHeader("location", url.pathname + url.search);
      res.end();
      return;
    }

    if (isApi && !isAuthorized(req, token)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          fail("unauthorized", "missing or invalid studio token: open the studio with the link printed in the terminal"),
        ),
      );
      return;
    }
    next();
  };
}
