import config from "../../election.config.json";
import { normalizedTotals, voteShare } from "../../shared/totals";
import type { HealthResponse, ResultsResponse } from "../../shared/types";
import type { CurrentSnapshot, IngestionRecord, MonitorRecord } from "./records";

const STALE_WARNING = "Showing the last validated results. The latest update could not be retrieved.";
const FAILURE_WARNING = "The latest results could not be validated. No prior results are available.";

export function isPending(monitor: MonitorRecord, current: CurrentSnapshot | null, ingestion: IngestionRecord | null): boolean {
  if (!monitor.revisionKey || !monitor.discoveredUrl) return false;
  if (monitor.settledRevisionKey === monitor.revisionKey) return false;
  if (revisionMatches(monitor, current)) return false;
  return !(ingestion?.acknowledged && revisionMatches(monitor, ingestion));
}

export function buildResults(
  current: CurrentSnapshot | null,
  monitor: MonitorRecord,
  ingestion: IngestionRecord | null,
): ResultsResponse {
  const pending = isPending(monitor, current, ingestion);
  const failure = ingestion?.error ?? null;
  const countyDown = Boolean(monitor.failure);
  const warning = countyDown ? (current ? STALE_WARNING : FAILURE_WARNING) : null;
  return {
    ok: true,
    status: current?.status ?? "awaiting",
    stale: countyDown && Boolean(current),
    simulated: false,
    manual: false,
    publishedAt: current?.publishedAt ?? null,
    retrievedAt: current?.importedAt ?? null,
    checkedAt: monitor.lastSourceCheckAt,
    pendingSource: pending,
    ingestionFailure: failure,
    lastSourceCheckAt: monitor.lastSourceCheckAt,
    lastSourceChangeAt: monitor.lastSourceChangeAt,
    lastImportAt: current?.importedAt ?? null,
    certified: current?.certified ?? false,
    source: {
      name: "Washoe County",
      detail: current?.sourceLabel || "Washoe County Statement of Votes Cast",
      url: config.officialResultsUrl,
      fileUrl: current?.sourceUrl ?? null,
      type: current ? "sovc" : "none",
    },
    contest: contestSummary(),
    candidates: current ? current.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      votes: candidate.votes,
      voteShare: voteShare(candidate.votes, current.contestTotal),
    })) : awaitingCandidates(),
    warning,
  };
}

export function buildHealth(
  current: CurrentSnapshot | null,
  monitor: MonitorRecord,
  ingestion: IngestionRecord | null,
  ingestionMode: "actions" | "preview",
): HealthResponse {
  const pending = isPending(monitor, current, ingestion);
  const failure = ingestion?.error ?? null;
  const actionNeeded = pending || Boolean(failure) || Boolean(monitor.failure);
  const detectedAt = monitor.lastSourceChangeAt ?? monitor.lastSourceCheckAt ?? "";
  return {
    ok: !failure && !monitor.failure,
    mode: "live",
    ingestionMode,
    sourceType: current ? "sovc" : null,
    fresh: !monitor.failure && !failure,
    stale: Boolean(monitor.failure) && Boolean(current),
    lastCheckedAt: monitor.lastSourceCheckAt,
    lastRetrievedAt: current?.importedAt ?? null,
    publishedAt: current?.publishedAt ?? null,
    contentHashPrefix: current?.contentHash.slice(0, 12) ?? null,
    snapshotCount: current?.historyKeys.length ?? 0,
    lastSourceCheckAt: monitor.lastSourceCheckAt,
    lastSourceChangeAt: monitor.lastSourceChangeAt,
    lastImportAt: current?.importedAt ?? null,
    pendingSource: pending && monitor.discoveredUrl ? {
      url: monitor.discoveredUrl,
      etag: monitor.etag,
      lastModified: monitor.lastModified,
      detectedAt,
    } : null,
    dispatchStatus: monitor.dispatchStatus,
    ingestionFailure: failure,
    actionNeeded,
    contentHash: current?.contentHash ?? null,
    replacesHash: current?.contentHash ?? null,
    sourceUrl: current?.sourceUrl ?? null,
    etag: current?.etag ?? null,
    lastModified: current?.lastModified ?? null,
    normalizedTotals: current ? normalizedTotals(current.candidates, current.status) : null,
    detectionLimited: monitor.detectionLimited,
  };
}

export function previewResults(): ResultsResponse {
  const candidates = [
    { id: "brooks", name: "Ryan \"RB\" Brooks", votes: 1240 },
    { id: "noble", name: "David S. Noble", votes: 980 },
    { id: "swenson", name: "Harry Swenson", votes: 860 },
  ];
  const contestTotal = 3080;
  return {
    ok: true,
    status: "unofficial",
    stale: false,
    simulated: true,
    manual: false,
    publishedAt: null,
    retrievedAt: null,
    checkedAt: null,
    pendingSource: false,
    ingestionFailure: null,
    lastSourceCheckAt: null,
    lastSourceChangeAt: null,
    lastImportAt: null,
    certified: false,
    source: {
      name: "Simulated preview",
      detail: "Simulated data",
      url: config.officialResultsUrl,
      fileUrl: null,
      type: "mock",
    },
    contest: contestSummary(),
    candidates: candidates.map((candidate) => ({
      ...candidate,
      voteShare: voteShare(candidate.votes, contestTotal),
    })),
    warning: null,
  };
}

export function previewHealth(): HealthResponse {
  return {
    ...buildHealth(null, {
      lastSourceCheckAt: null,
      lastSourceChangeAt: null,
      discoveredUrl: null,
      etag: null,
      lastModified: null,
      revisionKey: null,
      settledRevisionKey: null,
      lastDispatchAt: null,
      dispatchStatus: "idle",
      failure: null,
      detectionLimited: false,
    }, null, "preview"),
    mode: "mock",
  };
}

function contestSummary() {
  return {
    name: config.office,
    electionDate: config.electionDate,
    term: config.term,
    seats: config.seats,
    voteFor: config.voteFor,
  };
}

function awaitingCandidates() {
  return config.candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.displayName,
    votes: null,
    voteShare: null,
  }));
}

function revisionMatches(
  monitor: MonitorRecord,
  record: { sourceUrl: string | null; etag: string | null; lastModified: string | null } | null,
): boolean {
  if (!record?.sourceUrl || record.sourceUrl !== monitor.discoveredUrl) return false;
  if (monitor.etag && record.etag !== monitor.etag) return false;
  if (monitor.lastModified && record.lastModified !== monitor.lastModified) return false;
  return true;
}
