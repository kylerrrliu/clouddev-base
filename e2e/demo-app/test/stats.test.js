import assert from "node:assert/strict";
import { test } from "node:test";
import { average, median } from "../src/stats.js";

test("average", () => {
  assert.equal(average([2, 4, 6]), 4);
  assert.equal(average([5]), 5);
});

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([10, 2, 33, 4]), 7);
});
