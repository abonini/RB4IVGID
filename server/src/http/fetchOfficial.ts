import { lookup } from "dns/promises";
import { SourceError } from "../errors";
import { isAllowedHost, isBlockedAddress } from "./addresses";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchResult {
  body: Buffer;
  finalUrl: string;
  lastModified: string | null;
}

export interface FetchDeps {
  lookupHost?: (hostname: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function fetchOfficial(url: string, deps: FetchDeps = {}): Promise<FetchResult> {
  return follow(url, {
    lookupHost: deps.lookupHost ?? defaultLookup,
    fetchImpl: deps.fetchImpl ?? fetch,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: deps.maxBytes ?? DEFAULT_MAX_BYTES,
  }, 0);
}

async function follow(url: string, deps: Required<FetchDeps>, redirects: number): Promise<FetchResult> {
  const parsed = validateUrl(url);
  const addresses = await deps.lookupHost(parsed.hostname);
  if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
    throw new SourceError(`Blocked address for ${parsed.hostname}`);
  }

  const response = await deps.fetchImpl(parsed.href, {
    redirect: "manual",
    signal: AbortSignal.timeout(deps.timeoutMs),
    headers: {
      "user-agent": "ivgid-results-widget/1.0",
      accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/pdf, text/html;q=0.9",
    },
  });

  if (REDIRECT_STATUSES.has(response.status)) {
    await response.body?.cancel();
    if (redirects >= MAX_REDIRECTS) {
      throw new SourceError("Too many redirects");
    }
    const location = response.headers.get("location");
    if (!location) throw new SourceError("Redirect missing location");
    return follow(new URL(location, parsed).href, deps, redirects + 1);
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new SourceError(`Source responded with ${response.status}`);
  }

  const body = await readLimited(response, deps.maxBytes);
  return {
    body,
    finalUrl: parsed.href,
    lastModified: response.headers.get("last-modified"),
  };
}

export function validateUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceError("Source URL is invalid");
  }
  if (url.protocol !== "https:") throw new SourceError("Source URL must use HTTPS");
  if (url.username || url.password) throw new SourceError("Source URL cannot include credentials");
  if (!isAllowedHost(url.hostname)) throw new SourceError("Source host is not an official Washoe County domain");
  return url;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "lookup failed";
    throw new SourceError(`Could not resolve ${hostname}: ${detail}`);
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new SourceError("Source response exceeds the size limit");
  }
  if (!response.body) throw new SourceError("Source response was empty");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        throw new SourceError("Source response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
