import { namesMatch } from "../../../shared/names";
import type { ElectionConfig, PublicationStatus } from "../../../shared/types";
import { sha256 } from "../crypto";
import { SourceError } from "../errors";
import { validateUrl } from "../http/fetchOfficial";
import type { ParsedCandidate, ParsedContest } from "./sovcWorkbook";
import { orderCandidates } from "./sovcWorkbook";
import { parseVoteTotal } from "./votes";

export interface ManualSource extends ParsedContest {
  sourceUrl: string;
  contentHash: string;
}

export function parseManualEntry(body: unknown, config: ElectionConfig): ManualSource {
  if (!body || typeof body !== "object") throw new SourceError("Manual entry must be a JSON object");
  const record = body as Record<string, unknown>;
  const sourceUrl = readSourceUrl(record.sourceUrl);
  const status = readStatus(record.status);
  const publishedAt = readPublishedAt(record.publishedAt);
  const entered = readCandidateVotes(record.candidates, config);
  const candidates = orderCandidates(entered, config.displayOrder);
  const contestTotal = candidates.reduce((total, candidate) => total + candidate.votes, 0);
  const contentHash = sha256(JSON.stringify({
    sourceUrl,
    status,
    publishedAt,
    candidates: [...candidates].sort((left, right) => left.id.localeCompare(right.id)).map((candidate) => ({
      id: candidate.id,
      votes: candidate.votes,
    })),
  }));

  return {
    sourceType: "manual",
    status,
    publishedAt,
    candidates,
    contestTotal,
    sourceUrl,
    contentHash,
  };
}

function readSourceUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SourceError("Manual entry requires the official source URL");
  }
  return validateUrl(value.trim()).href;
}

function readStatus(value: unknown): PublicationStatus {
  if (value === "official" || value === "unofficial") return value;
  throw new SourceError("Manual entry status must be unofficial or official");
}

function readPublishedAt(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new SourceError("Manual entry publishedAt must be an ISO timestamp");
  }
  return new Date(value).toISOString();
}

function readCandidateVotes(value: unknown, config: ElectionConfig): ParsedCandidate[] {
  if (!Array.isArray(value)) throw new SourceError("Manual entry requires candidate totals");
  const byId = new Map<string, number>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new SourceError("Each candidate total must be an object");
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const candidate = config.candidates.find((item) => item.id === id || namesMatch(id, item.match));
    if (!candidate) throw new SourceError("Manual entry includes an unknown candidate");
    if (byId.has(candidate.id)) throw new SourceError(`${candidate.displayName} was entered more than once`);
    if (typeof record.votes !== "number") throw new SourceError(`${candidate.displayName} needs an integer vote total`);
    byId.set(candidate.id, parseVoteTotal(String(record.votes)));
  }
  return config.candidates.map((candidate) => {
    const votes = byId.get(candidate.id);
    if (votes == null) throw new SourceError(`${candidate.displayName} is missing from the manual entry`);
    return { id: candidate.id, name: candidate.displayName, votes };
  });
}
