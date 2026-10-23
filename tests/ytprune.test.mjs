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

// ── 実機でしか起きなかった「動画クリックで読み込み停止」の回帰テスト ──

class FakeXHR {
  constructor() {
    this.readyState = 0;
    this.responseType = "";
    this._listeners = {};
    this._text = "";
  }
  addEventListener(t, fn) { (this._listeners[t] ??= []).push(fn); }
  _fire(t) { for (const fn of this._listeners[t] ?? []) fn(); }
}
Object.defineProperty(FakeXHR.prototype, "responseText", {
  get() { return this._text; }, configurable: true,
});
Object.defineProperty(FakeXHR.prototype, "response", {
  get() { return this._text; }, configurable: true,
});
FakeXHR.prototype.open = function () { this._url = arguments[1]; };
FakeXHR.prototype.send = function () {};

class FakeResponse {
  constructor(body, init) { this.body = body; this.init = init; }
}

test("yt-preload: 使い回したXHRでも影が残らず新しい応答が読める(クリック停止の回帰)", () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  installHooks({ window: {}, XMLHttpRequest: FakeXHR, Response: FakeResponse });

  const xhr = new FakeXHR();
  xhr.open("POST", "/youtubei/v1/player?key=1");
  xhr.send();
  xhr.readyState = 4;
  xhr._text = JSON.stringify({ adPlacements: [1], videoDetails: { videoId: "first" } });
  xhr._fire("readystatechange");
  const j1 = JSON.parse(xhr.responseText);
  assert.ok(!("adPlacements" in j1), "1回目の応答から広告キーが剥がれる");

  // 同一インスタンスを再利用。open 時点で影が落ちているので新しい応答がそのまま見え、
  // readyState 4 の再判定で剥ぎ直される
  xhr.open("POST", "/youtubei/v1/player?key=2");
  xhr._text = JSON.stringify({ adPlacements: [1], videoDetails: { videoId: "second" } });
  assert.equal(JSON.parse(xhr.responseText).videoDetails.videoId, "second", "open で影が落ちている");
  xhr._fire("readystatechange");
  const j2 = JSON.parse(xhr.responseText);
  assert.ok(!("adPlacements" in j2), "2回目の応答も剥がれる");
  assert.equal(j2.videoDetails.videoId, "second");
});

test("yt-preload: プレイヤー以外のURLはXHRフックの対象外", () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  installHooks({ window: {}, XMLHttpRequest: FakeXHR, Response: FakeResponse });
  const xhr = new FakeXHR();
  xhr.open("GET", "/youtubei/v1/browse");
  xhr.send();
  xhr.readyState = 4;
  xhr._text = JSON.stringify({ adPlacements: [1] });
  xhr._fire("readystatechange");
  assert.ok("adPlacements" in JSON.parse(xhr.responseText), "非対象URLは改変しない");
});

test("yt-preload: ytInitialPlayerResponse の代入罠で剥げる", () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  const win = {};
  installHooks({ window: win, XMLHttpRequest: FakeXHR, Response: FakeResponse });
  win.ytInitialPlayerResponse = { adPlacements: [1], playerAds: [1], videoDetails: { videoId: "x" } };
  assert.ok(!("adPlacements" in win.ytInitialPlayerResponse));
  assert.ok(!("playerAds" in win.ytInitialPlayerResponse));
  assert.equal(win.ytInitialPlayerResponse.videoDetails.videoId, "x");
  assert.ok(win.__mvPrune.inline >= 1);
});

test("yt-preload: fetchの/youtubei/v1/player応答が剥がれて差し替わる(対象外は素通し)", async () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  const playerObj = { adPlacements: [1], videoDetails: { videoId: "x" } };
  let captured = null;
  const fakeRes = {
    status: 200, statusText: "OK",
    headers: { "content-type": "application/json" },
    clone() { return { json: async () => playerObj }; },
  };
  const win = {
    fetch: async () => fakeRes,
  };
  installHooks({ window: win, XMLHttpRequest: FakeXHR, Response: FakeResponse });

  const res1 = await win.fetch("/youtubei/v1/player?key=1");
  assert.ok(res1 instanceof FakeResponse, "player応答は差し替えられたResponse");
  const j = JSON.parse(res1.body);
  assert.ok(!("adPlacements" in j));
  assert.equal(res1.init.status, 200);
  assert.deepEqual(res1.init.headers, { "content-type": "application/json" });

  const res2 = await win.fetch("https://example.com/api");
  assert.equal(res2, fakeRes, "対象外URLは元の応答を素通し");
});

test("yt-preload: Electron由来グローバルの漏れを落とす(process等)", () => {
  const { installHooks } = require("../electron/yt-preload.cjs");
  const win = { process: { versions: {} }, Buffer: function () {}, setImmediate: function () {} };
  installHooks({ window: win, XMLHttpRequest: FakeXHR, Response: FakeResponse });
  assert.equal(win.process, undefined);
  assert.equal(win.Buffer, undefined);
  assert.equal(win.setImmediate, undefined);
});
