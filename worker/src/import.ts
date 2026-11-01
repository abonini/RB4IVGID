import config from "../../election.config.json";
import { validateOfficialUrl } from "../../shared/officialFetch";
import { normalizedTotals } from "../../shared/totals";
import type { PublicationStatus } from "../../shared/types";
import {
  CURRENT_KEY,
  HISTORY_LIMIT,
  INGESTION_KEY,
  type CurrentSnapshot,
  type IngestionRecord,
  type ResultsKv,
} from "./records";
import { readCurrent, readIngestion, writeJson } from "./store";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class ImportError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportResult {
  status: number;
  wrote: boolean;
  body: { ok: boolean; outcome: string; wrote: boolean; error?: string };
}

interface PublishedBody {
  outcome: "published";
  sourceUrl: string;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
  status: PublicationStatus;
  certified: boolean;
  publishedAt: string | null;
  replacesHash: string | null;
  allowOlder: boolean;
  contestTitle: string;
  electionYear: number;
  candidates: Array<{ id: string; votes: number }>;
  contestTotal: number;
  sourceLabel: string;
}

export async function applyImport(kv: ResultsKv, payload: unknown, nowIso: string): Promise<ImportResult> {
  if (!payload || typeof payload !== "object") throw new ImportError("Import body must be a JSON object", 400);
  const record = payload as Record<string, unknown>;
  if (record.simulated === true) throw new ImportError("Simulated results cannot be stored", 400);
  if (record.outcome === "failed") return recordFailure(kv, record, nowIso);
  if (record.outcome === "unchanged") return recordUnchanged(kv, record, nowIso);
  if (record.outcome === "published") return recordPublished(kv, readPublished(record), nowIso);
  throw new ImportError("Import outcome is not supported", 400);
}

async function recordPublished(kv: ResultsKv, body: PublishedBody, nowIso: string): Promise<ImportResult> {
  const current = await readCurrent(kv);
  assertReplaces(current, body.replacesHash);
  assertNotOlder(current, body);
  if (current?.contentHash === body.contentHash) {
    const wrote = await clearFailure(kv, nowIso);
    return result(200, "published", wrote);
  }
  if (current && normalizedTotals(current.candidates, current.status) === normalizedTotals(body.candidates, body.status)) {
    const wrote = await acknowledge(kv, body, nowIso);
    return result(200, "unchanged", wrote);
  }

  const snapshot = toSnapshot(body, current, nowIso);
  const snapKey = `snap/${nowIso.replace(/:/g, "-")}-${body.contentHash.slice(0, 12)}`;
  await writeJson(kv, snapKey, snapshot);
  await writeJson(kv, CURRENT_KEY, snapshot);
  await writeJson(kv, INGESTION_KEY, acknowledgement(body, nowIso, null));
  await trimHistory(kv, current?.historyKeys ?? [], snapshot.historyKeys);
  console.log(JSON.stringify({ event: "results_import", outcome: "published", wrote: true, hashPrefix: body.contentHash.slice(0, 8) }));
  return result(200, "published", true);
}

async function recordUnchanged(kv: ResultsKv, record: Record<string, unknown>, nowIso: string): Promise<ImportResult> {
  const source = readSource(record);
  const existing = await readIngestion(kv);
  const next = acknowledgement(source, nowIso, null);
  if (sameAcknowledgement(existing, next)) return result(200, "unchanged", false);
  await writeJson(kv, INGESTION_KEY, next);
  console.log(JSON.stringify({ event: "results_import", outcome: "unchanged", wrote: false, hashPrefix: source.contentHash.slice(0, 8) }));
  return result(200, "unchanged", false);
}

async function recordFailure(kv: ResultsKv, record: Record<string, unknown>, nowIso: string): Promise<ImportResult> {
  const error = readError(record.error);
  const current = await readCurrent(kv);
  const next: IngestionRecord = {
    acknowledged: false,
    error,
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : null,
    contentHash: typeof record.contentHash === "string" ? record.contentHash : null,
    etag: null,
    lastModified: null,
    at: nowIso,
  };
  await writeJson(kv, INGESTION_KEY, next);
  console.error(JSON.stringify({ event: "results_import_failed", hashPrefix: next.contentHash?.slice(0, 8) ?? null, keptHash: current?.contentHash.slice(0, 8) ?? null }));
  return result(200, "failed", false);
}

function readPublished(record: Record<string, unknown>): PublishedBody {
  if (record.electionYear !== config.electionYear) throw new ImportError("Import is not for the 2026 election", 400);
  const contestTitle = requiredString(record.contestTitle, "Contest title");
  if (!contestTitle.toLowerCase().includes(config.contestPattern.toLowerCase())) {
    throw new ImportError("Import is not the IVGID Trustee contest", 400);
  }
  const source = readSource(record);
  const status = record.status === "official" || record.status === "unofficial" ? record.status : null;
  if (!status) throw new ImportError("Publication status must be official or unofficial", 400);
  const candidates = readCandidates(record.candidates);
  const contestTotal = readCount(record.contestTotal, "Contest total");
  const sum = candidates.reduce((total, candidate) => total + candidate.votes, 0);
  if (contestTotal !== sum) throw new ImportError("Candidate totals do not match the contest total", 400);
  return {
    outcome: "published",
    ...source,
    status,
    certified: record.certified === true,
    publishedAt: readOptionalTime(record.publishedAt),
    replacesHash: record.replacesHash == null ? null : requiredHash(record.replacesHash),
    allowOlder: record.allowOlder === true,
    contestTitle,
    electionYear: config.electionYear,
    candidates,
    contestTotal,
    sourceLabel: requiredString(record.sourceLabel, "Source label"),
  };
}

