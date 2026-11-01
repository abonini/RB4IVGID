export interface RankedCandidate {
  id: string;
  votes: number | null;
}

export interface TopTwoSelection {
  ids: string[];
  tied: boolean;
}

export function selectTopTwo(candidates: RankedCandidate[], seats: number): TopTwoSelection {
  if (seats < 1 || candidates.length === 0) {
    return { ids: [], tied: false };
  }
  if (candidates.some((candidate) => candidate.votes == null)) {
    return { ids: [], tied: false };
  }
  if (candidates.every((candidate) => candidate.votes === 0)) {
    return { ids: [], tied: false };
  }

  const totals = candidates.map((candidate) => candidate.votes as number);
  const descending = [...totals].sort((left, right) => right - left);
  const cutoffIndex = Math.min(seats, descending.length) - 1;
  const cutoff = descending[cutoffIndex];
  const ids = candidates
    .filter((candidate) => (candidate.votes as number) >= cutoff)
    .map((candidate) => candidate.id);

  return { ids, tied: ids.length > seats };
}
