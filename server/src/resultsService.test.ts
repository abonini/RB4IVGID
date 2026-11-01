import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import ExcelJS from "exceljs";
import type { RuntimeConfig } from "./config";
import { createResultsService } from "./resultsService";
import { countHistory } from "./snapshots";

const discoveryUrl = "https://www.washoecounty.gov/voters/results/2026data.php";
const fileUrl = "https://www.washoecounty.gov/voters/results/datafiles/ivgid.xlsx";
const linkedHtml = `<h3>General Election</h3><a href="datafiles/ivgid.xlsx">Download Unofficial Statement of Votes Cast</a><h3>Primary Election</h3><a href="datafiles/primary.xlsx">Download Official Statement of Votes Cast</a>`;

async function sampleWorkbook(votes: [number, number, number]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Cover").getCell("A1").value = "UNOFFICIAL RESULTS 2026";
  const sheet = workbook.addWorksheet("Contest");
  sheet.getCell("A2").value = "INCLINE VILLAGE GENERAL IMPROVEMENT DISTRICT (Vote for 2)";
  sheet.getCell("A4").value = "Precinct";
  sheet.getCell("E4").value = "Swenson, Harry";
  sheet.getCell("G4").value = "Brooks, Ryan";
  sheet.getCell("I4").value = "Noble, David";
  sheet.getCell("A12").value = "County - Total";
  sheet.getCell("E12").value = votes[0];
  sheet.getCell("G12").value = votes[1];
  sheet.getCell("I12").value = votes[2];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function testConfig(snapshotDir: string, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    discoveryPageUrl: discoveryUrl,
    officialResultsUrl: "https://electionresults.washoecounty.gov/",
    contestPattern: "INCLINE VILLAGE GENERAL IMPROVEMENT DISTRICT",
    electionYear: 2026,
    electionDate: "2026-11-03",
    office: "Incline Village General Improvement District Trustee",
    term: "Four years",
    seats: 2,
    voteFor: 2,
    displayOrder: [],
    candidates: [
      { id: "brooks", displayName: "Ryan \"RB\" Brooks", match: ["brooks"] },
      { id: "noble", displayName: "David S. Noble", match: ["noble"] },
      { id: "swenson", displayName: "Harry Swenson", match: ["swenson"] },
    ],
    mode: "live",
    sourceUrl: "",
    pdfUrl: "",
    adminToken: "secret",
    snapshotDir,
    port: 0,
    refreshIntervalMs: 300_000,
    ...overrides,
  };
}

test("records a changed file once and serves the last valid snapshot after a failure", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ivgid-results-"));
  const first = await sampleWorkbook([100, 300, 200]);
  const second = await sampleWorkbook([110, 310, 210]);
  let file = first;
  let fail = false;
  let currentTime = Date.parse("2026-11-04T04:00:00.000Z");
  const service = createResultsService({
    config: testConfig(directory),
    now: () => currentTime,
    fetchOfficial: async (url) => {
      if (url === discoveryUrl) return { body: Buffer.from(linkedHtml), finalUrl: url, lastModified: null };
      if (fail) throw new Error("county unavailable");
      return { body: file, finalUrl: fileUrl, lastModified: "Tue, 03 Nov 2026 20:00:00 GMT" };
    },
  });

  const initial = await service.refresh();
  assert.equal(initial.stale, false);
  assert.equal(initial.candidates.find((candidate) => candidate.id === "brooks")?.votes, 300);
  assert.equal(initial.publishedAt, "2026-11-03T20:00:00.000Z");
  assert.equal(await countHistory(directory), 1);

  currentTime += 60_000;
  const repeated = await service.refresh();
  assert.equal(await countHistory(directory), 1);
  assert.notEqual(repeated.checkedAt, initial.checkedAt);
  assert.equal(repeated.retrievedAt, initial.retrievedAt);

  currentTime += 60_000;
  file = second;
  const changed = await service.refresh();
  assert.equal(changed.candidates.find((candidate) => candidate.id === "brooks")?.votes, 310);
  assert.equal(await countHistory(directory), 2);

  currentTime += 60_000;
  fail = true;
  file = Buffer.from("this is not a workbook");
  const stale = await service.refresh();
  assert.equal(stale.stale, true);
  assert.equal(stale.candidates.find((candidate) => candidate.id === "brooks")?.votes, 310);
  assert.match(stale.warning ?? "", /last validated/);
  assert.equal(await countHistory(directory), 2);
  const health = await service.getHealth();
  assert.equal(health.fresh, false);
  assert.equal(health.stale, true);
  assert.equal(health.snapshotCount, 2);
});

