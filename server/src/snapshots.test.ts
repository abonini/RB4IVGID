import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { countHistory, readLatest, writeCurrent, writeHistory, type StoredSnapshot } from "./snapshots";

function snapshot(id: string, votes: number): StoredSnapshot {
  return {
    id,
    sourceType: "sovc",
    sourceUrl: "https://www.washoecounty.gov/voters/results/datafiles/file.xlsx",
    contentHash: id,
    retrievedAt: "2026-11-04T04:00:00.000Z",
    publishedAt: null,
    checkedAt: "2026-11-04T04:00:00.000Z",
    status: "unofficial",
    manual: false,
    candidates: [
      { id: "brooks", name: "Ryan \"RB\" Brooks", votes },
      { id: "noble", name: "David S. Noble", votes: 1 },
      { id: "swenson", name: "Harry Swenson", votes: 1 },
    ],
    contestTotal: votes + 2,
  };
}

test("writes history immutably and falls back when current is corrupt", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ivgid-snapshots-"));
  const first = snapshot("2026-11-04T04-00-00-000Z-aaaa", 10);
  const second = snapshot("2026-11-04T05-00-00-000Z-bbbb", 12);
  await writeHistory(directory, first);
  await writeCurrent(directory, first);
  await writeHistory(directory, second);
  await writeCurrent(directory, second);
  assert.equal(await countHistory(directory), 2);
  assert.equal((await readLatest(directory))?.contentHash, second.contentHash);

  const historyPath = path.join(directory, "history", `${first.id}.json`);
  assert.equal(JSON.parse(await fs.readFile(historyPath, "utf8")).candidates[0].votes, 10);
  await fs.writeFile(path.join(directory, "current.json"), "{");
  assert.equal((await readLatest(directory))?.contentHash, second.contentHash);
});