function readSource(record: Record<string, unknown>): { sourceUrl: string; contentHash: string; etag: string | null; lastModified: string | null } {
  const sourceUrl = requiredString(record.sourceUrl, "Source URL");
  validateOfficialUrl(sourceUrl);
  return {
    sourceUrl,
    contentHash: requiredHash(record.contentHash),
    etag: optionalString(record.etag),
    lastModified: optionalString(record.lastModified),
  };
}

function readCandidates(value: unknown): Array<{ id: string; votes: number }> {
  if (!Array.isArray(value)) throw new ImportError("Candidates are missing", 400);
  const allowed = new Map(config.candidates.map((candidate) => [candidate.id, candidate.displayName]));
  const seen = new Set<string>();
  const ordered: Array<{ id: string; votes: number }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new ImportError("Candidate entry is invalid", 400);
    const candidate = entry as Record<string, unknown>;
    const id = requiredString(candidate.id, "Candidate id");
    if (!allowed.has(id)) throw new ImportError("Candidate is not in this contest", 400);
    if (seen.has(id)) throw new ImportError("Candidate list contains a duplicate", 400);
    seen.add(id);
    ordered.push({ id, votes: readCount(candidate.votes, "Candidate votes") });
  }
  const missing = config.candidates.find((candidate) => !seen.has(candidate.id));
  if (missing) throw new ImportError(`${missing.displayName} is missing`, 400);
  return ordered;
}

function assertReplaces(current: CurrentSnapshot | null, replacesHash: string | null): void {
  const currentHash = current?.contentHash ?? null;
  if (replacesHash !== currentHash) {
    throw new ImportError("Results changed before this import. Read health and retry.", 409);
  }
}

function assertNotOlder(current: CurrentSnapshot | null, body: PublishedBody): void {
  if (!current?.publishedAt || !body.publishedAt || body.allowOlder) return;
  if (Date.parse(body.publishedAt) < Date.parse(current.publishedAt)) {
    throw new ImportError("Older results cannot replace a newer snapshot", 409);
  }
}

function toSnapshot(body: PublishedBody, current: CurrentSnapshot | null, nowIso: string): CurrentSnapshot {
  const names = new Map(config.candidates.map((candidate) => [candidate.id, candidate.displayName]));
  const snapKey = `snap/${nowIso.replace(/:/g, "-")}-${body.contentHash.slice(0, 12)}`;
  const historyKeys = [...(current?.historyKeys ?? []), snapKey].slice(-HISTORY_LIMIT);
  return {
    contentHash: body.contentHash,
    sourceUrl: body.sourceUrl,
    etag: body.etag,
    lastModified: body.lastModified,
    status: body.status,
    certified: body.certified,
    publishedAt: body.publishedAt,
    importedAt: nowIso,
    candidates: body.candidates.map((candidate) => ({
      id: candidate.id,
      name: names.get(candidate.id) ?? candidate.id,
      votes: candidate.votes,
    })),
    contestTotal: body.contestTotal,
    sourceLabel: body.sourceLabel,
    contestTitle: body.contestTitle,
    historyKeys,
  };
}

async function trimHistory(kv: ResultsKv, previous: string[], next: string[]): Promise<void> {
  const kept = new Set(next);
  for (const key of previous) {
    if (kept.has(key)) continue;
    try {
      await kv.delete(key);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "delete failed";
      console.error("Old election snapshot could not be removed", key, detail);
    }
  }
}

async function acknowledge(
  kv: ResultsKv,
  body: { sourceUrl: string; contentHash: string; etag: string | null; lastModified: string | null },
  nowIso: string,
): Promise<boolean> {
  const existing = await readIngestion(kv);
  const next = acknowledgement(body, nowIso, null);
  if (sameAcknowledgement(existing, next)) return false;
  await writeJson(kv, INGESTION_KEY, next);
  return true;
}

async function clearFailure(kv: ResultsKv, nowIso: string): Promise<boolean> {
  const existing = await readIngestion(kv);
  if (!existing?.error) return false;
  await writeJson(kv, INGESTION_KEY, { ...existing, error: null, acknowledged: true, at: nowIso });
  return true;
}

function acknowledgement(
  source: { sourceUrl: string; contentHash: string; etag: string | null; lastModified: string | null },
  nowIso: string,
  error: string | null,
): IngestionRecord {
  return { acknowledged: error == null, error, ...source, at: nowIso };
}

function sameAcknowledgement(existing: IngestionRecord | null, next: IngestionRecord): boolean {
  if (!existing) return false;
  return existing.acknowledged === next.acknowledged
    && existing.error === next.error
    && existing.sourceUrl === next.sourceUrl
    && existing.contentHash === next.contentHash
    && existing.etag === next.etag
    && existing.lastModified === next.lastModified;
}

function result(status: number, outcome: string, wrote: boolean): ImportResult {
  return { status, wrote, body: { ok: true, outcome, wrote } };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ImportError(`${label} is required`, 400);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new ImportError("Validator must be a string", 400);
  return value;
}

function requiredHash(value: unknown): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new ImportError("Workbook hash must be a SHA-256 hex string", 400);
  return value;
}

function readCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ImportError(`${label} must be a non-negative integer`, 400);
  }
  return value;
}

function readOptionalTime(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new ImportError("Published time is invalid", 400);
  return value;
}

function readError(value: unknown): string {
  const message = requiredString(value, "Ingestion error");
  return message.slice(0, 500);
}
