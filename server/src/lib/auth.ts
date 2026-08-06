import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ALLOWED_ORIGINS } from "./config";
import { TOKEN_PATH } from "./data-dir";

/**
 * This API can spawn PTYs and run build commands — i.e. arbitrary code
 * execution. Binding to 127.0.0.1 is NOT enough on its own: any web page open
 * in the browser can POST to localhost (CSRF / DNS rebinding). Every request
 * therefore needs (a) a shared token and (b) a same-origin check.
 */
function loadOrCreateToken(): string {
  const fromEnv = process.env.CLAUDE_STATION_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(TOKEN_PATH)) {
    const existing = readFileSync(TOKEN_PATH, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  try {
    chmodSync(TOKEN_PATH, 0o600);
  } catch {
    /* best effort */
  }
  return token;
}

export const TOKEN = loadOrCreateToken();

function tokenMatches(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function extractToken(req: FastifyRequest): string | undefined {
  const header = req.headers["x-cs-token"];
  if (typeof header === "string") return header;
  const query = req.query as Record<string, unknown> | undefined;
  const fromQuery = query?.t; // WS handshake can't set headers
  return typeof fromQuery === "string" ? fromQuery : undefined;
}

/** An Origin we don't recognise means a different site is calling us — refuse. */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // curl / same-origin fetch omit it
  return ALLOWED_ORIGINS.has(origin);
}

const PUBLIC_PATHS = new Set(["/api/health"]);

export function registerAuth(app: FastifyInstance): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split("?")[0] ?? req.url;
    // Only the API and sockets are gated. The static bundle carries no data and
    // has to load unauthenticated — otherwise the UI can't even ask for a token.
    if (!url.startsWith("/api") && !url.startsWith("/ws")) return;
    if (PUBLIC_PATHS.has(url)) return;
    if (!originAllowed(req.headers.origin)) {
      return reply.code(403).send({ error: "Origin not allowed" });
    }
    if (!tokenMatches(extractToken(req))) {
      return reply.code(401).send({ error: "Missing or invalid token" });
    }
  });
}

/** WS routes are checked again at handshake time — the hook above covers the upgrade request. */
export function assertWsAuthorized(req: FastifyRequest): void {
  if (!originAllowed(req.headers.origin) || !tokenMatches(extractToken(req))) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
}
