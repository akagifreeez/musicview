// Round 3: v8.cpu_profiler の ProfileChunk からCPUプロファイルを復元し、
// どのJS関数がメインスレッドを消費したかを自己時間順に表示する
"use strict";
const zlib = require("node:zlib");
const fs = require("node:fs");

const file = process.argv[2];
const raw = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
const root = JSON.parse(raw);
const evs = Array.isArray(root) ? root : (root.traceEvents || []);

const nodes = new Map(); // id -> {fn, url, line}
const selfUs = new Map(); // id -> self time us
let t0 = null, acc = 0;
let totalSamples = 0;

for (const e of evs) {
  if (e.name !== "ProfileChunk" || !e.args || !e.args.data) continue;
  const d = e.args.data;
  const cp = d.cpuProfile || {};
  if (Array.isArray(cp.nodes)) {
    for (const nd of cp.nodes) {
      const cf = nd.callFrame || {};
      nodes.set(nd.id, {
        fn: cf.functionName || "(anonymous)",
        url: String(cf.url || "").replace(/^.*\//, "").slice(0, 60),
        line: cf.lineNumber,
        parent: nd.parent,
      });
    }
  }
  if (Array.isArray(cp.samples) && Array.isArray(d.timeDeltas)) {
    const smp = cp.samples, dl = d.timeDeltas;
    for (let i = 0; i < smp.length; i++) {
      const id = smp[i];
      const dt = typeof dl[i] === "number" ? dl[i] : 0;
      selfUs.set(id, (selfUs.get(id) || 0) + Math.max(0, dt));
      acc += Math.max(0, dt);
      totalSamples++;
    }
    if (t0 === null && typeof d.startTime === "number") t0 = d.startTime;
  }
}

console.log(`samples: ${totalSamples}, profiled time: ${(acc / 1000).toFixed(0)} ms`);
if (!t0) t0 = 0;

// 自己時間トップ30
const rows = [...selfUs.entries()].map(([id, us]) => {
  const n = nodes.get(id) || { fn: "?" + id, url: "", line: -1 };
  return { us, fn: n.fn, url: n.url, line: n.line };
}).sort((a, b) => b.us - a.us);
console.log("\n== 自己時間トップ30 ==");
for (const r of rows.slice(0, 30)) {
  console.log(` ${(r.us / 1000).toFixed(0).padStart(6)}ms ${(100 * r.us / acc).toFixed(1).padStart(5)}%  ${r.fn.slice(0, 60)}  (${r.url}:${r.line})`);
}

// 拡張は v8 内部フレーム(self time が付かない)なので URL の読み方:
// our files: app.js / main.mjs 系, youtube: player_es6 / www-yt 系
const groups = new Map();
for (const r of rows) {
  let g = "other";
  if (/app\.js|musicview/.test(r.url)) g = "app(musicview)";
  else if (/youtube\.com|ytimg/.test(r.url) || r.url === "") g = "youtube";
  else if (/injected|bootstrap|preload/.test(r.url)) g = "injected";
  else if (/^v8:|^$/i.test(r.fn) || /\(garbage/.test(r.fn)) g = "v8-internal";
  groups.set(g, (groups.get(g) || 0) + r.us);
}
console.log("\n== グループ計 ==");
for (const [g, us] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(` ${(us / 1000).toFixed(0).padStart(6)}ms ${(100 * us / acc).toFixed(1).padStart(5)}%  ${g}`);
}

// 親チェーンで「誰が呼んだか」の上位: 自身が youtube/app のノードの親を集計
const parents = new Map();
for (const [id, us] of selfUs) {
  const n = nodes.get(id);
  if (!n || !n.parent) continue;
  const p = nodes.get(n.parent);
  if (!p) continue;
  const k = `${p.fn.slice(0, 50)} (${p.url.replace(/^.*\//, "")}:${p.line})`;
  parents.set(k, (parents.get(k) || 0) + us);
}
console.log("\n== 呼び出し親の上位15 ==");
for (const [k, us] of [...parents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(` ${(us / 1000).toFixed(0).padStart(6)}ms ${(100 * us / acc).toFixed(1).padStart(5)}%  ${k}`);
}
