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
