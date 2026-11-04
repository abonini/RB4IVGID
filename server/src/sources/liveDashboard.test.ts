import assert from "node:assert/strict";
import test from "node:test";
import config from "../../../election.config.json";
import { parseLiveDashboardText } from "./liveDashboard";

const sample = `Updated:
11/3/2026 1:20 PM
Washoe County - General Election 2026 Unofficial Results
INCLINE VILLAGE GENERAL IMPROVEMENT DISTRICT Vote For 2
NP
Brooks, Ryan "RB"
0%
0
NP
Noble, David S.
0%
0
NP
Swenson, Harry
0%
0
PALOMINO VALLEY GENERAL IMPROVEMENT DISTRICT Vote For 3
NP
Baker, Tom
10%
10
`;

test("parses IVGID totals from the live dashboard text", () => {
  const parsed = parseLiveDashboardText(sample, config);
  assert.equal(parsed.status, "unofficial");
  assert.equal(parsed.certified, false);
  assert.deepEqual(parsed.candidates.map((candidate) => candidate.votes), [0, 0, 0]);
  assert.equal(parsed.contestTotal, 0);
  assert.equal(parsed.sourceUrl, "https://electionresults.washoecounty.gov/");
  assert.ok(parsed.publishedAt);
});

test("reads non-zero live totals in ballot order", () => {
  const text = sample
    .replace("Brooks, Ryan \"RB\"\n0%\n0", "Brooks, Ryan \"RB\"\n40.3%\n1240")
    .replace("Noble, David S.\n0%\n0", "Noble, David S.\n31.8%\n980")
    .replace("Swenson, Harry\n0%\n0", "Swenson, Harry\n27.9%\n860");
  const parsed = parseLiveDashboardText(text, config);
  assert.deepEqual(parsed.candidates.map((candidate) => [candidate.id, candidate.votes]), [
    ["brooks", 1240],
    ["noble", 980],
    ["swenson", 860],
  ]);
  assert.equal(parsed.contestTotal, 3080);
});
