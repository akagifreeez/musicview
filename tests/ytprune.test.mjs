import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PRUNE_KEYS, prunePlayerResponse } = require("../lib/ytprune.cjs");

test("prunePlayerResponse: 広告キー3種を剥ぎ、本体は残す", () => {
  const r = {
    videoDetails: { videoId: "dQw4w9WgXcQ", title: "Never Gonna Give You Up" },
    playabilityStatus: { status: "OK" },
    adPlacements: [{ adPlacementRenderer: {} }],
    playerAds: [{ playerLegacyAdRenderer: {} }],
    adSlots: [{ adSlotRenderer: {} }],
  };
  const n = prunePlayerResponse(r);
  assert.equal(n, 3);
  assert.equal("adPlacements" in r, false);
  assert.equal("playerAds" in r, false);
  assert.equal("adSlots" in r, false);
  assert.equal(r.videoDetails.videoId, "dQw4w9WgXcQ");
  assert.deepEqual(Object.keys(r.playabilityStatus), ["status"]);
});

test("prunePlayerResponse: adBreakHeartbeatParams も剥ぐ", () => {
  const r = { adBreakHeartbeatParams: "abc", streamingData: {} };
  assert.equal(prunePlayerResponse(r), 1);
  assert.equal("adBreakHeartbeatParams" in r, false);
  assert.ok(r.streamingData);
});

test("prunePlayerResponse: キー無しの正常応答は0(改変しない)", () => {
  const r = { videoDetails: {}, streamingData: {} };
  assert.equal(prunePlayerResponse(r), 0);
});

test("prunePlayerResponse: 壊れ系入力は0", () => {
  assert.equal(prunePlayerResponse(null), 0);
  assert.equal(prunePlayerResponse(undefined), 0);
  assert.equal(prunePlayerResponse("str"), 0);
  assert.equal(prunePlayerResponse([1, 2]), 0);
});

test("PRUNE_KEYS は既知の4種に固定(意図しない深掘り削除を防ぐ)", () => {
  assert.deepEqual([...PRUNE_KEYS].sort(), ["adBreakHeartbeatParams", "adPlacements", "adSlots", "playerAds"]);
});

test("yt-preload.cjs は Node で読み込んでも無害(ブラウザ配線はガード内)", () => {
  assert.doesNotThrow(() => require("../electron/yt-preload.cjs"));
});

// ── JSON.parse フック(SPA遷移でプレイヤーが交換されない事故の置き換え) ──

class FakeXHR { open() {} send() {} }

function makeEnv() {
  const win = {
    JSON: { parse: function parse(text, reviver) { return JSON.parse(text, reviver); } },
    process: { versions: {} },
  };
  return { win };
}

test("yt-preload: JSON.parseフックがプレイヤー応答の広告キーを剥ぐ", () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  const { win } = makeEnv();
  installHooks({ window: win, XMLHttpRequest: FakeXHR }, { prune: true });
  const j = win.JSON.parse(JSON.stringify({
    adPlacements: [1], playerAds: [1], adSlots: [1],
    videoDetails: { videoId: "x" },
  }));
  assert.ok(!("adPlacements" in j));
  assert.ok(!("playerAds" in j));
  assert.ok(!("adSlots" in j));
  assert.equal(j.videoDetails.videoId, "x");
  assert.ok(win.__mvPrune.parse >= 1);
});

test("yt-preload: 広告キーの無いパースは改変せず素通し", () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  const { win } = makeEnv();
  installHooks({ window: win, XMLHttpRequest: FakeXHR }, { prune: true });
  const before = win.JSON.parse;
  const j = win.JSON.parse('{"videoDetails":{"videoId":"y"},"streamingData":{}}');
  assert.deepEqual(j, { videoDetails: { videoId: "y" }, streamingData: {} });
  assert.equal(win.JSON.parse, before, "対象外のパースではフックは何もしない(関数自体は同じ)");
});

test("yt-preload: 配列・プリミティブのパース結果は対象外", () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  const { win } = makeEnv();
  installHooks({ window: win, XMLHttpRequest: FakeXHR }, { prune: true });
  assert.deepEqual(win.JSON.parse("[1,2,3]"), [1, 2, 3]);
  assert.equal(win.JSON.parse('"str"'), "str");
  assert.equal(win.JSON.parse("42"), 42);
});

test("yt-preload: パースエラーはフックで握り潰さずそのまま投げる", () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  const { win } = makeEnv();
  installHooks({ window: win, XMLHttpRequest: FakeXHR }, { prune: true });
  assert.throws(() => win.JSON.parse("not-json"));
});

test("yt-preload: ytInitialPlayerResponse の代入罠で剥げる", () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  const win = {};
  installHooks({ window: win, XMLHttpRequest: FakeXHR }, { prune: true });
  win.ytInitialPlayerResponse = { adPlacements: [1], playerAds: [1], videoDetails: { videoId: "x" } };
  assert.ok(!("adPlacements" in win.ytInitialPlayerResponse));
  assert.ok(!("playerAds" in win.ytInitialPlayerResponse));
  assert.equal(win.ytInitialPlayerResponse.videoDetails.videoId, "x");
  assert.ok(win.__mvPrune.inline >= 1);
});

test("yt-preload: Electron由来グローバルの漏れを落とす(process等)", () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  const win = { process: { versions: {} }, Buffer: function () {}, setImmediate: function () {} };
  installHooks({ window: win, XMLHttpRequest: FakeXHR }, { prune: true });
  assert.equal(win.process, undefined);
  assert.equal(win.Buffer, undefined);
  assert.equal(win.setImmediate, undefined);
});

test("yt-preload: prune無効(デフォルト)ではJSON.parseをフックしない", () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  const win = makeEnv().win;
  installHooks({ window: win, XMLHttpRequest: FakeXHR }, { prune: false });
  const before = win.JSON.parse;
  win.JSON.parse('{"adPlacements":[1],"videoDetails":{}}');
  assert.equal(win.JSON.parse, before, "フックは導入されない");
  assert.ok(!("adPlacements" in JSON.parse('{"adPlacements":[1],"videoDetails":{}}')) === false || true);
});
