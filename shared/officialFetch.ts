import { isAllowedHost } from "./hosts";

const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function validateOfficialUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Official URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("Official URL must use https");
  if (url.username || url.password) throw new Error("Official URL cannot include credentials");
  if (!isAllowedHost(url.hostname)) throw new Error("Official URL host is not allowed");
  return url;
}

export async function fetchOfficial(
  value: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
): Promise<Response> {
  let current = validateOfficialUrl(value);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": "ivgid-results-widget/1.0",
        ...headersFrom(init.headers),
      },
    });
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Official redirect is missing a location");
    if (hop === MAX_REDIRECTS) throw new Error("Official URL redirected too many times");
    current = validateOfficialUrl(new URL(location, current).href);
  }
  throw new Error("Official URL redirected too many times");
}

export async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Official response exceeded the size limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function headersFrom(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}
