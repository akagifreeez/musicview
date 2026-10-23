// プレイヤー/ページ動作に必須のURLが広告フィルタで誤ブロックされていないかの一括テスト
"use strict";
const { AdblockEngine } = require("../electron/adblock.cjs");
const fs = require("node:fs");

const eng = new AdblockEngine();
const prefix = [
  "@@||www.youtube.com/api/stats/$~third-party",
  "@@||www.youtube.com/ptracking/$~third-party",
  "@@||www.youtube.com/youtubei/$~third-party",
].join("\n");
eng.loadFromText(prefix + "\n" + fs.readFileSync("data/filters/combined.txt", "utf8"));
console.log("rules:", eng.ruleCount);

const list = [
  ["base.js(プレイヤー本体)", "https://www.youtube.com/s/player/cbcfbf2f/player_es6.vflset/ja_JP/base.js", "script"],
  ["annotations_module", "https://www.youtube.com/s/player/cbcfbf2f/player_es6.vflset/ja_JP/annotations_module.js", "script"],
  ["embed.js", "https://www.youtube.com/s/player/cbcfbf2f/player_ias.vflset/ja_JP/embed.js", "script"],
  ["www-player.css", "https://www.youtube.com/s/player/cbcfbf2f/www-player.css", "stylesheet"],
  ["youtubei/next", "https://www.youtube.com/youtubei/v1/next?key=x", "xmlhttprequest"],
  ["youtubei/player", "https://www.youtube.com/youtubei/v1/player?key=x", "xmlhttprequest"],
  ["youtubei/browse", "https://www.youtube.com/youtubei/v1/browse", "xmlhttprequest"],
  ["youtubei/log_event", "https://www.youtube.com/youtubei/v1/log_event", "xmlhttprequest"],
  ["generate_204", "https://rr5---sn-oguesndr.googlevideo.com/generate_204", "ping"],
  ["timedtext(字幕)", "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=ja", "xmlhttprequest"],
  ["screenshot(サムネ)", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "image"],
  ["補助スクリプトspf", "https://www.youtube.com/yts/jsbin/spf.vflset/spf.js", "script"],
  ["desktop polyfill", "https://www.youtube.com/yts/jsbin/polymer-nodejs.vflset/polymer-nodejs.js", "script"],
];
for (const [label, u, type] of list) {
  let r;
  try { r = eng.shouldBlock(u, "www.youtube.com", type); } catch (e) { r = "ERR:" + e.message; }
  console.log((r === true ? "BLOCK" : r === false ? "pass " : String(r).slice(0, 5)) + "  " + label);
}
