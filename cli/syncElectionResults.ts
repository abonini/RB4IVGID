import { createHash } from "node:crypto";
import config from "../election.config.json";
import { fetchOfficial, readLimitedBody } from "../shared/officialFetch";
import { normalizedTotals } from "../shared/totals";
import { discoverSovcUrl } from "../server/src/sources/discoverSovc";
import { parseSovcWorkbook } from "../server/src/sources/sovcWorkbook";
import { SourceError } from "../server/src/errors";

const WORKBOOK_LIMIT = 20 * 1024 * 1024;
const DEFAULT_DELAYS = [0, 2_000, 8_000];

interface SyncOptions {
  apiBase: string;
  adminToken: string;
  discoveryPageUrl?: string;
  hintUrl?: string | null;
  fetchImpl?: typeof fetch;
  retryDelays?: number[];
  sleep?: (ms: number) => Promise<void>;
}

interface HealthBody {
  contentHash?: string | null;
  replacesHash?: string | null;
  sourceUrl?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  normalizedTotals?: string | null;
  pendingSource?: unknown;
  ingestionFailure?: string | null;
}

interface Probe {
  etag: string | null;
  lastModified: string | null;
  body: Uint8Array | null;
}

export interface SyncResult {
  outcome: "published" | "unchanged" | "failed" | "waiting";
}

export async function syncElectionResults(options: SyncOptions): Promise<SyncResult> {
  const delays = options.retryDelays ?? DEFAULT_DELAYS;
  const sleep = options.sleep ?? delay;
  let lastError: unknown;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      return await syncOnce(options);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      lastError = error;
      const message = error instanceof Error ? error.message : "unknown error";
      console.error("Election sync attempt failed", message);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Election sync failed");
}

async function syncOnce(options: SyncOptions): Promise<SyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pageUrl = options.discoveryPageUrl ?? config.discoveryPageUrl;
  const discovered = await discoverWorkbook(pageUrl, fetchImpl);
  if (!discovered) {
    console.log("General-election workbook is not posted yet; nothing to sync");
    return { outcome: "waiting" };
  }
  if (options.hintUrl && options.hintUrl !== discovered.url) {
    console.error("Dispatch hint did not match the discovered Washoe workbook");
  }
  const health = await readHealth(options, fetchImpl);
  const probe = await probeWorkbook(discovered.url, health, fetchImpl);
  if (!probe.body) return acknowledgeIfNeeded(options, fetchImpl, health, discovered.url, probe, health.contentHash ?? "");
  const contentHash = sha256(probe.body);
  if (health.contentHash === contentHash) {
    return acknowledgeIfNeeded(options, fetchImpl, health, discovered.url, probe, contentHash);
  }
  let parsed: Awaited<ReturnType<typeof parseSovcWorkbook>>;
  try {
    parsed = await parseSovcWorkbook(Buffer.from(probe.body), config, discovered.label);
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    await postImport(options, fetchImpl, {
      outcome: "failed",
      sourceUrl: discovered.url,
      contentHash,
      error: error.message,
    });
    console.error("Official workbook was rejected", error.message);
    return { outcome: "failed" };
  }
  const normalized = normalizedTotals(parsed.candidates, parsed.status);
  if (health.normalizedTotals === normalized && health.contentHash) {
    return acknowledgeIfNeeded(options, fetchImpl, health, discovered.url, probe, contentHash);
  }
  await postImport(options, fetchImpl, {
    outcome: "published",
    sourceUrl: discovered.url,
    contentHash,
    etag: probe.etag,
    lastModified: probe.lastModified,
    status: parsed.status,
    certified: parsed.certified === true,
    publishedAt: parsed.publishedAt,
    replacesHash: health.replacesHash ?? null,
    contestTitle: `${config.contestPattern} ${config.electionYear}`,
    electionYear: config.electionYear,
    candidates: parsed.candidates.map((candidate) => ({ id: candidate.id, votes: candidate.votes })),
    contestTotal: parsed.contestTotal,
    sourceLabel: discovered.label,
  });
  return { outcome: "published" };
}

