import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import ExcelJS from "exceljs";
import test from "node:test";
import { syncElectionResults } from "./syncElectionResults";
import { applyImport } from "../worker/src/import";
import { memoryKv } from "../worker/src/memoryKv";
import { buildHealth, buildResults } from "../worker/src/publicState";
import { MONITOR_KEY, emptyMonitor, revisionKey, type ResultsKv } from "../worker/src/records";
import { readCurrent, readIngestion, readMonitor, writeJson } from "../worker/src/store";

const generalUrl = "https://www.washoecounty.gov/voters/results/datafiles/general.xlsx";
const pageUrl = "https://www.washoecounty.gov/voters/results/2026data.php";
const html = `<h3>Primary Election</h3>
<a href="https://www.washoecounty.gov/voters/results/datafiles/primary.xlsx">Download Unofficial Statement of Votes Cast</a>
<h3>General Election</h3>
<a href="${generalUrl}">Download Unofficial Statement of Votes Cast</a>
<h3>Primary Election</h3>`;

test("discovers, publishes, skips duplicates, and recovers from a rejected workbook", async () => {
  const kv = memoryKv();
  const files = new Map<string, { etag: string; bytes: Buffer }>();
  files.set(generalUrl, { etag: '"v1"', bytes: await workbook([300, 200, 100]) });
  const api = await listen((request, response) => handleApi(request, response, kv));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.startsWith("https://www.washoecounty.gov/")) return countyResponse(url, files);
    return fetch(input, init);
  };
  const options = {
    apiBase: api.url,
    adminToken: "test-token",
    discoveryPageUrl: pageUrl,
    fetchImpl,
    retryDelays: [0],
    sleep: async () => undefined,
  };

  const first = await syncElectionResults(options);
  assert.equal(first.outcome, "published");
  const published = await readCurrent(kv);
  assert.equal(published?.sourceUrl, generalUrl);
  assert.deepEqual(published?.candidates.map((candidate) => candidate.votes), [300, 200, 100]);
  const writes = kv.writes();

  const duplicate = await syncElectionResults(options);
  assert.equal(duplicate.outcome, "unchanged");
  assert.equal(kv.writes(), writes);

  files.set(generalUrl, { etag: '"v2"', bytes: await workbook([310, 200, 100]) });
  await markPending(kv, '"v2"');
  const changed = await syncElectionResults(options);
  assert.equal(changed.outcome, "published");
  assert.deepEqual((await readCurrent(kv))?.candidates.map((candidate) => candidate.votes), [310, 200, 100]);
  assert.equal((await health(kv)).pendingSource, null);

  files.set(generalUrl, { etag: '"v3"', bytes: await brokenWorkbook() });
  await markPending(kv, '"v3"');
  const failed = await syncElectionResults(options);
  assert.equal(failed.outcome, "failed");
  assert.deepEqual((await readCurrent(kv))?.candidates.map((candidate) => candidate.votes), [310, 200, 100]);
  assert.match((await health(kv)).ingestionFailure ?? "", /not found/);

  files.set(generalUrl, { etag: '"v4"', bytes: await workbook([320, 210, 110]) });
  await markPending(kv, '"v4"');
  const recovered = await syncElectionResults(options);
  assert.equal(recovered.outcome, "published");
  const restored = await health(kv);
  assert.equal(restored.ingestionFailure, null);
  assert.equal(restored.pendingSource, null);
  assert.deepEqual((await readCurrent(kv))?.candidates.map((candidate) => candidate.votes), [320, 210, 110]);
  await api.close();
});

test("waits quietly before the general-election workbook is posted", async () => {
  const kv = memoryKv();
  const api = await listen((request, response) => handleApi(request, response, kv));
  const preElection = `<h3>Primary Election</h3>
<a href="https://www.washoecounty.gov/voters/results/datafiles/primary.xlsx">Download Unofficial Statement of Votes Cast</a>`;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url === pageUrl) return new Response(preElection);
    if (url.startsWith("https://www.washoecounty.gov/")) return new Response("missing", { status: 404 });
    return fetch(input, init);
  };
  const result = await syncElectionResults({
    apiBase: api.url,
    adminToken: "test-token",
    discoveryPageUrl: pageUrl,
    fetchImpl,
    retryDelays: [0],
    sleep: async () => undefined,
  });
  assert.equal(result.outcome, "waiting");
  assert.equal(await readCurrent(kv), null);
  assert.equal(kv.writes(), 0);
  await api.close();
});

async function health(kv: ResultsKv) {
  return buildHealth(await readCurrent(kv), await readMonitor(kv), await readIngestion(kv), "actions");
}

async function markPending(kv: ResultsKv, etag: string): Promise<void> {
  await writeJson(kv, MONITOR_KEY, {
    ...emptyMonitor(),
    discoveredUrl: generalUrl,
    etag,
    revisionKey: revisionKey(generalUrl, etag, null),
    lastSourceChangeAt: "2026-11-03T20:00:00.000Z",
    lastSourceCheckAt: "2026-11-03T20:00:00.000Z",
    dispatchStatus: "sent",
    lastDispatchAt: "2026-11-03T20:00:00.000Z",
  });
}

function countyResponse(url: string, files: Map<string, { etag: string; bytes: Buffer }>): Response {
  if (url === pageUrl) return new Response(html);
  const file = files.get(url);
  if (!file) return new Response("missing", { status: 404 });
  return new Response(file.bytes, {
    status: 200,
    headers: { etag: file.etag, "content-length": "128" },
  });
}

async function handleApi(request: IncomingMessage, response: ServerResponse, kv: ResultsKv): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/health") {
    send(response, 200, await health(kv));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/results") {
    send(response, 200, buildResults(await readCurrent(kv), await readMonitor(kv), await readIngestion(kv)));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/import") {
    const header = request.headers.authorization ?? "";
    if (header !== "Bearer test-token") {
      send(response, 401, { ok: false, error: "Unauthorized" });
      return;
    }
    const raw = await readRequest(request);
    try {
      const result = await applyImport(kv, JSON.parse(raw) as unknown, new Date().toISOString());
      send(response, result.status, result.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import failed";
      send(response, 400, { ok: false, error: message });
    }
    return;
  }
  send(response, 404, { ok: false, error: "Not found" });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function readRequest(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Test API failed";
      console.error("Test API request failed", message);
      if (!response.headersSent) send(response, 500, { ok: false, error: message });
    });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test API did not start");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function workbook(votes: number[]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const cover = book.addWorksheet("Cover");
  cover.getCell("A1").value = "UNOFFICIAL RESULTS 2026";
  const sheet = book.addWorksheet("Contest");
  sheet.getCell("A2").value = "INCLINE VILLAGE GENERAL IMPROVEMENT DISTRICT (Vote for  2)";
  sheet.getCell("A4").value = "Precinct";
  ["BROOKS, RYAN", "Noble, David S.", "Swenson, Harry"].forEach((name, index) => {
    sheet.getCell(4, 5 + index * 2).value = name;
  });
  sheet.getCell("A12").value = "Washoe County - Total";
  votes.forEach((total, index) => {
    sheet.getCell(12, 5 + index * 2).value = total;
  });
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function brokenWorkbook(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const cover = book.addWorksheet("Cover");
  cover.getCell("A1").value = "UNOFFICIAL RESULTS 2026";
  book.addWorksheet("Other");
  return Buffer.from(await book.xlsx.writeBuffer());
}
