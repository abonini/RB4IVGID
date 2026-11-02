import assert from "node:assert/strict";
import test from "node:test";
import { hasLiveTotals, headerLabel } from "./electionNight";

const liveVotes = { status: "unofficial" as const, candidates: [{ votes: 10 }, { votes: 8 }, { votes: 6 }] };

test("header label follows reporting status", () => {
  const awaiting = { status: "awaiting" as const, candidates: [{ votes: null }] };
  assert.equal(headerLabel(awaiting), "AWAITING RESULTS");
  assert.equal(headerLabel(null), "AWAITING RESULTS");
  assert.equal(headerLabel(liveVotes), "UNOFFICIAL RESULTS");
  assert.equal(headerLabel({ ...liveVotes, status: "official" }), "OFFICIAL RESULTS");
  assert.equal(headerLabel({ ...liveVotes, status: "official", certified: true }), "CERTIFIED RESULTS");
});

test("simulated payload is not treated as live totals", () => {
  const simulated = { ...liveVotes, simulated: true };
  assert.equal(hasLiveTotals(simulated), false);
  assert.equal(headerLabel(simulated), "SIMULATED PREVIEW");
  assert.equal(hasLiveTotals(liveVotes), true);
  assert.equal(hasLiveTotals({ status: "awaiting", candidates: [{ votes: null }] }), false);
});
