import { discoverSovcUrl } from "../../server/src/sources/discoverSovc";
import { fetchOfficial, readLimitedBody } from "../../shared/officialFetch";
import config from "../../election.config.json";
import {
  MONITOR_KEY,
  type MonitorRecord,
  type ResultsKv,
  revisionKey,
} from "./records";
import { readCurrent, readIngestion, readMonitor, writeJson } from "./store";
import { isPending } from "./publicState";

const RETRY_MS = 10 * 60 * 1000;
const DISPATCH_URL = "https://api.github.com/repos/abonini/RB4IVGID/dispatches";
const HTML_LIMIT = 2 * 1024 * 1024;

export interface CheckEnv {
  IVGID_RESULTS: ResultsKv;
  GITHUB_DISPATCH_TOKEN?: string;
}

export interface CheckResult {
  dispatched: boolean;
}

export async function checkSource(env: CheckEnv, fetchImpl: typeof fetch, nowMs: number): Promise<CheckResult> {
  const nowIso = new Date(nowMs).toISOString();
  const monitor = await readMonitor(env.IVGID_RESULTS);
  try {
    return await inspectCounty(env, fetchImpl, monitor, nowIso, nowMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "County source check failed";
    console.error("County source check failed", message);
    await writeIfChanged(env.IVGID_RESULTS, monitor, { ...monitor, failure: message, lastSourceCheckAt: nowIso });
    return { dispatched: false };
  }
}

async function inspectCounty(
  env: CheckEnv,
  fetchImpl: typeof fetch,
  monitor: MonitorRecord,
  nowIso: string,
  nowMs: number,
): Promise<CheckResult> {
  const page = await fetchOfficial(config.discoveryPageUrl, fetchImpl);
  if (!page.ok) {
    await page.body?.cancel();
    throw new Error(`County reports page returned ${page.status}`);
  }
  const html = new TextDecoder().decode(await readLimitedBody(page, HTML_LIMIT));
  const discovered = discoverSovcUrl(html, config.discoveryPageUrl);
  if (!discovered) {
    await writeIfChanged(env.IVGID_RESULTS, monitor, {
      ...monitor,
      failure: null,
      discoveredUrl: null,
      etag: null,
      lastModified: null,
      revisionKey: null,
      detectionLimited: false,
      lastSourceCheckAt: monitor.discoveredUrl ? nowIso : monitor.lastSourceCheckAt,
    });
    return { dispatched: false };
  }

  const validators = await readValidators(discovered.url, monitor, fetchImpl);
  const key = revisionKey(discovered.url, validators.etag, validators.lastModified);
  const limited = !validators.etag && !validators.lastModified;
  if (key === monitor.settledRevisionKey) {
    await writeIfChanged(env.IVGID_RESULTS, monitor, { ...monitor, failure: null, detectionLimited: limited });
    return { dispatched: false };
  }
  if (waitingForRetry(monitor, key, nowMs)) return { dispatched: false };

  const current = await readCurrent(env.IVGID_RESULTS);
  const ingestion = await readIngestion(env.IVGID_RESULTS);
  const observed = observedMonitor(monitor, discovered.url, validators, key, limited, nowIso);
  if (!isPending(observed, current, ingestion)) {
    await writeIfChanged(env.IVGID_RESULTS, monitor, { ...observed, settledRevisionKey: key, dispatchStatus: "idle", failure: null });
    return { dispatched: false };
  }

  const dispatched = await dispatchRevision(env, fetchImpl, discovered.url, validators.etag, nowIso);
  await writeJson(env.IVGID_RESULTS, MONITOR_KEY, {
    ...observed,
    lastDispatchAt: nowIso,
    dispatchStatus: dispatched ? "sent" : "failed",
    failure: null,
  });
  return { dispatched };
}

function observedMonitor(
  monitor: MonitorRecord,
  url: string,
  validators: { etag: string | null; lastModified: string | null },
  key: string,
  detectionLimited: boolean,
  nowIso: string,
): MonitorRecord {
  const changed = key !== monitor.revisionKey;
  return {
    ...monitor,
    discoveredUrl: url,
    etag: validators.etag,
    lastModified: validators.lastModified,
    revisionKey: key,
    detectionLimited,
    failure: null,
    lastSourceCheckAt: nowIso,
    lastSourceChangeAt: changed ? nowIso : monitor.lastSourceChangeAt,
  };
}

function waitingForRetry(monitor: MonitorRecord, key: string, nowMs: number): boolean {
  if (monitor.revisionKey !== key || !monitor.lastDispatchAt) return false;
  if (monitor.dispatchStatus === "idle") return false;
  return nowMs - Date.parse(monitor.lastDispatchAt) < RETRY_MS;
}

async function readValidators(
  url: string,
  monitor: MonitorRecord,
  fetchImpl: typeof fetch,
): Promise<{ etag: string | null; lastModified: string | null }> {
  const head = await fetchOfficial(url, fetchImpl, { method: "HEAD" });
  const headEtag = cleanHeader(head.headers.get("etag"));
  const headModified = cleanHeader(head.headers.get("last-modified"));
  const headUnsupported = head.status === 405 || head.status === 501;
  if (!headUnsupported && (headEtag || headModified || !head.ok)) {
    await head.body?.cancel();
    if (!head.ok) throw new Error(`County workbook request failed (${head.status})`);
    return { etag: headEtag, lastModified: headModified };
  }
  await head.body?.cancel();
  return conditionalGet(url, monitor, fetchImpl);
}

async function conditionalGet(
  url: string,
  monitor: MonitorRecord,
  fetchImpl: typeof fetch,
): Promise<{ etag: string | null; lastModified: string | null }> {
  const headers: Record<string, string> = {};
  if (monitor.etag) headers["If-None-Match"] = monitor.etag;
  if (monitor.lastModified) headers["If-Modified-Since"] = monitor.lastModified;
  const response = await fetchOfficial(url, fetchImpl, { method: "GET", headers });
  if (response.status === 304) {
    await response.body?.cancel();
    return { etag: monitor.etag, lastModified: monitor.lastModified };
  }
  await response.body?.cancel();
  if (!response.ok) throw new Error(`County workbook request failed (${response.status})`);
  return {
    etag: cleanHeader(response.headers.get("etag")),
    lastModified: cleanHeader(response.headers.get("last-modified")),
  };
}

async function dispatchRevision(
  env: CheckEnv,
  fetchImpl: typeof fetch,
  observedUrl: string,
  etag: string | null,
  detectedAt: string,
): Promise<boolean> {
  if (!env.GITHUB_DISPATCH_TOKEN) {
    console.error("GitHub dispatch token is not configured");
    return false;
  }
  const response = await fetchImpl(DISPATCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "ivgid-results-widget",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      event_type: "ivgid-results-updated",
      client_payload: { observedUrl, etag, detectedAt },
    }),
  });
  await response.body?.cancel();
  if (response.ok) return true;
  console.error("GitHub dispatch failed", response.status);
  return false;
}

async function writeIfChanged(kv: ResultsKv, before: MonitorRecord, after: MonitorRecord): Promise<void> {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await writeJson(kv, MONITOR_KEY, after);
}

function cleanHeader(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
