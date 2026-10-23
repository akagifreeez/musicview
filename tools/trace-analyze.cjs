// Trace-*.json.gz(chrome://tracing 形式)の一次解析:
// プロセス/スレッド構成・イベント種別の上位・長時間スライス(1秒超)・
// 音声/エラー系イベントを洗い出して「どこで止まっていたか」を掴む
"use strict";
const zlib = require("node:zlib");
const fs = require("node:fs");

const file = process.argv[2];
if (!file) { console.error("usage: node trace-analyze.cjs <trace.json.gz>"); process.exit(1); }

const raw = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
let root;
try { root = JSON.parse(raw); } catch (e) { console.error("JSON parse failed:", e.message); process.exit(1); }
const evs = Array.isArray(root) ? root : (root.traceEvents || []);
console.log("events:", evs.length);

// メタデータ(バージョン/コマンドライン)
const meta = root && root.metadata ? root.metadata : {};
if (meta["command_line"] || meta.chrome_version || meta["network-type"]) {
  console.log("meta:", JSON.stringify({ ver: meta.chrome_version, cmd: String(meta["command_line"] || "").slice(0, 160), os: meta["os-name"], user_agent: String(meta["user-agent"] || "").slice(0, 80) }));
}

// プロセス/スレッド名の棚卸し
const procs = new Map(); // pid -> name
const threads = new Map(); // "pid:tid" -> name
for (const e of evs) {
  if (e.ph === "M") {
    if (e.name === "process_name" && e.args && e.args.name) procs.set(e.pid, e.args.name);
    if (e.name === "thread_name" && e.args && e.args.name) threads.set(e.pid + ":" + e.tid, e.args.name);
  }
}
console.log("\n== processes ==");
for (const [pid, name] of procs) console.log(` pid=${pid} ${name}`);

// 時間範囲
let tmin = Infinity, tmax = -Infinity;
for (const e of evs) {
  if (typeof e.ts === "number" && e.ph !== "M") { if (e.ts < tmin) tmin = e.ts; if (e.ts > tmax) tmax = e.ts; }
}
const spanMs = (tmax - tmin) / 1000;
console.log(`\ntime span: ${spanMs.toFixed(0)} ms (${(spanMs / 1000).toFixed(1)} s)`);

// イベント名の上位(ph=X/B/E完了系と全般)
const nameCount = new Map();
for (const e of evs) {
  if (e.ph === "M") continue;
  const k = e.cat + " | " + e.name;
  nameCount.set(k, (nameCount.get(k) || 0) + 1);
}
console.log("\n== top event names ==");
[...nameCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
  .forEach(([k, n]) => console.log(` ${String(n).padStart(7)}  ${k}`));

// 長時間スライス(>500ms)を時系列で
const longSlices = evs.filter(e => e.ph === "X" && typeof e.dur === "number" && e.dur > 500)
  .sort((a, b) => a.ts - b.ts);
console.log(`\n== slices > 500ms (${longSlices.length}) ==`);
for (const e of longSlices.slice(0, 60)) {
  const at = ((e.ts - tmin) / 1000).toFixed(0);
  console.log(` +${String(Math.round(at)).padStart(5)}ms pid=${e.pid} th=${e.tid} ${e.dur.toFixed(0)}ms ${e.cat} | ${e.name}`);
}

// 音声・エラー・動画系のイベントを拾う
const patterns = [/audio/i, /WebAudio/i, /error/i, /fail/i, /throttl/i, /freeze/i, /suspend/i, /MediaElement/i, /stall/i, /crash/i];
const hits = new Map();
for (const e of evs) {
  if (e.ph === "M") continue;
  const k = e.cat + " | " + e.name;
  if (patterns.some(p => p.test(e.name) || p.test(e.cat))) hits.set(k, (hits.get(k) || 0) + 1);
}
console.log("\n== audio/error-ish event names ==");
[...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  .forEach(([k, n]) => console.log(` ${String(n).padStart(7)}  ${k}`));

// トレース末尾(保存直前)で何が起きていたか: 最後の2秒の完了スライス
console.log("\n== last 2000us slices (tail activity) ==");
const tail = evs.filter(e => e.ph === "X" && typeof e.ts === "number" && e.ts > tmax - 2000)
  .sort((a, b) => a.ts - b.ts).slice(-40);
for (const e of tail) {
  console.log(` +${((e.ts - tmin) / 1000).toFixed(1)}ms pid=${e.pid} ${e.dur.toFixed(1)}ms ${e.name.slice(0, 80)}`);
}
