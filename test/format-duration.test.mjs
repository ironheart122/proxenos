import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration } from "../dist/util/formatDuration.js";

test("invalid and sub-second inputs", () => {
  assert.equal(formatDuration(-1), "0ms");
  assert.equal(formatDuration(Number.NaN), "0ms");
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), "0ms");
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(999), "999ms");
});

test("seconds branch drops a trailing .0 and keeps real decimals", () => {
  assert.equal(formatDuration(1_000), "1s");
  assert.equal(formatDuration(1_500), "1.5s");
  assert.equal(formatDuration(59_900), "59.9s");
});

test("values that round up to a full minute render as 1m, never 60s", () => {
  assert.equal(formatDuration(59_950), "1m");
  assert.equal(formatDuration(59_999), "1m");
  assert.equal(formatDuration(60_000), "1m");
});

test("minutes branch", () => {
  assert.equal(formatDuration(61_000), "1m 1s");
  assert.equal(formatDuration(3_599_999), "59m 59s");
});

test("hours branch", () => {
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(5_400_000), "1h 30m");
});
