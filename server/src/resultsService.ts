import type { CandidateResult, ContestSummary, HealthResponse, ResultsResponse, ResultsSource } from "../../shared/types";
import type { RuntimeConfig } from "./config";
import { sha256 } from "./crypto";
import type { FetchResult } from "./http/fetchOfficial";
import { errorMessage, logError, logInfo, logUrl } from "./log";
import { discoverSovcUrl } from "./sources/discoverSovc";
import { parseManualEntry } from "./sources/manualEntry";
import { parsePdfSummary } from "./sources/pdfSummary";
import { orderCandidates, parseSovcWorkbook } from "./sources/sovcWorkbook";
import { countHistory, readLatest, writeCurrent, writeHistory, type StoredSnapshot } from "./snapshots";

const FRESH_WINDOW_MS = 10 * 60 * 1000;
const STALE_WARNING = "Showing the last validated results. The latest update could not be retrieved.";
const FAILURE_WARNING = "The latest results could not be validated. No prior results are available.";

type SnapshotFields = Omit<StoredSnapshot, "id" | "retrievedAt" | "checkedAt">;

interface MemoryEntry {
  at: number;
  response: ResultsResponse;
}

export interface ResultsService {
  warm(): Promise<void>;
  start(): void;
  stop(): void;
  getResults(): Promise<ResultsResponse>;
  refresh(): Promise<ResultsResponse>;
  getHealth(): Promise<HealthResponse>;
  applyManualEntry(body: unknown): Promise<ResultsResponse>;
}

