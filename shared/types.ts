export type PublicationStatus = "unofficial" | "official";

export type ResultsStatus = "awaiting" | PublicationStatus;

export type SourceType = "sovc" | "pdf" | "manual" | "mock" | "none";

export interface CandidateConfig {
  id: string;
  displayName: string;
  match: string[];
}

export interface ElectionConfig {
  discoveryPageUrl: string;
  officialResultsUrl: string;
  contestPattern: string;
  electionYear: number;
  electionDate: string;
  office: string;
  term: string;
  seats: number;
  voteFor: number;
  displayOrder: string[];
  candidates: CandidateConfig[];
}

export interface CandidateResult {
  id: string;
  name: string;
  votes: number | null;
  voteShare: number | null;
}

export interface ResultsSource {
  name: string;
  detail: string;
  url: string;
  fileUrl: string | null;
  type: SourceType;
}

export interface ContestSummary {
  name: string;
  electionDate: string;
  term: string;
  seats: number;
  voteFor: number;
}

export interface ResultsResponse {
  ok: boolean;
  status: ResultsStatus;
  stale: boolean;
  simulated: boolean;
  manual: boolean;
  publishedAt: string | null;
  retrievedAt: string | null;
  checkedAt: string | null;
  source: ResultsSource;
  contest: ContestSummary;
  candidates: CandidateResult[];
  warning: string | null;
  pendingSource?: boolean;
  ingestionFailure?: string | null;
  lastSourceCheckAt?: string | null;
  lastSourceChangeAt?: string | null;
  lastImportAt?: string | null;
  certified?: boolean;
}

export interface HealthResponse {
  ok: boolean;
  mode: "live" | "mock" | "manual";
  sourceType: SourceType | null;
  fresh: boolean;
  stale: boolean;
  lastCheckedAt: string | null;
  lastRetrievedAt: string | null;
  publishedAt: string | null;
  contentHashPrefix: string | null;
  snapshotCount: number;
  ingestionMode?: "actions" | "preview";
  lastSourceCheckAt?: string | null;
  lastSourceChangeAt?: string | null;
  lastImportAt?: string | null;
  pendingSource?: { url: string; etag: string | null; lastModified: string | null; detectedAt: string } | null;
  dispatchStatus?: "idle" | "sent" | "failed" | null;
  ingestionFailure?: string | null;
  actionNeeded?: boolean;
  contentHash?: string | null;
  replacesHash?: string | null;
  sourceUrl?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  normalizedTotals?: string | null;
  detectionLimited?: boolean;
}
