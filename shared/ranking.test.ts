import assert from "node:assert/strict";
import test from "node:test";
import { selectTopTwo } from "./ranking";

test("top two uses the second-place total as the cutoff", () => {
  const selection = selectTopTwo([
    { id: "a", votes: 10 },
    { id: "b", votes: 9 },
    { id: "c", votes: 8 },
  ], 2);
  assert.deepEqual(selection, { ids: ["a", "b"], tied: false });
});

test("a tie for second includes every tied candidate", () => {
  const selection = selectTopTwo([
    { id: "a", votes: 10 },
    { id: "b", votes: 8 },
    { id: "c", votes: 8 },
  ], 2);
  assert.deepEqual(selection, { ids: ["a", "b", "c"], tied: true });
});

test("an all-zero or incomplete tally has no ranking", () => {
  assert.deepEqual(selectTopTwo([
    { id: "a", votes: 0 },
    { id: "b", votes: 0 },
  ], 2), { ids: [], tied: false });
  assert.deepEqual(selectTopTwo([
    { id: "a", votes: null },
    { id: "b", votes: 4 },
  ], 2), { ids: [], tied: false });
});
