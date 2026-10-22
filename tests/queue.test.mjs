import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQueue, shuffledOrder, nextShuffled } from "../lib/queue.mjs";

test("normalizeQueue: getPlaylist の配列を正規化(重複除去)", () => {
  const q = normalizeQueue({ queue: ["aaa", "bbb", "aaa", 3, null, "ccc"], videoId: "aaa", qIdx: 0 });
  assert.deepEqual(q, ["aaa", "bbb", "ccc"]);
});

test("normalizeQueue: プレイリスト外の単発は現在曲1件", () => {
  assert.deepEqual(normalizeQueue({ queue: null, videoId: "drIcTb-gwPs" }), ["drIcTb-gwPs"]);
  assert.deepEqual(normalizeQueue({ queue: [], videoId: "drIcTb-gwPs" }), ["drIcTb-gwPs"]);
  assert.deepEqual(normalizeQueue({ queue: ["x", "y"] }), ["x", "y"]);
  assert.deepEqual(normalizeQueue(null), []);
});

test("shuffledOrder: 現在曲が先頭で残りは並べ替わる", () => {
  const queue = ["a", "b", "c", "d", "e"];
  const order = shuffledOrder(queue, 2);
  assert.equal(order[0], "c");
  assert.equal(order.length, 5);
  assert.deepEqual([...order].sort(), [...queue].sort());
  // ランダム性に左右されないよう、集合と先頭を複数回確認する
  for (let i = 0; i < 10; i++) {
    const o = shuffledOrder(queue, 2);
    assert.deepEqual([...o].sort(), [...queue].sort());
    assert.equal(o[0], "c");
  }
});

test("shuffledOrder: qIdx 範囲外はクランプ、空は空", () => {
  assert.equal(shuffledOrder(["a", "b"], 99)[0], "b");
  assert.deepEqual(shuffledOrder([], 0), []);
});

test("nextShuffled: 順序に沿って進み末尾で null", () => {
  const order = ["c", "a", "b"];
  assert.equal(nextShuffled(order, "c"), "a");
  assert.equal(nextShuffled(order, "a"), "b");
  assert.equal(nextShuffled(order, "b"), null);
  assert.equal(nextShuffled(order, "z"), null); // 順序に無い曲
  assert.equal(nextShuffled([], "c"), null);
});
