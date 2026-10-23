// Round 2: 5秒バケットの活動密度(上が死んでいる時間帯を特定)+ メディア系イベント
"use strict";
const zlib = require("node:zlib");
const fs = require("node:fs");

const file = process.argv[2];
const raw = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
const root = JSON.parse(raw);
const evs = Array.isArray(root) ? root : (root.traceEvents || []);

let tmin = Infinity, tmax = -Infinity;
for (const e of evs) {
  if (typeof e.ts === "number" && e.ph !== "M") { if (e.ts < tmin) tmin = e.ts; if (e.ts > tmax) tmax = e.ts; }
}
const bucket = 5000000; // 5秒(us)
const span = Math.ceil((tmax - tmin) / bucket);
const mk = () => new Array(span + 1).fill(0);
const frames = mk(), gc = mk(), media = mk(), net = mk(), task = mk(), funcall = mk();
const mediaEvents = [];
const netNames = new Map();

for (const e of evs) {
  if (e.ph === "M" || typeof e.ts !== "number") continue;
  const b = Math.max(0, Math.min(span, Math.floor((e.ts - tmin) / bucket)));
  const n = e.name || "";
  if (e.name === "AnimationFrame" || e.name === "AnimationFrame::Render") frames[b]++;
  if (n.indexOf("GC") !== -1 || e.cat.indexOf("v8.gc") !== -1) gc[b]++;
  if (e.cat.indexOf("media") !== -1 || /^(Video|Audio|Media|Player)/.test(n) || /pipeline|buffering|Pipeline/i.test(n)) {
    media[b]++;
    if (mediaEvents.length < 200) mediaEvents.push({ ts: ((e.ts - tmin) / 1000).toFixed(0), pid: e.pid, name: n, args: e.args ? JSON.stringify(e.args).slice(0, 140) : "" });
  }
  if (n === "ResourceSendRequest" || n === "ResourceReceiveResponse" || n === "ResourceFinish") {
    net[b]++;
    if (n === "ResourceSendRequest") {
      const u = e.args && e.args.data && e.args.data.url ? String(e.args.data.url) : "";
      netNames.set(u.replace(/\?.*$/, ""), (netNames.get(u.replace(/\?.*$/, "")) || 0) + 1);
    }
  }
  if (n === "RunTask") task[b]++;
  if (n === "FunctionCall") funcall[b]++;
}

console.log("== 5秒バケット(アニメフレーム/関数実行/タスク/GC/ネット) ==");
console.log(" sec   anim func task   gc  net");
for (let b = 0; b <= span; b += 2) {
  const sec = Math.round((b * bucket) / 1000);
  const bar = "#".repeat(Math.min(50, Math.round(frames[b] / 8)));
  console.log(` ${String(sec).padStart(4)}s ${String(frames[b]).padStart(4)} ${String(funcall[b]).padStart(4)} ${String(task[b]).padStart(4)} ${String(gc[b]).padStart(4)} ${String(net[b]).padStart(4)}  ${bar}`);
}

console.log("\n== media系イベント(上位) ==");
for (const m of mediaEvents.slice(0, 60)) console.log(` +${m.ts}ms pid=${m.pid} ${m.name} ${m.args}`);

console.log("\n== リクエスト先トップ20 ==");
[...netNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([u, n]) => console.log(` ${String(n).padStart(5)}  ${u.slice(0, 110)}`));
