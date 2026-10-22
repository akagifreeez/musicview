import test from "node:test";
import assert from "node:assert/strict";
import { BANDS, PRESETS, clampGains, isFlat } from "../lib/eq.mjs";

test("clampGains: 5バンドに正規化され範囲クランプされる", () => {
  assert.deepEqual(clampGains([1, 2, 3, 4, 5]), [1, 2, 3, 4, 5]);
  assert.deepEqual(clampGains([99, -99, 1.6, "3", null]), [15, -12, 2, 3, 0]); // band0は上限15
  assert.deepEqual(clampGains(undefined), [0, 0, 0, 0, 0]);
  assert.deepEqual(clampGains([1, 2]), [1, 2, 0, 0, 0]); // 足りない分は0
  assert.deepEqual(clampGains([10, 14, 15, 16, 12]), [10, 12, 12, 12, 12]); // CLEAR BASSだけ+15まで
});

test("BANDS/PRESETS の整合", () => {
  assert.equal(BANDS.length, 5);
  assert.equal(BANDS[0].key, "bass");
  assert.equal(BANDS[0].max, 15); // CLEAR BASS は大きめのブーストを許す
  for (const p of Object.values(PRESETS)) {
    assert.equal(clampGains(p.gains).length, 5);
  }
  assert.deepEqual(PRESETS.flat.gains, [0, 0, 0, 0, 0]);
});

test("isFlat: 全0のみ真", () => {
  assert.equal(isFlat([0, 0, 0, 0, 0]), true);
  assert.equal(isFlat([0, 0, 1, 0, 0]), false);
  assert.equal(isFlat(null), true);
});