async function discoverWorkbook(pageUrl: string, fetchImpl: typeof fetch) {
  const response = await fetchOfficial(pageUrl, fetchImpl);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`County reports page returned ${response.status}`);
  }
  const html = new TextDecoder().decode(await readLimitedBody(response, 2 * 1024 * 1024));
  return discoverSovcUrl(html, pageUrl);
}

async function probeWorkbook(url: string, health: HealthBody, fetchImpl: typeof fetch): Promise<Probe> {
  const head = await fetchOfficial(url, fetchImpl, { method: "HEAD" });
  const etag = clean(head.headers.get("etag"));
  const lastModified = clean(head.headers.get("last-modified"));
  const unsupported = head.status === 405 || head.status === 501;
  if (!unsupported && head.ok && sameValidators(url, health, etag, lastModified)) {
    await head.body?.cancel();
    return { etag, lastModified, body: null };
  }
  await head.body?.cancel();
  if (!unsupported && !head.ok) throw new Error(`County workbook request failed (${head.status})`);
  const headers: Record<string, string> = {};
  if (!etag && !lastModified && health.etag) headers["If-None-Match"] = health.etag;
  if (!etag && !lastModified && health.lastModified) headers["If-Modified-Since"] = health.lastModified;
  const response = await fetchOfficial(url, fetchImpl, { method: "GET", headers });
  if (response.status === 304) {
    await response.body?.cancel();
    return { etag: health.etag ?? null, lastModified: health.lastModified ?? null, body: null };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`County workbook request failed (${response.status})`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > WORKBOOK_LIMIT) {
    await response.body?.cancel();
    throw new Error("Workbook exceeds the 20 MB size limit");
  }
  return {
    etag: clean(response.headers.get("etag")) ?? etag,
    lastModified: clean(response.headers.get("last-modified")) ?? lastModified,
    body: await readLimitedBody(response, WORKBOOK_LIMIT),
  };
}

function sameValidators(url: string, health: HealthBody, etag: string | null, lastModified: string | null): boolean {
  if (!health.contentHash || health.sourceUrl !== url) return false;
  if (!etag && !lastModified) return false;
  if (etag && etag !== health.etag) return false;
  if (lastModified && lastModified !== health.lastModified) return false;
  return true;
}

async function acknowledgeIfNeeded(
  options: SyncOptions,
  fetchImpl: typeof fetch,
  health: HealthBody,
  sourceUrl: string,
  probe: Probe,
  contentHash: string,
): Promise<SyncResult> {
  const needsAck = Boolean(health.pendingSource) || Boolean(health.ingestionFailure);
  if (!needsAck || !contentHash) return { outcome: "unchanged" };
  await postImport(options, fetchImpl, {
    outcome: "unchanged",
    sourceUrl,
    contentHash,
    etag: probe.etag,
    lastModified: probe.lastModified,
  });
  return { outcome: "unchanged" };
}

async function readHealth(options: SyncOptions, fetchImpl: typeof fetch): Promise<HealthBody> {
  const response = await fetchImpl(`${options.apiBase}/api/health`);
  if (!response.ok) throw new Error(`Health request failed (${response.status})`);
  const body = await response.json() as HealthBody;
  if (!body || typeof body !== "object") throw new Error("Health response was incomplete");
  return body;
}

async function postImport(options: SyncOptions, fetchImpl: typeof fetch, payload: unknown): Promise<void> {
  const response = await fetchImpl(`${options.apiBase}/api/admin/import`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (response.ok) return;
  const detail = await safeError(response);
  throw new Error(`Import failed (${response.status}): ${detail}`);
}

async function safeError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error ?? "no error detail";
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable error";
    console.error("Import error response could not be read", message);
    return "unreadable error";
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function clean(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const apiBase = process.env.RESULTS_API_BASE?.replace(/\/$/, "");
  const adminToken = process.env.ADMIN_TOKEN;
  if (!apiBase || !adminToken) {
    console.error("RESULTS_API_BASE and ADMIN_TOKEN are required");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await syncElectionResults({ apiBase, adminToken, hintUrl: process.env.HINT_URL || null });
    console.log(JSON.stringify({ ok: true, outcome: result.outcome }));
  } catch (error) {
    console.error("Election sync failed", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("syncElectionResults.ts") || entry.endsWith("syncElectionResults.js")) {
  void main();
}