test("a failed first fetch does not invent votes or a stale snapshot", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ivgid-fail-"));
  const service = createResultsService({
    config: testConfig(directory),
    fetchOfficial: async () => {
      throw new Error("county unavailable");
    },
  });
  const results = await service.refresh();
  assert.equal(results.status, "awaiting");
  assert.equal(results.stale, false);
  assert.match(results.warning ?? "", /could not be validated/);
  assert.equal(results.candidates.every((candidate) => candidate.votes == null), true);
  const health = await service.getHealth();
  assert.equal(health.stale, false);
  assert.equal(health.fresh, false);
  assert.equal(await countHistory(directory), 0);
});

test("awaits publication without writing a snapshot or inventing zeros", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ivgid-await-"));
  const service = createResultsService({
    config: testConfig(directory),
    fetchOfficial: async (url) => ({
      body: Buffer.from("<h3>General Election</h3><p>Download Unofficial Statement of Votes Cast</p><h3>Primary Election</h3>"),
      finalUrl: url,
      lastModified: null,
    }),
  });
  const results = await service.refresh();
  assert.equal(results.status, "awaiting");
  assert.equal(results.candidates.every((candidate) => candidate.votes == null), true);
  assert.equal(await countHistory(directory), 0);
});

test("shares one refresh while a download is in flight", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ivgid-flight-"));
  const file = await sampleWorkbook([1, 2, 3]);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fetches = 0;
  const service = createResultsService({
    config: testConfig(directory),
    fetchOfficial: async (url) => {
      fetches += 1;
      if (url === discoveryUrl) return { body: Buffer.from(linkedHtml), finalUrl: url, lastModified: null };
      await gate;
      return { body: file, finalUrl: fileUrl, lastModified: null };
    },
  });
  const first = service.refresh();
  const second = service.refresh();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fetches, 2);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.candidates[0]?.votes, right.candidates[0]?.votes);
  assert.equal(fetches, 2);
});

test("mock mode never calls the county and manual entry stays labeled", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ivgid-manual-"));
  let called = false;
  const service = createResultsService({
    config: testConfig(directory, { mode: "mock" }),
    fetchOfficial: async () => {
      called = true;
      throw new Error("should not fetch");
    },
  });
  const simulated = await service.getResults();
  assert.equal(called, false);
  assert.equal(simulated.simulated, true);
  assert.equal(simulated.manual, false);
  assert.equal(simulated.candidates.find((candidate) => candidate.id === "brooks")?.votes, 1240);

  const live = createResultsService({
    config: testConfig(directory),
    fetchOfficial: async () => {
      throw new Error("county down");
    },
  });
  const saved = await live.applyManualEntry({
    sourceUrl: "https://electionresults.washoecounty.gov/",
    status: "unofficial",
    publishedAt: "2026-11-04T04:00:00.000Z",
    candidates: [
      { id: "brooks", votes: 5 },
      { id: "noble", votes: 4 },
      { id: "swenson", votes: 3 },
    ],
  });
  assert.equal(saved.manual, true);
  assert.equal(saved.simulated, false);
  assert.equal(saved.source.url, "https://electionresults.washoecounty.gov/");
  assert.equal(saved.candidates.find((candidate) => candidate.id === "swenson")?.votes, 3);
  await assert.rejects(() => live.applyManualEntry({
    sourceUrl: "https://www.washoecounty.gov/voters/results/2026data.php",
    status: "unofficial",
    candidates: [{ id: "brooks", votes: 1 }],
  }), /missing/);
  const health = await live.getHealth();
  assert.equal(health.contentHashPrefix?.length, 12);
  assert.equal((await live.getResults()).candidates.find((candidate) => candidate.id === "swenson")?.votes, 3);
});
