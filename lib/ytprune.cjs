"use strict";
// プレイヤーレスポンスから広告関連オブジェクトを剥ぐ(prune)。
// YouTube のプレイヤーは adPlacements/playerAds/adSlots がレスポンスに無いと
// 広告をスケジュールしないため、ネットワーク遮断より確実に「広告が鳴らない状態」
// を作れる。キーは uBlock Origin の json-prune 系フィルタと同じ最小限の先行実績に
// 絞る(未知のキーの深掘り削除は本体データを壊すリスクがあるのでしない)。
const PRUNE_KEYS = ["adPlacements", "playerAds", "adSlots", "adBreakHeartbeatParams"];

// 剥ぎ取ったキー数を返す(壊れ系入力は 0)
function prunePlayerResponse(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return 0;
  let removed = 0;
  for (let i = 0; i < PRUNE_KEYS.length; i++) {
    const key = PRUNE_KEYS[i];
    if (key in obj) {
      delete obj[key];
      removed++;
    }
  }
  return removed;
}

module.exports = { PRUNE_KEYS, prunePlayerResponse };
