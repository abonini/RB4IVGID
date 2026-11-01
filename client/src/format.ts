export function formatPacific(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function formatVotes(votes: number): string {
  return votes.toLocaleString("en-US");
}

export function formatShare(voteShare: number): string {
  return `${(voteShare * 100).toFixed(1)}%`;
}
