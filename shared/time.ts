export function pacificTimestampToIso(value: string): string | null {
  const match = value
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)$/i);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const marker = match[7].toUpperCase();
  if (!isValidClock(month, day, hour, minute, second)) return null;
  if (marker === "PM" && hour < 12) hour += 12;
  if (marker === "AM" && hour === 12) hour = 0;

  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    utc = desiredUtc - pacificOffsetMinutes(new Date(utc)) * 60_000;
  }
  const parsed = new Date(utc);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isValidClock(month: number, day: number, hour: number, minute: number, second: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour >= 1 && hour <= 12 && minute <= 59 && second <= 59;
}

function pacificOffsetMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "shortOffset",
    hour: "2-digit",
  }).formatToParts(date);
  const zone = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT-8";
  const match = zone.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return -480;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}
