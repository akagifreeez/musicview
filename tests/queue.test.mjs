import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQueue, shuffledOrder, nextShuffled, sanitizeQueue, removeOne, insertAfterOne } from "../lib/queue.mjs";

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

const ID = (n) => ("aaaaaaaaaa" + String(n).slice(0, 1)).slice(0, 11); // 11文字のダミーID

test("sanitizeQueue: 11文字IDのみ残し重複を除去・配列以外は空", () => {
  assert.deepEqual(sanitizeQueue([ID(1), "x", ID(2), ID(1), null, 5]), [ID(1), ID(2)]);
  assert.deepEqual(sanitizeQueue("aaa"), []);
  assert.deepEqual(sanitizeQueue(null), []);
  // 11文字チェック
  assert.deepEqual(sanitizeQueue(["aaaaaaaaaa1"]), ["aaaaaaaaaa1"]);
  assert.deepEqual(sanitizeQueue(["aaaaaaaaaaa1"]), []); // 12文字は落とす
});

test("removeOne: 最初の 1 個だけ除去・元配列は触らない", () => {
  const base = [ID(1), ID(2), ID(1)];
  assert.deepEqual(removeOne(base, ID(1)), [ID(2), ID(1)]);
  assert.deepEqual(base, [ID(1), ID(2), ID(1)]); // 破壊しない
  assert.deepEqual(removeOne(base, ID(9)), base);
  assert.deepEqual(removeOne(null, ID(1)), []);
});

test("insertAfterOne: 直後に挿入・重複は移動・現在曲が無ければ先頭", () => {
  assert.deepEqual(insertAfterOne([ID(1), ID(2), ID(3)], ID(1), ID(4)), [ID(1), ID(4), ID(2), ID(3)]);
  // 挿入対象が既にキューにある=移動する(重複を作らない)
  assert.deepEqual(insertAfterOne([ID(1), ID(2), ID(3)], ID(1), ID(3)), [ID(1), ID(3), ID(2)]);
  // 現在曲が見つからない=先頭へ
  assert.deepEqual(insertAfterOne([ID(1), ID(2)], ID(9), ID(3)), [ID(3), ID(1), ID(2)]);
});
