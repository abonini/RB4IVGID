export interface ResultsKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CandidateTotal {
  id: string;
  name: string;
  votes: number;
}

export interface CurrentSnapshot {
  contentHash: string;
  sourceUrl: string;
  etag: string | null;
  lastModified: string | null;
  status: "unofficial" | "official";
  certified: boolean;
  publishedAt: string | null;
  importedAt: string;
  candidates: CandidateTotal[];
  contestTotal: number;
  sourceLabel: string;
  contestTitle: string;
  historyKeys: string[];
}

export interface MonitorRecord {
  lastSourceCheckAt: string | null;
  lastSourceChangeAt: string | null;
  discoveredUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  revisionKey: string | null;
  settledRevisionKey: string | null;
  lastDispatchAt: string | null;
  dispatchStatus: "idle" | "sent" | "failed";
  failure: string | null;
  detectionLimited: boolean;
}

export interface IngestionRecord {
  acknowledged: boolean;
  error: string | null;
  sourceUrl: string | null;
  contentHash: string | null;
  etag: string | null;
  lastModified: string | null;
  at: string;
}

export const CURRENT_KEY = "current";
export const MONITOR_KEY = "monitor";
export const INGESTION_KEY = "ingestion";
export const HISTORY_LIMIT = 20;

export function emptyMonitor(): MonitorRecord {
  return {
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
  };
}

export function revisionKey(url: string, etag: string | null, lastModified: string | null): string {
  return `${url}\n${etag ?? ""}\n${lastModified ?? ""}`;
}
