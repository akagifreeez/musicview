// trace-media capture の解析: media カテゴリ(メディアパイプライン)を時系列に並べ、
// プレイヤー単位で「どこまで進んでどこで止まったか」を表示する
"use strict";
const fs = require("node:fs");

const file = process.argv[2];
const root = JSON.parse(fs.readFileSync(file, "utf8"));
const evs = Array.isArray(root) ? root : (root.traceEvents || []);
console.log("events:", evs.length);

let tmin = Infinity, tmax = -Infinity;
for (const e of evs) {
  if (typeof e.ts === "number" && e.ph !== "M") { if (e.ts < tmin) tmin = e.ts; if (e.ts > tmax) tmax = e.ts; }
}
console.log(`span: ${((tmax - tmin) / 1e6).toFixed(1)} s`);

// media イベントの抽出
const media = evs.filter(e => String(e.cat || "").split(",").includes("media") && e.ph !== "M");
console.log("media events:", media.length);

// プレイヤー(this引数)ごとにグループ化
const byPlayer = new Map();
for (const e of media) {
  const key = (e.args && (e.args.this || e.args.player_id)) || "sys";
  if (!byPlayer.has(key)) byPlayer.set(key, []);
  byPlayer.get(key).push(e);
}

console.log("\n== プレイヤーインスタンス ==");
for (const [k, arr] of byPlayer) {
  const t0 = Math.min(...arr.map(e => e.ts)), t1 = Math.max(...arr.map(e => e.ts));
  console.log(` ${String(k).slice(0, 16)}  events=${String(arr.length).padStart(5)}  +${((t0 - tmin) / 1e6).toFixed(1)}s ~ +${((t1 - tmin) / 1e6).toFixed(1)}s`);
}

// 各プレイヤーのイベント時系列(省略しつつ)
for (const [k, arr] of byPlayer) {
  if (arr.length < 3) continue;
  console.log(`\n== player ${String(k).slice(0, 16)} の時系列 ==`);
  const sorted = arr.slice().sort((a, b) => a.ts - b.ts);
  let last = "";
  for (const e of sorted) {
    const line = ` +${(((e.ts - tmin) / 1e6).toFixed(1)).padStart(6)}s ${e.ph} ${e.name.slice(0, 60)} ${e.args ? JSON.stringify(e.args).slice(0, 120) : ""}`;
    if (line === last) continue; // 完全同一行の連発を間引く
    last = line;
    console.log(line);
  }
}

// エラーっぽい文字列を全イベントから拾う
console.log("\n== error/fail を含むイベント ==");
let n = 0;
for (const e of evs) {
  if (n > 25) break;
  const s = `${e.name || ""} ${JSON.stringify(e.args || {}).slice(0, 120)}`;
  if (/error|fail|PIPELINE_ERROR|DECODE|abort/i.test(s) && e.ph !== "M") {
    console.log(` +${((e.ts - tmin) / 1e6).toFixed(1)}s pid=${e.pid} ${e.cat} | ${e.name} ${JSON.stringify(e.args || {}).slice(0, 140)}`);
    n++;
  }
}
