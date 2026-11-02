export interface NightStatusInput {
  simulated?: boolean;
  certified?: boolean;
  status?: "awaiting" | "unofficial" | "official";
  candidates?: Array<{ votes: number | null }>;
}

export type HeaderLabel =
  | "AWAITING RESULTS"
  | "UNOFFICIAL RESULTS"
  | "OFFICIAL RESULTS"
  | "CERTIFIED RESULTS"
  | "SIMULATED PREVIEW";

export function hasLiveTotals(results: NightStatusInput | null | undefined): boolean {
  if (!results || results.simulated) return false;
  const candidates = results.candidates ?? [];
  return candidates.length > 0 && candidates.every((candidate) => typeof candidate.votes === "number");
}

export function headerLabel(results: NightStatusInput | null | undefined): HeaderLabel {
  if (results?.simulated) return "SIMULATED PREVIEW";
  if (hasLiveTotals(results)) {
    if (results?.certified) return "CERTIFIED RESULTS";
    if (results?.status === "official") return "OFFICIAL RESULTS";
    return "UNOFFICIAL RESULTS";
  }
  return "AWAITING RESULTS";
}
