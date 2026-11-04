import { createHash } from "node:crypto";
import { LIVE_RESULTS_URL } from "../../../shared/liveResults";
import { namesMatch } from "../../../shared/names";
import type { ElectionConfig } from "../../../shared/types";
import { SourceError } from "../errors";
import { classifyPublication, parseVoteTotal } from "./votes";

export { LIVE_RESULTS_URL };

export interface LiveDashboardResult {
  sourceUrl: string;
  sourceLabel: string;
  status: "unofficial" | "official";
  certified: boolean;
  publishedAt: string | null;
  candidates: Array<{ id: string; votes: number }>;
  contestTotal: number;
  contentHash: string;
  contestTitle: string;
}

export function parseLiveDashboardText(text: string, config: ElectionConfig): LiveDashboardResult {
  const block = contestBlock(text, config.contestPattern);
  if (!block) throw new SourceError("IVGID contest was not found on the live results page");
  if (!text.includes(String(config.electionYear))) {
    throw new SourceError(`Live results page does not contain election year ${config.electionYear}`);
  }

  const candidates = config.candidates.map((candidate) => {
    const votes = readCandidateVotes(block, candidate.displayName, candidate.match);
    return { id: candidate.id, votes };
  });
  const contestTotal = candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
  const status = classifyPublication(text);
  const publishedAt = readUpdatedAt(text);
  const sourceLabel = "Washoe County live election results";
  const contestTitle = `${config.contestPattern} ${config.electionYear}`;
  const contentHash = createHash("sha256")
    .update([
      LIVE_RESULTS_URL,
      status,
      publishedAt ?? "",
      ...candidates.map((candidate) => `${candidate.id}:${candidate.votes}`),
    ].join("|"))
    .digest("hex");

  return {
    sourceUrl: LIVE_RESULTS_URL,
    sourceLabel,
    status,
    certified: /certified|official final/i.test(text),
    publishedAt,
    candidates,
    contestTotal,
    contentHash,
    contestTitle,
  };
}

function contestBlock(text: string, contestPattern: string): string | null {
  const start = text.search(new RegExp(escapeRegExp(contestPattern), "i"));
  if (start < 0) return null;
  const after = text.slice(start);
  const nextContest = after.search(/\n[A-Z0-9][A-Z0-9 .,'"&-]{8,}(?:\n| Vote For)/);
  if (nextContest > 0) return after.slice(0, nextContest);
  return after.slice(0, 1_200);
}

function readCandidateVotes(block: string, displayName: string, match: string[]): number {
  const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!namesMatch(line, [displayName, ...match])) continue;
    for (let look = index + 1; look <= index + 4 && look < lines.length; look += 1) {
      const candidate = lines[look];
      if (/^\d+(\.\d+)?%$/.test(candidate)) continue;
      if (/^(NP|DEM|REP|LPN|IAP|IND|D|R|L|I|N|NA)$/i.test(candidate)) continue;
      try {
        return parseVoteTotal(candidate);
      } catch {
        continue;
      }
    }
  }
  throw new SourceError(`Live results are missing votes for ${displayName}`);
}

function readUpdatedAt(text: string): string | null {
  const match = text.match(/Updated:\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}\s+[0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))/i);
  if (!match) return null;
  const parsed = Date.parse(`${match[1]} GMT-0800`);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
