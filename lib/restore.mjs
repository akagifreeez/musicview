// セッション復元データの作成と検証。data/session.json に書く実体の形をここで固定する

import { withTime } from "./urlutil.mjs";

export function makeSnapshot({ url, time, vol, rate, mode, xfade }) {
  if (typeof url !== "string" || !url.includes("watch?v=")) return null;
  return {
    url: withTime(url, time),
    vol: clamp(numOr(vol, 100), 0, 100),
    rate: clamp(numOr(rate, 1), 0.25, 2),
    mode: mode === "site" ? "site" : "music",
    xfade: clamp(numOr(xfade, 0), 0, 15),
    savedAt: Date.now(),
  };
}

// 読み込んだ JSON の検証。壊れていたら null(無いものとして続行)
export function validateSnapshot(data) {
  if (!data || typeof data !== "object") return null;
  if (typeof data.url !== "string" || !/^https:\/\/(www\.)?youtube\.com\//.test(data.url)) return null;
  return {
    url: data.url,
    vol: clamp(numOr(data.vol, 100), 0, 100),
    rate: clamp(numOr(data.rate, 1), 0.25, 2),
    mode: data.mode === "site" ? "site" : "music",
    xfade: clamp(numOr(data.xfade, 0), 0, 15),
    savedAt: Number(data.savedAt) || 0,
  };
}

// Number(v) が有限数でなければ既定値(Number(undefined) は NaN になるので ?? では防げない)
function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
