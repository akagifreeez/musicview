import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { AdblockEngine, FILTER_ALLOW_PREFIX } = require("../electron/adblock.cjs");

// 実リストと同じ構文のミニフィクスチャでエンジンの挙動を検証する
const SAMPLE = `
! Version: test
||doubleclick.net^
||googlesyndication.com^$script
||example-ads.com/banner/$image,third-party
/pagead/ads
@@||doubleclick.net^$domain=trusted.example
||googlevideo.com/videoplayback^$domain=~youtube.com
`;

function engine() {
  const e = new AdblockEngine();
  e.loadFromText(SAMPLE);
  return e;
}

test("広告ドメインをブロックする", () => {
  const e = engine();
  assert.equal(e.shouldBlock("https://securepubads.g.doubleclick.net/tag/js/gpt.js", "youtube.com", "script"), true);
  assert.equal(e.shouldBlock("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "youtube.com", "script"), true);
  assert.equal(e.shouldBlock("https://www.youtube.com/pagead/ads?x=1", "www.youtube.com", "xhr"), true);
});

test("リソース種別・third-party 条件付きルール", () => {
  const e = engine();
  // $image,third-party: image かつ参照元が異なるドメインならブロック
  assert.equal(e.shouldBlock("https://www.example-ads.com/banner/x.png", "youtube.com", "image"), true);
  assert.equal(e.shouldBlock("https://www.example-ads.com/banner/x.png", "youtube.com", "script"), false);
  assert.equal(e.shouldBlock("https://www.example-ads.com/banner/x.png", "example-ads.com", "image"), false); // 1st party
});

test("domain= は参照元ページ側のドメインで判定する", () => {
  const e = engine();
  // youtube.com 配下のページからの videoplayback は domain=~youtube.com で保護される
  assert.equal(e.shouldBlock(
    "https://rr5---sn-xxxx.googlevideo.com/videoplayback?expire=123&id=o-abc&ctier=L",
    "www.youtube.com", "media"), false);
  // 参照元が youtube 以外なら同じ URL でもブロック対象
  assert.equal(e.shouldBlock(
    "https://rr5---sn-xxxx.googlevideo.com/videoplayback?expire=123&id=o-abc",
    "leech-site.example", "media"), true);
});

test("例外ルール(@@)がドメイン条件で効く", () => {
  const e = engine();
  assert.equal(e.shouldBlock("https://securepubads.g.doubleclick.net/x", "trusted.example", "script"), false);
  assert.equal(e.shouldBlock("https://securepubads.g.doubleclick.net/x", "youtube.com", "script"), true);
});

test("エンジン負荷の種: 大量ロードでも壊れない", () => {
  const e = new AdblockEngine();
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(`||ad-domain-${i}.example^`);
  lines.push("||real-hit.example^");
  assert.equal(e.loadFromText(lines.join("\n")), 5001);
  assert.equal(e.shouldBlock("https://sub.real-hit.example/path", "site.example", "script"), true);
  assert.equal(e.shouldBlock("https://ad-domain-4999.example/x", "site.example", "script"), true);
  assert.equal(e.shouldBlock("https://innocent.example/x", "site.example", "script"), false);
});

test("YouTube 自社の計測(api/stats・ptracking・youtubei)は例外が勝つ", () => {
  // EasyList 実在ルールと同形のブロック側 + 本体と同じ例外プリフィクス。
  // ptracking の実URLは「/ptracking?…」(スラッシュを挟まない)。かつて例外を
  // 「ptracking/」と書いてマッチせず、計測がブロックされてミックスが育たなくなった
  const e = new AdblockEngine();
  e.loadFromText(
    FILTER_ALLOW_PREFIX + "\n" +
    "||youtube.com/ptracking?$domain=youtube.com\n" +
    "||youtube.com/ptracking?$third-party\n" +
    "/api/stats/$domain=youtube.com\n"
  );
  assert.equal(e.shouldBlock("https://www.youtube.com/ptracking?html5=1&video_id=x&cpn=y", "www.youtube.com", "xhr"), false);
  assert.equal(e.shouldBlock("https://www.youtube.com/api/stats/watchtime?ver=2&v=x", "www.youtube.com", "xhr"), false);
  assert.equal(e.shouldBlock("https://www.youtube.com/youtubei/v1/player?key=x", "www.youtube.com", "xhr"), false);
  // 他サイトのページからの同じパスは計測例外の対象外(~third-party)
  assert.equal(e.shouldBlock("https://www.youtube.com/ptracking?html5=1", "leech.example", "xhr"), true);
});

test("コメント・element hiding 行は無視される", () => {
  const e = new AdblockEngine();
  const n = e.loadFromText("!! broken\n[yt-dlp]\n###hide-me\n||hit.example^\n");
  assert.equal(n, 1);
});

test("同一エンジンへの再ロードで上限判定が前回分を引き継がない", () => {
  // 定期リフレッシュ(6時間ごとの鮮度チェック)で同じエンジンに再ロードされる。
  // かつて前回の ruleCount が残って上限到達と誤判定され、8万件超が3分の1に刈られた
  const e = new AdblockEngine();
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(`||ad-domain-${i}.example^`);
  const first = e.loadFromText(lines.join("\n"));
  const second = e.loadFromText(lines.join("\n"));
  assert.equal(second, first);
  assert.equal(e.shouldBlock("https://ad-domain-4999.example/x", "site.example", "script"), true);
  assert.equal(e.shouldBlock("https://ad-domain-0.example/x", "site.example", "script"), true);
});

test("参照元不明の要求では third-party 条件付きブロックを見送る(誤ブロック回避)", () => {
  const e = new AdblockEngine();
  e.loadFromText("||tpads.example^$third-party\n@@||allowads.example^$third-party\n||blockads.example^\n");
  // 参照元(referrer)が取れない要求: 第三者判定が不明なので誤ブロック方向には動かない
  assert.equal(e.shouldBlock("https://tpads.example/x", null, "script"), false);
  // 参照元が分かれば通常どおり判定される
  assert.equal(e.shouldBlock("https://tpads.example/x", "other.example", "script"), true);
  assert.equal(e.shouldBlock("https://tpads.example/x", "tpads.example", "script"), false);
  // third-party 条件の無いルールは参照元不明でも効く
  assert.equal(e.shouldBlock("https://blockads.example/x", null, "script"), true);
});
