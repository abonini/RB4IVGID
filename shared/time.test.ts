import assert from "node:assert/strict";
import test from "node:test";
import { pacificTimestampToIso } from "./time";

test("parses a Pacific publication timestamp", () => {
  assert.equal(pacificTimestampToIso("11/3/2026 8:00:00 PM"), "2026-11-04T04:00:00.000Z");
  assert.equal(pacificTimestampToIso("6/18/2026 1:35:40 PM"), "2026-06-18T20:35:40.000Z");
  assert.equal(pacificTimestampToIso("not a time"), null);
});
