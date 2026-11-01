import { SourceError } from "../errors";

export function parseVoteTotal(value: string): number {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("*")) {
    throw new SourceError("Vote total is masked or missing");
  }
  const withoutCommas = trimmed.replace(/,/g, "");
  if (!/^\d+$/.test(withoutCommas)) {
    throw new SourceError(`Vote total is not a non-negative integer: ${trimmed}`);
  }
  const votes = Number(withoutCommas);
  if (!Number.isSafeInteger(votes)) {
    throw new SourceError("Vote total is out of range");
  }
  return votes;
}

export function classifyPublication(text: string): "official" | "unofficial" {
  if (/unofficial/i.test(text)) return "unofficial";
  if (/official/i.test(text)) return "official";
  return "unofficial";
}
