import assert from "node:assert/strict";
import test from "node:test";
import { applyImport } from "./import";
import { memoryKv } from "./memoryKv";
import { readCurrent } from "./store";

const sourceUrl = "https://www.washoecounty.gov/voters/results/datafiles/general.xlsx";

test("rejects an older snapshot and does not rewrite the current totals", async () => {
  const kv = memoryKv();
  const first = published("a".repeat(64), null, "2026-11-04T04:00:00.000Z", 10);
  assert.equal((await applyImport(kv, first, "2026-11-04T04:10:00.000Z")).wrote, true);
  const writes = kv.writes();
  await assert.rejects(
    () => applyImport(kv, published("b".repeat(64), "a".repeat(64), "2026-11-04T03:00:00.000Z", 11), "2026-11-04T05:00:00.000Z"),
    /Older results cannot replace/,
  );
  assert.equal(kv.writes(), writes);
  const current = await readCurrent(kv);
  assert.equal(current?.candidates[0]?.votes, 10);
});

test("a duplicate hash does not write another snapshot", async () => {
  const kv = memoryKv();
  const body = published("c".repeat(64), null, null, 4);
  await applyImport(kv, body, "2026-11-04T04:10:00.000Z");
  const writes = kv.writes();
  const second = await applyImport(kv, { ...body, replacesHash: "c".repeat(64) }, "2026-11-04T04:20:00.000Z");
  assert.equal(second.wrote, false);
  assert.equal(kv.writes(), writes);
});

test("simulated results are rejected", async () => {
  const kv = memoryKv();
  await assert.rejects(
    () => applyImport(kv, { ...published("d".repeat(64), null, null, 1), simulated: true }, "2026-11-04T04:10:00.000Z"),
    /Simulated results/,
  );
  assert.equal(kv.writes(), 0);
});

function published(hash: string, replacesHash: string | null, publishedAt: string | null, votes: number) {
  return {
    outcome: "published",
    sourceUrl,
    contentHash: hash,
    etag: '"one"',
    lastModified: null,
    status: "unofficial",
    certified: false,
    publishedAt,
    replacesHash,
    contestTitle: "INCLINE VILLAGE GENERAL IMPROVEMENT DISTRICT 2026",
    electionYear: 2026,
    candidates: [
      { id: "brooks", votes },
      { id: "noble", votes: 2 },
      { id: "swenson", votes: 3 },
    ],
    contestTotal: votes + 5,
    sourceLabel: "Download Unofficial Statement of Votes Cast",
  };
}
