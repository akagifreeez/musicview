import test from "node:test";
import assert from "node:assert/strict";
import { makeSnapshot, validateSnapshot } from "../lib/restore.mjs";

test("makeSnapshot: t 反映と範囲クランプ", () => {
  const s = makeSnapshot({
    url: "https://www.youtube.com/watch?v=drIcTb-gwPs&list=RDdrIcTb-gwPs",
    time: 88.9, vol: 250, rate: 99, mode: "weird", xfade: 8,
  });
  assert.equal(s.url, "https://www.youtube.com/watch?v=drIcTb-gwPs&list=RDdrIcTb-gwPs&t=88s");
  assert.equal(s.vol, 100);
  assert.equal(s.rate, 2);
  assert.equal(s.mode, "music");
  assert.equal(s.xfade, 8);
  assert.ok(s.savedAt > 0);
});

test("makeSnapshot: xfade は既定0で範囲クランプ", () => {
  assert.equal(makeSnapshot({ url: "https://www.youtube.com/watch?v=x" }).xfade, 0);
  assert.equal(makeSnapshot({ url: "https://www.youtube.com/watch?v=x", xfade: 99 }).xfade, 15);
});

test("makeSnapshot: eq はクランプされ viz は既定true", () => {
  const s = makeSnapshot({ url: "https://www.youtube.com/watch?v=x", eq: [12, 2, -2, 0, 2], viz: true });
  assert.deepEqual(s.eq, [12, 2, -2, 0, 2]);
  assert.equal(s.viz, true);
  assert.equal(makeSnapshot({ url: "https://www.youtube.com/watch?v=x", eq: [99, null, 1, 2, 3] }).eq[0], 15);
  assert.equal(makeSnapshot({ url: "https://www.youtube.com/watch?v=x" }).viz, true); // 欠損時はON扱い
});

test("validateSnapshot: eq/viz は欠損時に既定値", () => {
  const p = validateSnapshot({ url: "https://www.youtube.com/watch?v=x" });
  assert.deepEqual(p.eq, [0, 0, 0, 0, 0]);
  assert.equal(p.viz, true);
});

test("makeSnapshot: watch?v= 無しはnull", () => {
  assert.equal(makeSnapshot({ url: "https://www.youtube.com/" }), null);
  assert.equal(makeSnapshot({ url: null }), null);
});

test("validateSnapshot: 正常系と破損系", () => {
  const ok = validateSnapshot({ url: "https://www.youtube.com/watch?v=x&t=10s", vol: 30, rate: 1.5, mode: "site", xfade: 5, eq: [12, 2, 0, 0, 2], viz: false, savedAt: 123 });
  assert.deepEqual(ok, { url: "https://www.youtube.com/watch?v=x&t=10s", vol: 30, rate: 1.5, mode: "site", xfade: 5, eq: [12, 2, 0, 0, 2], viz: false, savedAt: 123 });

  assert.equal(validateSnapshot(null), null);
  assert.equal(validateSnapshot({}), null);
  assert.equal(validateSnapshot({ url: "http://evil.example/watch?v=x" }), null); // https の youtube 以外は拒否
  assert.equal(validateSnapshot({ url: "javascript:alert(1)" }), null);

  // 欠損フィールドは既定値で補う
  const partial = validateSnapshot({ url: "https://www.youtube.com/watch?v=x" });
  assert.equal(partial.vol, 100);
  assert.equal(partial.rate, 1);
  assert.equal(partial.mode, "music");
});
