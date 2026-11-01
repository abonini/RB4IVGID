import { createHash, timingSafeEqual } from "crypto";

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function tokensMatch(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export function readBearer(header: string | undefined): string {
  if (!header) return "";
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? "";
}
