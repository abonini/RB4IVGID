import { readBearer, tokensMatch } from "./auth";
import { applyImport, ImportError } from "./import";
import { buildHealth, buildResults, previewHealth, previewResults } from "./publicState";
import type { ResultsKv } from "./records";
import { checkSource } from "./sourceCheck";
import { readCurrent, readIngestion, readMonitor } from "./store";

export interface Env {
  IVGID_RESULTS: KVNamespace;
  ASSETS: Fetcher;
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPOSITORY: string;
  REFRESH_INTERVAL_SECONDS: string;
  INGEST_MODE: string;
  SIMULATED: string;
  ADMIN_TOKEN?: string;
}

const BODY_LIMIT = 32 * 1024;
const FRAME_ANCESTORS = [
  "https://brooksrb.com",
  "https://www.brooksrb.com",
  "https://*.wix.com",
  "https://*.wixsite.com",
].join(" ");

let lastRunMs = 0;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx, url);
    if (url.pathname === "/" || url.pathname === "/ivgid-results") return widgetAsset(request, env, url);
    return withFrameHeaders(await env.ASSETS.fetch(request));
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
};

async function runScheduled(env: Env): Promise<void> {
  if (env.SIMULATED === "true") return;
  const intervalSeconds = Number(env.REFRESH_INTERVAL_SECONDS || "60");
  const now = Date.now();
  if (lastRunMs > 0 && now - lastRunMs < intervalSeconds * 1000) return;
  lastRunMs = now;
  await checkSource(checkEnv(env), fetch, now);
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return json(null, 204);
  if (request.method === "GET" && url.pathname === "/api/results") return cachedResults(request, env, ctx);
  if (request.method === "GET" && url.pathname === "/api/health") return health(env);
  if (request.method === "POST" && url.pathname === "/api/admin/import") return adminImport(request, env);
  return json({ ok: false, error: "Not found" }, 404);
}

async function cachedResults(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (env.SIMULATED === "true") return json(previewResults(), 200, { "Cache-Control": "public, max-age=15" });
  const cache = caches.default;
  const key = new Request(request.url, { method: "GET" });
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = json(await resultsBody(env), 200, { "Cache-Control": "public, max-age=15" });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function health(env: Env): Promise<Response> {
  if (env.SIMULATED === "true") {
    return json({ ...previewHealth(), ingestionMode: "preview", ok: true }, 200, { "Cache-Control": "no-store" });
  }
  const state = await loadState(env);
  const body = buildHealth(state.current, state.monitor, state.ingestion, "actions");
  return json(body, 200, { "Cache-Control": "no-store" });
}

async function adminImport(request: Request, env: Env): Promise<Response> {
  if (env.SIMULATED === "true") return json({ ok: false, error: "Preview does not accept imports" }, 403);
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: "Not found" }, 404);
  const provided = readBearer(request.headers.get("Authorization"));
  if (!(await tokensMatch(provided, env.ADMIN_TOKEN))) return json({ ok: false, error: "Unauthorized" }, 401);
  const raw = await request.text();
  if (raw.length > BODY_LIMIT) return json({ ok: false, error: "Request body is too large" }, 413);
  try {
    const result = await applyImport(asKv(env.IVGID_RESULTS), JSON.parse(raw) as unknown, new Date().toISOString());
    return json(result.body, result.status);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ ok: false, error: "Import body is not valid JSON" }, 400);
    if (error instanceof ImportError) return json({ ok: false, error: error.message }, error.status);
    const detail = error instanceof Error ? error.message : "unknown error";
    console.error("Election import failed", detail);
    return json({ ok: false, error: "Import failed" }, 500);
  }
}

async function widgetAsset(request: Request, env: Env, url: URL): Promise<Response> {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = "/index.html";
  assetUrl.search = url.search;
  const assetRequest = new Request(assetUrl.toString(), { method: "GET" });
  const response = await env.ASSETS.fetch(assetRequest);
  return withFrameHeaders(response);
}

async function resultsBody(env: Env) {
  const state = await loadState(env);
  return buildResults(state.current, state.monitor, state.ingestion);
}

async function loadState(env: Env) {
  const kv = asKv(env.IVGID_RESULTS);
  const [current, monitor, ingestion] = await Promise.all([
    readCurrent(kv),
    readMonitor(kv),
    readIngestion(kv),
  ]);
  return { current, monitor, ingestion };
}

function checkEnv(env: Env) {
  return { IVGID_RESULTS: asKv(env.IVGID_RESULTS), GITHUB_DISPATCH_TOKEN: env.GITHUB_DISPATCH_TOKEN };
}

function asKv(namespace: KVNamespace): ResultsKv {
  return {
    get: (key) => namespace.get(key),
    put: (key, value) => namespace.put(key, value),
    delete: (key) => namespace.delete(key),
  };
}

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Access-Control-Allow-Origin", "*");
  if (status === 204) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers });
}

function withFrameHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("X-Frame-Options");
  headers.set("Content-Security-Policy", `frame-ancestors ${FRAME_ANCESTORS}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
