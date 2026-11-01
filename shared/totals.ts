export function normalizedTotals(
  candidates: Array<{ id: string; votes: number }>,
  status: string,
): string {
  const rows = [...candidates]
    .map((candidate) => `${candidate.id}:${candidate.votes}`)
    .sort();
  return `${rows.join("|")}|${status}`;
}

export function voteShare(votes: number, contestTotal: number): number {
  if (contestTotal <= 0) return 0;
  return votes / contestTotal;
}
