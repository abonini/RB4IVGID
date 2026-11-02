import assert from "node:assert/strict";
import test from "node:test";
import { POLL_CLOSE_MS, countdownParts, hasLiveTotals, headerLabel } from "./electionNight";

const liveVotes = { status: "unofficial" as const, candidates: [{ votes: 10 }, { votes: 8 }, { votes: 6 }] };

test("poll close is 7:00 PM Pacific on November 3, 2026", () => {
  assert.equal(new Date(POLL_CLOSE_MS).toISOString(), "2026-11-04T03:00:00.000Z");
});

test("countdown reaches zero at poll close", () => {
  const before = countdownParts(POLL_CLOSE_MS - 1000);
  assert.equal(before.closed, false);
  assert.equal(before.days, 0);
  assert.equal(before.hours, 0);
  assert.equal(before.minutes, 0);
  assert.equal(before.seconds, 1);

  const closed = countdownParts(POLL_CLOSE_MS + 5000);
  assert.equal(closed.closed, true);
  assert.equal(closed.seconds, 0);
});

test("header label follows close time and reporting status", () => {
  const awaiting = { status: "awaiting" as const, candidates: [{ votes: null }] };
  assert.equal(headerLabel(awaiting, POLL_CLOSE_MS - 1), "AWAITING RESULTS");
  assert.equal(headerLabel(awaiting, POLL_CLOSE_MS), "AWAITING FIRST RESULTS");
  assert.equal(headerLabel(liveVotes, POLL_CLOSE_MS), "UNOFFICIAL RESULTS");
  assert.equal(headerLabel({ ...liveVotes, status: "official" }, POLL_CLOSE_MS), "OFFICIAL RESULTS");
  assert.equal(headerLabel({ ...liveVotes, status: "official", certified: true }, POLL_CLOSE_MS), "CERTIFIED RESULTS");
});

test("simulated payload is not treated as live totals", () => {
  const simulated = { ...liveVotes, simulated: true };
  assert.equal(hasLiveTotals(simulated), false);
  assert.equal(headerLabel(simulated, POLL_CLOSE_MS - 1), "SIMULATED PREVIEW");
  assert.equal(hasLiveTotals(liveVotes), true);
  assert.equal(hasLiveTotals({ status: "awaiting", candidates: [{ votes: null }] }), false);
});
