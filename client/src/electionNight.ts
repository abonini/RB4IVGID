export const POLL_CLOSE_ISO = "2026-11-03T19:00:00-08:00";
export const POLL_CLOSE_MS = Date.parse(POLL_CLOSE_ISO);

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  closed: boolean;
}

export interface NightStatusInput {
  simulated?: boolean;
  certified?: boolean;
  status?: "awaiting" | "unofficial" | "official";
  candidates?: Array<{ votes: number | null }>;
}

export type HeaderLabel =
  | "AWAITING RESULTS"
  | "AWAITING FIRST RESULTS"
  | "UNOFFICIAL RESULTS"
  | "OFFICIAL RESULTS"
  | "CERTIFIED RESULTS"
  | "SIMULATED PREVIEW";

export function countdownParts(nowMs: number, closeMs = POLL_CLOSE_MS): CountdownParts {
  const remainingMs = Math.max(0, closeMs - nowMs);
  const totalSeconds = Math.floor(remainingMs / 1000);
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3_600),
    minutes: Math.floor((totalSeconds % 3_600) / 60),
    seconds: totalSeconds % 60,
    closed: remainingMs === 0,
  };
}

export function padUnit(value: number): string {
  return String(Math.max(0, value)).padStart(2, "0");
}

export function hasLiveTotals(results: NightStatusInput | null | undefined): boolean {
  if (!results || results.simulated) return false;
  const candidates = results.candidates ?? [];
  return candidates.length > 0 && candidates.every((candidate) => typeof candidate.votes === "number");
}

export function headerLabel(
  results: NightStatusInput | null | undefined,
  nowMs: number,
  closeMs = POLL_CLOSE_MS,
): HeaderLabel {
  if (results?.simulated) return "SIMULATED PREVIEW";
  if (hasLiveTotals(results)) {
    if (results?.certified) return "CERTIFIED RESULTS";
    if (results?.status === "official") return "OFFICIAL RESULTS";
    return "UNOFFICIAL RESULTS";
  }
  return nowMs >= closeMs ? "AWAITING FIRST RESULTS" : "AWAITING RESULTS";
}

export function showResultsOverlay(results: NightStatusInput | null | undefined): boolean {
  if (results?.simulated) return false;
  return !hasLiveTotals(results);
}
