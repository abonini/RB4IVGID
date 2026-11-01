export async function tokensMatch(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(left);
  const expectedBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < providedBytes.length; index += 1) {
    difference |= providedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

export function readBearer(header: string | null): string {
  if (!header) return "";
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? "";
}