export function createResultsService(options: {
  config: RuntimeConfig;
  fetchOfficial?: (url: string) => Promise<FetchResult>;
  now?: () => number;
}): ResultsService {
  const fetchSource = options.fetchOfficial ?? (async (url: string) => {
    const { fetchOfficial } = await import("./http/fetchOfficial");
    return fetchOfficial(url);
  });
  const now = options.now ?? Date.now;
  const { config } = options;
  let memory: MemoryEntry | null = null;
  let fallback: StoredSnapshot | null = null;
  let lastCheckedAt: string | null = null;
  let lastSuccessAt: number | null = null;
  let lastOutcome: "success" | "failure" | null = null;
  let stale = false;
  let inflight: Promise<ResultsResponse> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function warm(): Promise<void> {
    fallback = await readLatest(config.snapshotDir);
  }

  function start(): void {
    if (config.mode !== "live" || timer) return;
    timer = setInterval(() => {
      void refresh().catch((error: unknown) => {
        logError("scheduled_refresh_failed", { message: errorMessage(error) });
      });
    }, config.refreshIntervalMs);
    timer.unref();
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  async function getResults(): Promise<ResultsResponse> {
    if (config.mode === "mock") return mockResponse(new Date(now()).toISOString());
    if (config.mode === "manual") return manualView();
    if (memory && now() - memory.at < config.refreshIntervalMs) return memory.response;
    return refresh();
  }

  function refresh(): Promise<ResultsResponse> {
    if (inflight) return inflight;
    inflight = refreshOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function getHealth(): Promise<HealthResponse> {
    const fresh = config.mode === "mock"
      || (lastOutcome === "success" && lastSuccessAt != null && now() - lastSuccessAt <= FRESH_WINDOW_MS);
    return {
      ok: true,
      mode: config.mode,
      sourceType: config.mode === "mock" ? "mock" : fallback?.sourceType ?? null,
      fresh,
      stale: config.mode === "live" ? stale : false,
      lastCheckedAt,
      lastRetrievedAt: fallback?.retrievedAt ?? null,
      publishedAt: fallback?.publishedAt ?? null,
      contentHashPrefix: fallback?.contentHash.slice(0, 12) ?? null,
      snapshotCount: await countHistory(config.snapshotDir),
    };
  }

  async function applyManualEntry(body: unknown): Promise<ResultsResponse> {
    const manual = parseManualEntry(body, config);
    const snapshot = await persist({
      sourceType: "manual",
      sourceUrl: manual.sourceUrl,
      contentHash: manual.contentHash,
      publishedAt: manual.publishedAt,
      status: manual.status,
      manual: true,
      candidates: manual.candidates,
      contestTotal: manual.contestTotal,
    });
    fallback = snapshot;
    stale = false;
    lastOutcome = "success";
    lastSuccessAt = now();
    const response = toResponse(snapshot, false, null, snapshot.checkedAt);
    remember(response);
    logInfo("manual_entry_saved", { hashPrefix: snapshot.contentHash.slice(0, 12), host: logUrl(snapshot.sourceUrl) });
    return response;
  }

  async function refreshOnce(): Promise<ResultsResponse> {
    const checkedAt = new Date(now()).toISOString();
    lastCheckedAt = checkedAt;
    try {
      const loaded = await loadLive();
      if (loaded.kind === "awaiting") {
        const response = awaitingResponse(checkedAt, null);
        remember(response);
        lastSuccessAt = now();
        lastOutcome = "success";
        stale = false;
        logInfo("results_awaiting", {});
        return response;
      }
      const snapshot = await persist(loaded.fields);
      fallback = snapshot;
      const response = toResponse(snapshot, false, null, checkedAt);
      remember(response);
      lastSuccessAt = now();
      lastOutcome = "success";
      stale = false;
      logInfo("results_refreshed", {
        sourceType: snapshot.sourceType,
        hashPrefix: snapshot.contentHash.slice(0, 12),
        host: logUrl(snapshot.sourceUrl),
      });
      return response;
    } catch (error) {
      logError("results_refresh_failed", { message: errorMessage(error) });
      return serveFailure(checkedAt);
    }
  }

  function serveFailure(checkedAt: string): ResultsResponse {
    lastOutcome = "failure";
    if (!fallback) {
      stale = false;
      const response = awaitingResponse(checkedAt, FAILURE_WARNING);
      remember(response);
      return response;
    }
    stale = true;
    const response = toResponse(fallback, true, STALE_WARNING, checkedAt);
    remember(response);
    return response;
  }

  async function loadLive(): Promise<{ kind: "awaiting" } | { kind: "parsed"; fields: SnapshotFields }> {
    let sovcFailure: unknown = null;
    try {
      const sovc = await loadSovc();
      if (sovc) return { kind: "parsed", fields: sovc };
    } catch (error) {
      sovcFailure = error;
    }
    if (!config.pdfUrl) {
      if (sovcFailure) throw sovcFailure;
      return { kind: "awaiting" };
    }
    try {
      return { kind: "parsed", fields: await loadPdf() };
    } catch (error) {
      throw sovcFailure ?? error;
    }
  }

  async function loadSovc(): Promise<SnapshotFields | null> {
    const located = await locateSovc();
    if (!located) return null;
    const file = await fetchSource(located.url);
    const parsed = await parseSovcWorkbook(file.body, config, located.label);
    return {
      sourceType: "sovc",
      sourceUrl: file.finalUrl,
      contentHash: sha256(file.body),
      publishedAt: httpDate(file.lastModified),
      status: parsed.status,
      manual: false,
      candidates: parsed.candidates,
      contestTotal: parsed.contestTotal,
    };
  }

  async function locateSovc(): Promise<{ url: string; label: string } | null> {
    if (config.sourceUrl) return { url: config.sourceUrl, label: "" };
    const page = await fetchSource(config.discoveryPageUrl);
    return discoverSovcUrl(page.body.toString("utf8"), page.finalUrl);
  }

  async function loadPdf(): Promise<SnapshotFields> {
    const file = await fetchSource(config.pdfUrl);
    const parsed = await parsePdfSummary(file.body, config);
    return {
      sourceType: "pdf",
      sourceUrl: file.finalUrl,
      contentHash: sha256(file.body),
      publishedAt: parsed.publishedAt ?? httpDate(file.lastModified),
      status: parsed.status,
      manual: false,
      candidates: parsed.candidates,
      contestTotal: parsed.contestTotal,
    };
  }

  async function persist(fields: SnapshotFields): Promise<StoredSnapshot> {
    const checkedAt = new Date(now()).toISOString();
    const existing = await readLatest(config.snapshotDir);
    if (existing && existing.contentHash === fields.contentHash) {
      const updated = { ...existing, checkedAt };
      await writeCurrent(config.snapshotDir, updated);
      return updated;
    }
    const snapshot: StoredSnapshot = {
      ...fields,
      id: `${checkedAt.replace(/[:.]/g, "-")}-${fields.contentHash.slice(0, 12)}`,
      retrievedAt: checkedAt,
      checkedAt,
    };
    await writeHistory(config.snapshotDir, snapshot);
    await writeCurrent(config.snapshotDir, snapshot);
    return snapshot;
  }

  async function manualView(): Promise<ResultsResponse> {
    const snapshot = fallback?.sourceType === "manual" ? fallback : await readLatest(config.snapshotDir);
    if (!snapshot || snapshot.sourceType !== "manual") return awaitingResponse(new Date(now()).toISOString(), null);
    fallback = snapshot;
    return toResponse(snapshot, false, null, snapshot.checkedAt);
  }

  function remember(response: ResultsResponse): void {
    memory = { at: now(), response };
  }

  function awaitingResponse(checkedAt: string, warning: string | null): ResultsResponse {
    return {
      ok: true,
      status: "awaiting",
      stale: false,
      simulated: false,
      manual: false,
      publishedAt: null,
      retrievedAt: null,
      checkedAt,
      source: {
        name: "Washoe County Registrar of Voters",
        detail: "Washoe County Statement of Votes Cast",
        url: config.officialResultsUrl,
        fileUrl: null,
        type: "none",
      },
      contest: contestOf(config),
      candidates: awaitingCandidates(config),
      warning,
    };
  }

  function toResponse(snapshot: StoredSnapshot, isStale: boolean, warning: string | null, checkedAt: string): ResultsResponse {
    return {
      ok: true,
      status: snapshot.status,
      stale: isStale,
      simulated: false,
      manual: snapshot.manual,
      publishedAt: snapshot.publishedAt,
      retrievedAt: snapshot.retrievedAt,
      checkedAt,
      source: sourceFor(snapshot),
      contest: contestOf(config),
      candidates: snapshot.candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        votes: candidate.votes,
        voteShare: snapshot.contestTotal > 0 ? candidate.votes / snapshot.contestTotal : 0,
      })),
      warning,
    };
  }

  function sourceFor(snapshot: StoredSnapshot): ResultsSource {
    if (snapshot.manual) {
      return {
        name: "Washoe County Registrar of Voters",
        detail: "Manually entered from official published totals",
        url: snapshot.sourceUrl,
        fileUrl: null,
        type: "manual",
      };
    }
    if (snapshot.sourceType === "pdf") {
      return {
        name: "Washoe County Registrar of Voters",
        detail: "Washoe County Election Summary Report",
        url: config.officialResultsUrl,
        fileUrl: snapshot.sourceUrl,
        type: "pdf",
      };
    }
    return {
      name: "Washoe County Registrar of Voters",
      detail: "Washoe County Statement of Votes Cast",
      url: config.officialResultsUrl,
      fileUrl: snapshot.sourceUrl,
      type: "sovc",
    };
  }

  function mockResponse(checkedAt: string): ResultsResponse {
    const sample = new Map([
      ["brooks", 1240],
      ["noble", 980],
      ["swenson", 860],
    ]);
    const candidates = orderCandidates(config.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.displayName,
      votes: sample.get(candidate.id) ?? 0,
    })), config.displayOrder);
    const contestTotal = candidates.reduce((total, candidate) => total + candidate.votes, 0);
    return {
      ok: true,
      status: "unofficial",
      stale: false,
      simulated: true,
      manual: false,
      publishedAt: null,
      retrievedAt: checkedAt,
      checkedAt,
      source: {
        name: "Washoe County Registrar of Voters",
        detail: "Simulated data",
        url: config.officialResultsUrl,
        fileUrl: null,
        type: "mock",
      },
      contest: contestOf(config),
      candidates: candidates.map((candidate) => ({
        ...candidate,
        voteShare: contestTotal > 0 ? candidate.votes / contestTotal : 0,
      })),
      warning: null,
    };
  }

  return { warm, start, stop, getResults, refresh, getHealth, applyManualEntry };
}

function contestOf(config: RuntimeConfig): ContestSummary {
  return {
    name: config.office,
    electionDate: config.electionDate,
    term: config.term,
    seats: config.seats,
    voteFor: config.voteFor,
  };
}

function awaitingCandidates(config: RuntimeConfig): CandidateResult[] {
  return orderCandidates(config.candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.displayName,
    votes: null,
    voteShare: null,
  })), config.displayOrder);
}

function httpDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}
