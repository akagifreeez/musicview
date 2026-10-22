// サイト側(youtube.com の WebContentsView)へ executeJavaScript で差し込むソース集。
// 文字列として Electron 本体から注入するため、内部ではテンプレートリテラルを使わない

// 状態取得・演奏操作・広告スキップの常駐スクリプト(冪等、何度差しても1つしか積まれない)
export const SITE_BOOTSTRAP = `
(() => {
  var p = function () { return document.getElementById("movie_player"); };
  var adVisible = function () {
    var el = p();
    return !!(el && el.classList && el.classList.contains("ad-showing"));
  };
  var skipTick = function () {
    try {
      if (!adVisible()) return;
      var v = document.querySelector("video.html5-main-video");
      if (v && v.duration && isFinite(v.duration)) {
        try { v.currentTime = Math.max(0, v.duration - 0.4); } catch (e) {}
      }
      var skip = document.querySelector(".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button");
      if (skip) skip.click();
      var close = document.querySelector(".ytp-ad-overlay-close-button");
      if (close) close.click();
    } catch (e) {}
  };
  var snap = function () {
    var el = p();
    if (!el || typeof el.getDuration !== "function") return null;
    var queue = null, qIdx = -1, vd = null;
    try { queue = el.getPlaylist(); qIdx = el.getPlaylistIndex(); } catch (e) {}
    try { vd = el.getVideoData(); } catch (e) {}
    if (!vd || !vd.video_id) return null;
    var state = -1;
    if (el.getPlayerState) {
      state = el.getPlayerState();
    } else {
      // getPlayerState が無い環境では video 要素の paused から拾う
      var vv = document.querySelector("video.html5-main-video");
      if (vv) state = vv.paused ? 2 : 1;
    }
    return {
      state: state,
      time: el.getCurrentTime ? el.getCurrentTime() : 0,
      dur: el.getDuration ? el.getDuration() : 0,
      title: vd.title || "",
      author: vd.author || "",
      videoId: vd.video_id,
      queue: Array.isArray(queue) ? queue : null,
      qIdx: typeof qIdx === "number" ? qIdx : -1,
      muted: el.isMuted ? !!el.isMuted() : false,
      vol: el.getVolume ? el.getVolume() : 100,
      rate: el.getPlaybackRate ? el.getPlaybackRate() : 1,
      ad: adVisible()
    };
  };
  var cmd = function (name, arg) {
    var el = p();
    if (!el) return "no-player";
    try {
      if (name === "play") el.playVideo();
      else if (name === "pause") el.pauseVideo();
      else if (name === "seek") el.seekTo(Number(arg) || 0, true);
      else if (name === "vol") el.setVolume(Number(arg) || 0);
      else if (name === "mute") el.mute();
      else if (name === "unmute") el.unMute();
      else if (name === "rate") el.setPlaybackRate(Number(arg) || 1);
      else if (name === "next") el.nextVideo();
      else if (name === "prev") el.previousVideo();
      else if (name === "playAt") el.playVideoAt(Number(arg) || 0);
      else if (name === "load") el.loadVideoById(String(arg));
      else return "unknown";
      return "ok";
    } catch (e) { return "error"; }
  };
  if (window.__mvCtl) { window.__mvCtl.snap = snap; window.__mvCtl.cmd = cmd; window.__mvCtl.skipTick = skipTick; return; }
  window.__mvCtl = { snap: snap, cmd: cmd, skipTick: skipTick };
  setInterval(function () { window.__mvCtl.skipTick(); }, 400);
})();
`;

// 非表示 WebContents で YouTube の自動再生判断が「ページ非表示」に引っかからないよう、
// 可視性 API を偽装する。音楽モード(サイト非表示)で鳴らし続けるための前提
export const VISIBILITY_PATCH = `
(() => {
  try {
    Object.defineProperty(document, "hidden", { get: function () { return false; }, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: function () { return "visible"; }, configurable: true });
    Object.defineProperty(document, "webkitHidden", { get: function () { return false; }, configurable: true });
    Object.defineProperty(document, "webkitVisibilityState", { get: function () { return "visible"; }, configurable: true });
  } catch (e) {}
})();
`;

// 曲一覧の生データ取得(視聴ページのおすすめ・検索結果の両方で使う)。
// ytInitialData は頻繁に構造が変わるためパスを決め打ちせず、幅優先で
// compactVideoRenderer / lockupViewModel / videoRenderer ノードを集める。
// DOM 側もクラス名に依存せず watch?v= アンカーから拾う(_JSON 解析が空のときの保険)
export const EXTRACT_ITEMS = `
(() => {
  var out = { json: [], queue: [], dom: [], generic: [] };
  try {
    var queue2 = [window.ytInitialData];
    var seen = 0;
    while (queue2.length && seen < 4000) {
      var n = queue2.shift();
      seen++;
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n)) {
        for (var i = 0; i < n.length && i < 300; i++) queue2.push(n[i]);
        continue;
      }
      if (n.playlistPanelVideoRenderer) {
        // ミックス/プレイリストのキュー本体。順序が重要なので別口で保持する
        out.queue.push(n.playlistPanelVideoRenderer);
        continue;
      }
      var hit = n.compactVideoRenderer || n.lockupViewModel || n.videoRenderer;
      // ラッパーごと push する(メイン側 parseRecResults が it.compactVideoRenderer 等で辿る)
      if (hit) { out.json.push(n); continue; }
      // 既知ラッパー外で videoId を直接持つノードは汎用バケットへ(改修に強い救出用)
      if (typeof n.videoId === "string" && /^[a-zA-Z0-9_-]{11}$/.test(n.videoId)) {
        if (out.generic.length < 80) out.generic.push(n);
        continue;
      }
      var ks = Object.keys(n);
      for (var j = 0; j < ks.length; j++) {
        var v = n[ks[j]];
        if (v && typeof v === "object") queue2.push(v);
      }
    }
  } catch (e) {}
  try {
    var map = {};
    var anchors = document.querySelectorAll('a[href*="/watch?v="]');
    for (var k = 0; k < anchors.length; k++) {
      var a = anchors[k];
      var m = (a.getAttribute("href") || "").match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (!m || map[m[1]]) continue;
      var title = a.getAttribute("title") || a.getAttribute("aria-label") || (a.textContent || "").trim();
      if (!title) continue;
      map[m[1]] = { id: m[1], title: title.trim().slice(0, 200), author: "", lenText: "" };
    }
    out.dom = Object.keys(map).map(function (id) { return map[id]; }).slice(0, 40);
  } catch (e) {}
  return out;
})();
`;

// サイト上の広告・宣伝バナーの隠し(描画だけの対処。取得そのものは webRequest 側で止める)
export const AD_HIDE_CSS = `
.ytp-ad-overlay-container, .ytp-ad-text-overlay, .ytp-ad-player-overlay-layout,
.ytd-mealbar-promo-renderer, ytd-action-companion-ad-renderer,
ytd-in-feed-ad-layout-renderer, ytd-ads-engagement-panel-content-renderer,
ytd-promoted-sparkles-web-renderer, ytd-banner-promo-renderer,
ytd-statement-banner-renderer, #masthead-ad, ytd-companion-slot-renderer,
.ytd-merch-shelf-renderer, ytd-merch-shelf-renderer {
  display: none !important;
}
`;
