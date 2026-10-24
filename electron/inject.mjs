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
  // 広告対策。SABR時代の広告は応答からは消せない(サーバー側でストリームに
  // 組み込まれる)ため、「見せない・聞かせない・最短で飛ばす」に徹する:
  //  開始即ミュート → スキップボタンがあれば押す → 2.5秒から尻切りを試みる →
  //  終了でミュート解除。押下直後の遷移中には触らない(本体誤シーク防止)
  var adSeenAt = 0;
  var skipClickedAt = 0;
  var adSeekAt = 0;
  var adMuted = false;
  var adPrevVol = 100;
  var adQuietTicks = 0;
  var skipTick = function () {
    try {
      if (!adVisible()) {
        adSeenAt = 0;
        // 広告明け: 広告中にミュートしていたら2Tick確認して解除
        if (adMuted) {
          adQuietTicks++;
          if (adQuietTicks >= 2) {
            adMuted = false;
            adQuietTicks = 0;
            try { var p2 = p(); if (p2) { if (p2.setVolume) p2.setVolume(adPrevVol); if (p2.unMute) p2.unMute(); } } catch (e) {}
          }
        } else {
          adQuietTicks = 0;
        }
        return;
      }
      adQuietTicks = 0;
      var now = Date.now();
      if (!adSeenAt) {
        adSeenAt = now;
        // 開始即ミュート(音を聞かせない)
        try {
          var p0 = p();
          if (p0) {
            adPrevVol = p0.getVolume ? p0.getVolume() : 100;
            if (p0.setVolume) p0.setVolume(0);
            if (p0.mute) p0.mute();
            adMuted = true;
          }
        } catch (e) {}
      }
      var close = document.querySelector(".ytp-ad-overlay-close-button");
      if (close) { try { close.click(); } catch (e) {} }
      if (now - skipClickedAt < 2500) return;
      var skip = document.querySelector(".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button");
      if (skip) {
        try { skip.click(); } catch (e) {}
        skipClickedAt = now;
        return;
      }
      // スキップボタンの無い広告: 出現2.5秒以降、1秒間隔で尻切りを試みる
      if (now - adSeenAt < 2500 || now - adSeekAt < 1000) return;
      var v = document.querySelector("video.html5-main-video");
      if (v && v.duration && isFinite(v.duration) && v.duration > 2) {
        try { v.currentTime = Math.max(0, v.duration - 0.4); } catch (e) {}
        adSeekAt = now;
      }
    } catch (e) {}
  };  var snap = function () {
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
      else if (name === "loadlist") {
        // ミックス/プレイリスト付きで投入する(loadVideoById はプレイリストを切り
        // 離すため、曲末の自動進行が死ぬ。list を再接続して自然進行を保つ)
        var o = typeof arg === "string" ? JSON.parse(arg) : (arg || {});
        var lst = String(o.list || "");
        if (/^(RD|PL|OL|UL|FL|LL|WL)/.test(lst)) {
          el.loadVideoById({ videoId: String(o.videoId), listType: "playlist", list: lst });
        } else {
          el.loadVideoById(String(o.videoId));
        }
      }
      else if (name === "eq") return ctlEq(arg);
      else if (name === "teardownAudio") { hardTeardown(); window.__mvAudioDisabled = true; return "ok"; }
      else return "unknown";
      return "ok";
    } catch (e) { return "error"; }
  };
  // ── Web Audio(EQ/ビジュアライザー用)──
  // グラフは window.__mvAudio に永続させる。createMediaElementSource は同じ要素に
  // 2回呼べず、再注入でクロージャを作り直すと例外でEQ/解析が死ぬため
  var audio = window.__mvAudio || null;
  var audioEl = null;
  var audioFails = 0; // 連続失敗。デバイスが死んでいるのに無限に挑戦しないためのカウンタ
  // グラフの完全解体。動画要素が遷移で破壊される局面(ハード遷移/プレイヤー再構築)と
  // 解析の読み取りが重なるとレンダラーごと落ちる(音声スレッドの競合→SIGSEGV)ため、
  // 遷移の beforeunload と「要素がDOMから外れた」検知の両面で先に解体する
  function hardTeardown() {
    try {
      if (audio) {
        try { audio.an.disconnect(); } catch (e) {}
        for (var i = audio.bands.length - 1; i >= 0; i--) { try { audio.bands[i].disconnect(); } catch (e) {} }
        try { audio.src.disconnect(); } catch (e) {}
        try { audio.ctx.close(); } catch (e) {}
      }
    } catch (e) {}
    audio = null;
    audioEl = null;
    window.__mvAudio = null;
  }
  window.addEventListener("beforeunload", function () { hardTeardown(); });
  // ページが安定した合図(YouTube自身の遷移完了イベント)を待つゲート。
  // 起動途中のページにグラフを張ると要素upgradeが壊れて骨格ページになるため
  window.__mvPageReady = false;
  try {
    window.addEventListener("yt-navigate-finish", function () { window.__mvPageReady = true; });
  } catch (e) {}
  setTimeout(function () { window.__mvPageReady = true; }, 12000); // 発火しないページ向けの代替
  function ensureAudio() {
    if (window.__mvAudioDisabled) return false;
    var v = null;
    try {
      v = document.querySelector("video.html5-main-video");
    } catch (e) {}
    try {
      if (audio && (!audioEl || !audioEl.isConnected)) hardTeardown(); // 要素交代(遷移)を検知
    } catch (e) {}
    if (audio) return true;
    if (audioFails >= 3) {
      // 音声デバイス/WebAudioレンダラーが壊れている。グラフを作ると要素の音を
      // 壊れた経路に奪われる(無音化)ので、以降は素通しで鳴らして諦める
      window.__mvAudioDisabled = true;
      return false;
    }
    // ポリマー起動中(dom-ready直後)にグラフを作ると YouTube の初期化が壊れ、
    // ホームのフィードが丸ごと描かなくなる。ページが安定し、実際に鳴り始めて
    // から接続する
    try {
      if (!window.__mvPageReady) return false;
      if (!v || v.paused || !(v.currentTime > 0.5)) return false;
    } catch (e) {
      return false;
    }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!v || !AC) return false;
      var ctx = new AC();
      if (ctx.state === "closed" || ctx.state === "interrupted") {
        audioFails++;
        try { ctx.close(); } catch (e) {}
        return false;
      }
      var src = ctx.createMediaElementSource(v);
      var defs = [[60, "lowshelf"], [250, "peaking"], [1000, "peaking"], [3500, "peaking"], [10000, "highshelf"]];
      var bands = [];
      var node = src;
      for (var i = 0; i < defs.length; i++) {
        var f = ctx.createBiquadFilter();
        f.type = defs[i][1];
        f.frequency.value = defs[i][0];
        f.Q.value = 1;
        f.gain.value = 0;
        node.connect(f);
        node = f;
        bands.push(f);
      }
      var an = ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.70; // 躍動感優先(潰れた波形にならないようやや低め)
      node.connect(an);
      an.connect(ctx.destination);
      audio = { ctx: ctx, bands: bands, an: an, buf: new Uint8Array(an.frequencyBinCount) };
      audioEl = v;
      window.__mvAudio = audio; // 診断・probe から参照できるように公開
      window.__mvAudioEl = v;
      // 再構築後もEQを引き継ぐ(遷移でグラフを作り直すとゲインが無効になるため)
      var d = window.__mvEqDesired;
      if (Array.isArray(d)) {
        for (var k = 0; k < bands.length && k < d.length; k++) bands[k].gain.value = Number(d[k]) || 0;
      }
      if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
      audioFails = 0;
      return true;
    } catch (e) {
      audioFails++;
      audio = null;
      audioEl = null;
      window.__mvAudio = null;
      return false;
    }
  }
  function ctlEq(gains) {
    if (!Array.isArray(gains)) return "bad-args";
    // 希望値はグラフが無い間も覚えておく(再生開始でグラフを作った時に自動適用される)
    window.__mvEqDesired = gains.slice();
    if (!ensureAudio() || !audio) return "no-audio";
    try {
      for (var i = 0; i < audio.bands.length; i++) {
        var g = Number(gains[i]) || 0;
        audio.bands[i].gain.value = g;
      }
    } catch (e) {
      if (++audioFails >= 3) { hardTeardown(); window.__mvAudioDisabled = true; }
      return "error";
    }
    return "ok";
  }
  function ctlLevels(n) {
    try {
      if (audio && (!audioEl || !audioEl.isConnected)) { hardTeardown(); return null; }
    } catch (e) {}
    if (!ensureAudio() || !audio) return null;
    n = Math.min(64, Math.max(4, Number(n) || 28));
    try {
      audio.an.getByteFrequencyData(audio.buf);
    } catch (e) {
      // AudioContext が音声デバイス/レンダラーのエラー状態のとき毎周期ここに来る。
      // 3回続いたら解体して諦める(エラーフラッドと要素音の掠め取りを止める)
      if (++audioFails >= 3) { hardTeardown(); window.__mvAudioDisabled = true; }
      return null;
    }
    audioFails = 0;
    var out = [], per = Math.floor(audio.buf.length / n);
    for (var i = 0; i < n; i++) {
      var sum = 0;
      for (var j = 0; j < per; j++) sum += audio.buf[i * per + j];
      var v = Math.round((sum / per) * 100 / 255 * (1 + (i / n) * 0.9));
      out.push(Math.min(100, v));
    }
    return out;
  }
  if (window.__mvCtl) { window.__mvCtl.snap = snap; window.__mvCtl.cmd = cmd; window.__mvCtl.skipTick = skipTick; window.__mvCtl.levels = ctlLevels; return; }
  window.__mvCtl = { snap: snap, cmd: cmd, skipTick: skipTick, levels: ctlLevels };
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
    // 背景判定(hasFocus)も YouTube は自動一時停止に使うため偽装する
    try { document.hasFocus = function () { return true; }; } catch (e) {}
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
