// 実走確認装置(probe)群。本体の状態には ctx を通じてだけ触れる(本体ロジックとの
// 依存を 1 か所に絞る)。main.mjs は makeProbes に ctx を渡して各 probe を起動するだけ。
// 判定済みの知見は本体内コメントに残してあるため、ここでは装置としての観測点のみを記す
import fs from "node:fs/promises";
import path from "node:path";
import { app, session } from "electron";
import { mixUrl, watchUrl, searchUrl, thumbUrl } from "../lib/urlutil.mjs";
import { clampGains } from "../lib/eq.mjs";
import { EXTRACT_ITEMS } from "./inject.mjs";
import { DiscordPresence } from "./discord.mjs";

export function makeProbes(ctx) {
  const {
    DATA_DIR, PARTITION, TOPBAR_H,
    ensureSite, ensureBrowse, setMode,
    pollOnce, execCmd, execSite, execOn, applyAudioTo,
    extractRecs, extractSearchResults,
  } = ctx;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── probe(実走確認)────────────────────────────
// capturePage は劣化フェーズのマシンで UnknownVizError を時々投げる(v0.2.4 確認済み)。
// スクショ失敗で検証全体が死ぬのは本末転倒なので、1 回だけ待って取り直し、
// それでもだめなら警告を残して続行する
async function probeShot(wc, file) {
  for (let i = 0; i < 2; i++) {
    try {
      if (i > 0) await sleep(1200);
      const img = await wc.capturePage();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, img.toPNG());
      console.log("probe: shot saved", file);
      return;
    } catch (e) {
      console.log("probe: shot retry", i, String(e?.message || e).slice(0, 80));
    }
  }
}


async function runProbe() {
  const log = (...a) => console.log("probe:", ...a);
  const TEST_VID = "dQw4w9WgXcQ";
  await sleep(1500);
  ensureSite();
  log("loading mix (hidden)", mixUrl(TEST_VID));
  ctx.site.webContents.loadURL(mixUrl(TEST_VID));

  // 可視性スプーフ+再生キックで非表示のまま流れ始めるかを観察
  let snap = null;
  for (let i = 0; i < 12; i++) {
    await sleep(3000);
    snap = await pollOnce();
    const p = snap?.snap;
    const diag = await execSite(`JSON.stringify({
      href: location.href.slice(0, 100),
      vis: document.visibilityState,
      hasCtl: !!window.__mvCtl,
      player: !!document.getElementById("movie_player"),
      adShowing: !!document.querySelector(".ad-showing"),
      methods: (function () {
        var p = document.getElementById("movie_player");
        if (!p) return null;
        return ["getPlaylist", "getPlaylistIndex", "nextVideo", "previousVideo", "playVideoAt"].map(function (m) { return m + ":" + typeof p[m]; }).join(" ");
      })(),
      video: (function () {
        var v = document.querySelector("video.html5-main-video");
        return v ? { paused: v.paused, t: Math.round(v.currentTime), dur: Math.round(v.duration || 0) } : null;
      })()
    })`).catch(e => "diag-err:" + String(e).slice(0, 80));
    let ext = null;
    try {
      // EXTRACT_ITEMS は末尾にセミコロン付きの IIFE なので、そのまま代入式に埋め込む
      ext = await execSite(`(function () {
        try {
          var r = ${EXTRACT_ITEMS}
          return JSON.stringify({ json: r.json.length, dom: r.dom.length, sample: r.dom[0] || r.json[0] || null, yid: typeof window.ytInitialData });
        } catch (e) { return "ERR:" + e.message; }
      })()`);
    } catch (e) { ext = "ext-err:" + String(e).slice(0, 80); }
    log(`t=${(i + 1) * 3}s`, diag, "extract:", JSON.stringify(ext),
      "videoId:", p?.videoId, "state:", p?.state,
      "queue:", p?.queue?.length ?? null,
      "title:", JSON.stringify(String(p?.title ?? "").slice(0, 40)));
    if (snap?.ok && p?.state === 1 && p?.dur > 0) break;
  }

  // 非表示のまま音が続くか(音楽モードの根幹)
  if (snap?.ok && snap?.snap?.state === 1) {
    const t1 = snap.snap.time;
    await sleep(6000);
    const s2 = await pollOnce();
    log("hidden-playback", "t1:", Math.round(t1), "t2:", Math.round(s2?.snap?.time ?? -1),
      s2?.snap?.time > t1 ? "ADVANCED-OK" : "STALLED");
    const late = await pollOnce();
    log("late queue:", late?.snap?.queue?.length ?? null, "estimated:", late?.queueEstimated,
      "qIdx:", late?.snap?.qIdx);
    log("late queue titles:", (late?.queueItems ?? []).slice(0, 4).map(i => JSON.stringify(i.title ?? null)).join(" "));
  }

  // データ層の広告剥ぎ(yt-preload)が動いているか。キーが存在した応答だけ加算されるので
  // 広告なし動画だけだと 0 のままでも正常
  try {
    const pr = await ctx.site.webContents.executeJavaScript(
      `JSON.stringify(window.__mvPrune ?? null)`,
    );
    log("yt-prune stats:", pr);
  } catch (e) { log("yt-prune stats: err", e.message); }

  // 前/次ボタン。次で進んで履歴が積まれ、前で戻る往復を確認する
  // (プレイヤーAPIの nextVideo/previousVideo は実走で無反応のため loadVideoById 経路)
  try {
    const s0 = await pollOnce();
    const r1 = await ctx.win.webContents.executeJavaScript("window.musicview.next()");
    await sleep(3000);
    const s1 = await pollOnce();
    const r2 = await ctx.win.webContents.executeJavaScript("window.musicview.prev()");
    await sleep(3000);
    const s2 = await pollOnce();
    log("prev-next:", s0?.snap?.videoId, "-> next", JSON.stringify(r1), "->", s1?.snap?.videoId,
      "-> prev", JSON.stringify(r2), "->", s2?.snap?.videoId,
      (s1?.snap?.videoId !== s0?.snap?.videoId && s2?.snap?.videoId === s0?.snap?.videoId) ? "ROUNDTRIP-OK" : "CHECK");
  } catch (e) { log("prev-next err:", e.message); }

  // キュー操作(アプリ側オーバーライド)のE2E: 次に再生・削除・並べ替えの反映と履歴。
  // メイン側の関数を直接叩く(DnD は DOM 操作なので、ここでは順序反映を検証する)。
  // mix のキューが接続されているこの時点で走す(後半は単発再生になりキューが消える)
  try {
    const base = await pollOnce();
    const items = base?.queueItems ?? [];
    if (items.length >= 3 && base?.snap?.videoId) {
      const ids = items.map(it => it.id);
      const cur = base.snap.videoId;
      // 1) 次に再生: 末尾の曲が現在曲の直後に割り込む
      const moved = ids[ids.length - 1];
      const r1 = await ctx.queuePlayNext(moved);
      const o1 = ((await pollOnce())?.queueItems ?? []).map(it => it.id);
      const ci1 = o1.indexOf(cur);
      const okNext = r1 && o1[ci1 + 1] === moved;
      // 2) 削除: 割り込ませた曲を消す
      const r2 = await ctx.queueRemove(moved);
      const o2 = ((await pollOnce())?.queueItems ?? []).map(it => it.id);
      const okRemove = r2 && !o2.includes(moved);
      // 3) 並べ替え: 先頭2つを入れ替えた順序を送り、表示がそれに従う
      const swapped = o2.slice();
      [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
      const r3 = await ctx.queueReorder(swapped);
      const o3 = ((await pollOnce())?.queueItems ?? []).map(it => it.id);
      const okReorder = r3 && o3[0] === swapped[0] && o3[1] === swapped[1];
      // 4) 履歴: 別の曲へ飛んで(playHistory は poll の videoId 変化で積まれる)、
      //    新しい順の historyItems を確認する
      const pre = base.snap.videoId;
      await execCmd("load", swapped[0] !== pre ? swapped[0] : swapped[1]);
      await sleep(3500);
      const histSnap = await pollOnce();
      const hist = (histSnap?.historyItems ?? []).length;
      const histOk = hist > 0 && histSnap.historyItems[0].id === pre;
      // 5) 並べ替え前の順序に戻す(テストがキューを壊さないように)
      await ctx.queueReorder(o2);
      log("queue-ops:", okNext && okRemove && okReorder ? "OVERRIDE-OK" : `CHECK next=${okNext} remove=${okRemove} reorder=${okReorder}`,
        "history:", hist, histOk ? "(newest-first-OK)" : "(CHECK)");
    } else {
      log("queue-ops: skip (キューが短い)");
    }
  } catch (e) { log("queue-ops err:", e.message); }

  // fetch ラッパが詰まらないこと(サイト画面で動画クリック時に読み込みが止まる回帰)。
  // 実エンドポイントへの POST は YouTube 側の判断で 400 系になるが、約束が解決して
  // 応答オブジェクトを受け取れればパイプは健全
  try {
    const fp = await Promise.race([
      ctx.site.webContents.executeJavaScript(`(async function () {
        try {
          // キー無しで叩く(YouTube が 400 を返してもパイプの健全性確認としては十分)。
          // Innertube の公開ウェブキーをソースに書くと GitHub のシークレットスキャンに
          // 引っかかるため定数は持ち込まない
          const r = await fetch("/youtubei/v1/player", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.1" } } }) });
          return "status:" + r.status;
        } catch (e) { return "fetch-err:" + String(e && e.message).slice(0, 60); }
      })()`),
      new Promise(r => setTimeout(() => r("STUCK-8s"), 8000)),
    ]);
    log("fetch-pipe:", fp);
  } catch (e) { log("fetch-pipe: err", e.message); }

  const recs = await extractRecs();
  log("watch recs:", recs.length, "first:", JSON.stringify(recs[0] ?? null));

  const searchQ = "ヨルシカ";
  ensureBrowse();
  ctx.browse.webContents.loadURL(searchUrl(searchQ));
  const sr = await extractSearchResults(searchQ);
  log("search results:", sr.length, "first:", JSON.stringify(sr[0] ?? null));
  // 検索中も再生が止まらないこと(別ビュー構成の根幹)を確認する
  const durSearch = await pollOnce();
  log("playback during search:", durSearch?.snap?.state, "time:", Math.round(durSearch?.snap?.time ?? -1));
  await sleep(1000);
  // 隠しビューは capturePage が空になるため、probe の間だけ可視化して撮る
  {
    const [w, h] = ctx.win.getContentSize();
    ctx.browse.setBounds({ x: 0, y: TOPBAR_H, width: w, height: Math.max(0, h - TOPBAR_H) });
    ctx.browse.setVisible(true);
    await sleep(800);
    await probeShot(ctx.browse.webContents, path.join(DATA_DIR, "probe", "probe-search.png"));
    ctx.browse.setVisible(false);
  }

  // 広告リクエストが止まっているか(サイト側コンテキストから promo ドメインを叩く)
  let adProbe = "fetch-failed";
  try {
    adProbe = await ctx.site.webContents.executeJavaScript(
      `fetch("https://securepubads.g.doubleclick.net/musicview-probe", { mode: "no-cors" }).then(() => "ad-NOT-blocked").catch(() => "ad-blocked")`,
    );
  } catch (e) { adProbe = "err:" + e.message; }
  log("adblock", adProbe, "blockedCount", ctx.blocked());
  for (const s of ctx.blockedSamples()) log("blocked:", s);

  // サイト画面からの動画選択(SPA遷移)の再現。/youtubei/v1/player の fetch 経路は
  // mixロード(inline)やloadVideoById(プレイヤー内部)では通らないため、ここでだけ検証できる
  {
    const onConsole = (_e, level, message) => {
      if (level >= 3) log("site-console-err:", String(message).slice(0, 200));
    };
    const onNav = (_e, url) => log("site-nav:", String(url).slice(0, 80));
    ctx.site.webContents.on("console-message", onConsole);
    ctx.site.webContents.on("did-navigate", onNav);
    ctx.site.webContents.on("did-navigate-in-page", onNav);
    try {
      ctx.site.webContents.loadURL("https://www.youtube.com/");
      await sleep(7000);
      const clicked = await ctx.site.webContents.executeJavaScript(`(function () {
        var cands = ["ytd-rich-item-renderer", "yt-lockup-view-model", "ytd-video-renderer", "a#video-title-link"];
        for (var i = 0; i < cands.length; i++) {
          var el = document.querySelector(cands[i]);
          if (el) { el.click(); return cands[i]; }
        }
        return null;
      })()`);
      log("site-click:", JSON.stringify(clicked));
      for (let i = 0; i < 8; i++) {
        await sleep(2500);
        const st = await ctx.site.webContents.executeJavaScript(`JSON.stringify((function () {
          var s = window.__mvCtl ? (window.__mvCtl.snap() || {}) : {};
          return {
            href: location.href.slice(0, 90),
            vid: s.videoId || null,
          q: Array.isArray(s.queue) ? s.queue.length : null,
          q1: Array.isArray(s.queue) ? s.queue[1] : null,
            state: s.state ?? null,
            ad: !!document.querySelector(".ad-showing"),
            spinner: !!document.querySelector(".ytp-spinner, tp-yt-paper-spinner.active"),
            prune: window.__mvPrune ? JSON.stringify(window.__mvPrune) : null
          };
        })())`);
        log(`site-click t=${(i + 1) * 2.5}s:`, st);
        const p = JSON.parse(st);
        if (p.vid && p.state === 1 && !p.ad) { log("site-click PLAYING"); break; }
      }
    } catch (e) { log("site-click err:", e.message); }
    ctx.site.webContents.removeListener("console-message", onConsole);
    ctx.site.webContents.removeListener("did-navigate", onNav);
    ctx.site.webContents.removeListener("did-navigate-in-page", onNav);
  }

  setMode("music");
  await sleep(1200);
  await probeShot(ctx.win.webContents, path.join(DATA_DIR, "probe", "probe-music.png"));

  // 診断レポートが組めること(保存はしない・テキスト生成のみ)。回復履歴/コンソール
  // エラーのセクションが出ていることを確認する
  try {
    const rep = await ctx.diagReport();
    log("diag-report:", rep.length, "chars",
      rep.includes("## 回復履歴") && rep.includes("## コンソールエラー") ? "SECTIONS-OK" : "MISSING-SECTIONS");
  } catch (e) { log("diag-report err:", e.message); }

  // UIヒットテスト: 演奏ボタンの中心に別要素が重なってクリックを奪っていないか
  // (「ボタンが触れなくなる」事故の検出用)
  try {
    const hit = await ctx.win.webContents.executeJavaScript(`(function () {
      return ["prev", "pp", "next", "eq-btn", "diag"].map(function (id) {
        const b = document.getElementById(id);
        if (!b) return { id: id, missing: true };
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const name = top ? (top.id || (top.tagName || "?") + "." + String(top.className && top.className.baseVal !== undefined ? top.className.baseVal : top.className || "").slice(0, 40)) : "none";
        return { id: id, top: name, covered: top !== b && !(b.contains(top)) };
      });
    })()`);
    log("hit-test:", JSON.stringify(hit));
  } catch (e) { log("hit-test err:", e.message); }


  // EQボタンの新挙動(E2E): クリック=ON/OFF(赤化)・右クリック=パネル。
  // プリセット適用→ボタンが赤くなる→パネルの折り返し含めてスクショで確認
  try {
    const eqUi = await ctx.win.webContents.executeJavaScript(`(async function () {
      const btn = document.getElementById("eq-btn");
      btn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 300));
      const preset = document.querySelector('#eq-panel [data-preset="bass"]');
      preset.click();
      await new Promise(r => setTimeout(r, 400));
      return {
        on: btn.classList.contains("on"),
        panelOpen: !document.getElementById("eq-panel").classList.contains("hidden"),
        presetWrapHeight: document.querySelector(".pop-row.presets").offsetHeight,
      };
    })()`);
    log("eq-toggle:", JSON.stringify(eqUi));
    await probeShot(ctx.win.webContents, path.join(DATA_DIR, "probe", "probe-eq.png"));
    await ctx.win.webContents.executeJavaScript(`(function () {
      document.getElementById("eq-close").click();
      document.getElementById("eq-btn").click(); // OFFへ戻す(赤が消える)
    })()`);
    const eqOff = await ctx.win.webContents.executeJavaScript(
      `!document.getElementById("eq-btn").classList.contains("on")`,
    );
    log("eq-toggle off:", eqOff ? "OK" : "NG");
  } catch (e) { log("eq-toggle err:", e.message); }

  // F12 配線の確認: アプリUI側にキー入力を送り DevTools が開くか(サイト側ビューも
  // 同じ attachDevtoolsToggle を共有する)
  try {
    ctx.win.webContents.sendInputEvent({ type: "keyDown", keyCode: "F12" });
    await sleep(900);
    const opened = ctx.win.webContents.isDevToolsOpened();
    log("f12:", opened ? "OPEN-OK" : "NOT-OPENED");
    if (opened) ctx.win.webContents.closeDevTools();
  } catch (e) { log("f12 err:", e.message); }

  // mv:cmd pause/play の健全性(ハンドラ内の未定義変数等の実行時エラーを検出)
  try {
    await execCmd("pause");
    await sleep(400);
    await execCmd("play");
    log("pause-play cmd: OK");
    for (let vi = 0; vi < 5; vi++) {
      await sleep(3000);
      const lv = await execSite("JSON.stringify({ lv: window.__mvCtl ? window.__mvCtl.levels(28) : null, dis: window.__mvAudioDisabled === true, has: !!window.__mvAudio, ready: window.__mvPageReady === true, paused: (function(){var v=document.querySelector('video.html5-main-video');return v?v.paused:null;})(), ct: (function(){var v=document.querySelector('video.html5-main-video');return v?Math.round(v.currentTime*10)/10:null;})(), fails: window.__mvAudioFails === undefined ? null : window.__mvAudioFails })").catch(() => "?");
      log("viz levels:", String(lv).slice(0, 230));
      if (String(lv).indexOf("null") === -1 && vi >= 2) break;
    }
  } catch (e) { log("pause-play err:", e.message); }

  setMode("site");
  await sleep(1500);
  await probeShot(ctx.site.webContents, path.join(DATA_DIR, "probe", "probe-site.png"));

  app.exit(0);
}

// サイト画面でのホーム→動画クリック(SPA遷移)を実走観察する。
// 「クリックしたら読み込みが止まる」を捕獲するための観測装置:
//   - シャドウDOMを潜って本物の動画要素をクリック
//   - 遷移/再生状態/スピナー/広告/解析統計を3秒間隔で追跡
//   - executeJavaScript が5秒返らなかったら「レンダラー固まり」として記録
//   - コンソールエラー・レンダラー死亡・遷移イベントをすべて残す
async function runProbeSpa() {
  const log = (...a) => console.log("spa:", ...a);
  await sleep(2000);
  // 切り分け用: セッションのクロスフェード設定を無効化して観測する(衝突の有無を分離)
  if (process.env.MUSICVIEW_SPA_NOXFADE === "1") {
    ctx.setXfadeSec(0);
    log("xfade disabled for this run");
  }
  ensureSite();
  setMode("site");
  const wc = ctx.site.webContents;
  const onConsole = (_e, level, message, line, sourceId) => {
    if (level >= 3) log("console-err:", String(message).slice(0, 200), "@", String(sourceId || "").split("/").pop() + ":" + line);
  };
  wc.on("console-message", onConsole);
  wc.on("render-process-gone", (_e, d) => log("RENDERER-GONE:", JSON.stringify(d)));
  wc.on("did-navigate", (_e, u) => log("nav:", String(u).slice(0, 90)));
  wc.on("did-navigate-in-page", (_e, u, isMain) => { if (isMain) log("in-page-nav:", String(u).slice(0, 90)); });

  wc.loadURL(ctx.sessionUrl() ?? "https://www.youtube.com/");
  await sleep(9000);
  // 前回曲からの復元を待ってから、ロゴ経由のSPA遷移でホームへ行く(ユーザーの実フロー)
  for (let i = 0; i < 10; i++) {
    const s = await wc.executeJavaScript(`JSON.stringify((function () {
      var s = window.__mvCtl ? (window.__mvCtl.snap() || {}) : {};
      return { state: s.state ?? null, href: location.href.slice(0, 60) };
    })())`).catch(() => "{}");
    try { const p = JSON.parse(s); if (p.state === 1) { log("restored:", p.href, "playing"); break; } } catch { }
    await sleep(2000);
  }
  const logoClicked = await wc.executeJavaScript(`(function () {
    var el = document.querySelector("a#logo") || document.querySelector("ytd-topbar-logo-renderer a") || document.querySelector("ytd-topbar-logo-renderer");
    if (!el) return "no-logo";
    el.click();
    return "logo";
  })()`);
  log("logo-click:", JSON.stringify(logoClicked));
  await sleep(6000);

  const census = await wc.executeJavaScript(`(function () {
    function deepAll(sel) {
      var out = [];
      function walk(root) {
        try { root.querySelectorAll(sel).forEach(function (e) { out.push(e); }); } catch (e) {}
        try {
          var all = root.querySelectorAll("*");
          for (var i = 0; i < all.length; i++) { if (all[i].shadowRoot) walk(all[i].shadowRoot); }
        } catch (e) {}
      }
      walk(document);
      return out;
    }
    var cands = ["ytd-rich-item-renderer", "yt-lockup-view-model", "ytd-video-renderer", "a#video-title-link", "ytd-video-preview", "ytd-media-renderer"];
    var found = {};
    cands.forEach(function (c) { found[c] = deepAll(c).length; });
    found.readyState = document.readyState;
    found.title = (document.title || "").slice(0, 40);
    // 実際に何があるか: ytd-app 配下のタグ名上位と、クリック可能そうな要素の感触
    var tags = {};
    try {
      document.querySelectorAll("ytd-app *").forEach(function (e) {
        var t = e.tagName.toLowerCase();
        if (t.indexOf("ytd-") === 0 || t.indexOf("yt-") === 0) tags[t] = (tags[t] || 0) + 1;
      });
    } catch (e) {}
    found.topTags = Object.entries(tags).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 14);
    found.appChildren = (function () {
      var a = document.querySelector("ytd-app");
      return a ? [...a.children].map(function (e) { return e.tagName.toLowerCase(); }).join(",") : "no-ytd-app";
    })();
    found.permBar = (function () {
      var b = document.querySelector("ytd-permission-role-bottom-bar-renderer, ytd-consent-bump-v2-lightbox");
      return b ? (b.textContent || "").replace(/\s+/g, " ").slice(0, 120) : "none";
    })();
    found.ytInitialData = typeof window.ytInitialData === "object" && window.ytInitialData ? JSON.stringify(window.ytInitialData).length : String(typeof window.ytInitialData);
    found.browse = !!document.querySelector("ytd-browse");
    found.bodyText = (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 150);
    return JSON.stringify(found);
  })()`);
  try {
    await probeShot(wc, path.join(DATA_DIR, "probe", "spa-home.png"));
  } catch (e) { log("shot err:", e.message); }
  log("home census:", census);

  // 観測ループ: 見えているサムネ(可視アンカー)を実際にクリックし、遷移→再生開始
  // までの時間を追跡する。40秒再生に至らなければ STALL として記録。複数回繰り返して
  // 間発性の止まりを捕まえる
  const acCount = { n: 0 };
  wc.on("console-message", (_e, _level, message) => {
    if (String(message || "").indexOf("AudioContext") !== -1) acCount.n++;
  });
  const readState = () => Promise.race([
    wc.executeJavaScript(`JSON.stringify((function () {
      var s = window.__mvCtl ? (window.__mvCtl.snap() || {}) : {};
      var v = document.querySelector("video.html5-main-video");
      var sp = document.querySelector(".ytp-spinner");
      return {
        href: location.href.slice(0, 80),
        vid: s.videoId || null,
        q: (window.__mvCtl && window.__mvCtl.snap() && window.__mvCtl.snap().queue) ? window.__mvCtl.snap().queue.length : null,
        state: s.state ?? null,
        ad: !!document.querySelector(".ad-showing"),
        spinner: sp ? !sp.hasAttribute("hidden") : false,
        vidT: v ? Math.round(v.currentTime * 10) / 10 : null,
        vidPaused: v ? v.paused : null,
        acErr: window.__mvAcErr || 0,
        prune: window.__mvPrune ? JSON.stringify(window.__mvPrune) : null
      };
    })())`).catch(e => "exec-err:" + String(e && e.message).slice(0, 80)),
    new Promise(r => setTimeout(() => r("EXEC-STUCK-5s(レンダラー無応答)"), 5000)),
  ]);

  let stalls = 0, okays = 0;
  // ユーザーフロー再現: 旧曲を一時停止した状態でサムネをクリックする
  // (この状態だと新動画が停止のまま張り付くのが本来の事故。post-nav kick の検証)
  await execCmd("pause");
  log("old video paused (user flow 再現)");
  await sleep(1500);
  for (let r = 1; r <= 6; r++) {
    const pick = await wc.executeJavaScript(`(function () {
      try {
      // フィードの実体はシャドウDOM配下のロックアップ(JS遷移・hrefなし)。
      // 深い再帰はスタックを溢れさせるので明示スタックで潜る
      var items = [];
      var stack = [document];
      while (stack.length) {
        var root = stack.pop();
        try {
          root.querySelectorAll("yt-lockup-view-model, ytd-rich-item-renderer").forEach(function (a) { items.push(a); });
        } catch (e) {}
        try {
          var all = root.querySelectorAll("*");
          for (var i = 0; i < all.length; i++) { if (all[i].shadowRoot) stack.push(all[i].shadowRoot); }
        } catch (e) {}
      }
      var cur = window.__mvCtl ? (window.__mvCtl.snap() || {}).videoId : null;
      var ok = items.filter(function (el) {
        try {
          var r = el.getBoundingClientRect();
          return r.width >= 180 && r.height >= 80;
        } catch (e) { return false; }
      });
      if (!ok.length) return null;
      var el = ok[Math.floor(Math.random() * Math.min(ok.length, 6))];
      // 動画ID: data属性 → サムネimgのURL(/vi/<ID>/) → data JSON の順で拾う
      var v = el.getAttribute("content-id") || el.getAttribute("contentId") || null;
      if (!v) {
        try {
          // innerHTML から "/vi/<ID>/hqdefault.jpg" の ID を拾う(正規表現は
          // テンプレートリテラルのエスケープ(\v等)で壊れるため使わない)
          var html = el.innerHTML || "";
          var k = html.indexOf("/vi/");
          if (k !== -1) {
            var cand = html.substring(k + 4, k + 15);
            if (/^[a-zA-Z0-9_-]{11}$/.test(cand)) v = cand;
          }
        } catch (e) {}
      }
      if (!v) {
        try {
          var m2 = JSON.stringify(el.data || el.__data || "").match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
          if (m2 && m2[1]) v = m2[1];
        } catch (e) {}
      }
      if (!v) return null; // ID不明の lockup は押さない(無駄打ち防止)
      try { el.scrollIntoView({ block: "center" }); } catch (e) {}
      // サムネ画像部分をクリックする(ユーザーと同じ target)
      var thumb = el.querySelector("img, yt-image, *[class*=thumbnail]") || el;
      thumb.click();
      return v;
      } catch (e) { return "err:" + String(e && e.message).slice(0, 80); }
    })()`).catch(e => "click-err:" + String(e && e.message).slice(0, 60));
    if (typeof pick !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(pick)) {
      log(`round${r}: クリック対象なし(${JSON.stringify(pick)}) — 3秒後に再試行`);
      await sleep(3000);
      continue;
    }
    log(`round${r}: サムネクリック -> ${pick}`);
    const t0 = Date.now();
    let played = false;
    for (let i = 1; i <= 20 && !played; i++) {
      await sleep(2000);
      const st = await readState();
      log(`  r${r} +${Math.round((Date.now() - t0) / 1000)}s:`, st);
      if (typeof st === "string" && st.indexOf("{") === 0) {
        try {
          const p = JSON.parse(st);
          if (p.vid === pick && p.state === 1 && !p.ad && Number(p.vidT) > 1) played = true;
        } catch { /* 次へ */ }
      }
    }
    const took = Math.round((Date.now() - t0) / 1000);
    if (played) { okays++; log(`round${r}: OK(${took}秒で再生開始) acErr=${acCount.n}`); }
    else { stalls++; log(`round${r}: STALL(40秒で再生に至らず) acErr=${acCount.n}`); }
  }
  log(`RESULT: ok=${okays} stall=${stalls} audioContextErr累計=${acCount.n}`);

  // 曲末自動進行の検証: 今の曲を末尾5秒へシークし、次の動画へ自動で進むか
  try {
    const before = (await pollOnce())?.snap;
    if (before && before.state === 1 && before.dur > 30) {
      await execCmd("seek", Math.max(0, before.dur - 5));
      log("end-advance: seek to", Math.round(before.dur - 5), "/", Math.round(before.dur), "vid", before.videoId);
      for (let i = 0; i < 16; i++) {
        await sleep(2000);
        const st = await pollOnce();
        const v = st?.snap?.videoId, t = Math.round(st?.snap?.time ?? -1), stt = st?.snap?.state;
        log(`  end-advance +${(i + 1) * 2}s: vid=${v} state=${stt} t=${t}`);
        if (v && v !== before.videoId && stt === 1) { log("end-advance: ADVANCED-OK ->", v); break; }
      }
    }
  } catch (e) { log("end-advance err:", e.message); }
  // 回復履歴(判定器がこの走で何を発火したか)を出してから終わる
  try {
    const rep = await ctx.diagReport();
    const lines = rep.split("\n");
    const i0 = lines.findIndex(l => l.includes("## 回復履歴"));
    const i1 = lines.findIndex(l => l.includes("## コンソールエラー"));
    log("recovery events:\n" + lines.slice(i0, i1).join("\n"));
  } catch (e) { log("diag err:", e.message); }
  wc.removeListener("console-message", onConsole);
  app.exit(0);
}

// Cookie 取り込みの実走確認: 実パーティションへ取り込み → ホームを開いてログイン面を確認。
// importCookiesSafely が既存クッキーを掃除してから入れるため、何度実行しても冪等
async function runProbeImport() {
  const log = (...a) => console.log("probe-import:", ...a);
  await sleep(1500);
  ensureSite();
  log("site UA:", ctx.site.webContents.getUserAgent());
  // ナビゲーション応答が運ぶ Set-Cookie(削除)を観測する(名前と削除フラグのみ)
  const deletions = [];
  const dbg = ctx.site.webContents.debugger;
  try {
    await dbg.attach();
    await dbg.sendCommand("Network.enable");
    dbg.on("Network.responseReceivedExtraInfo", (_e, params) => {
      const sc = params.headers["set-cookie"] ?? params.headers["Set-Cookie"];
      if (!sc) return;
      for (const line of sc.split("\n")) {
        const name = line.split("=")[0].trim();
        const deleting = /max-age=0|expires=thu, 01 jan 1970/i.test(line);
        if (deleting && deletions.length < 12 && !deletions.includes(name)) deletions.push(`${name}(del)`);
      }
    });
  } catch (e) {
    log("debugger err:", e.message);
  }
  const res = await ctx.importCookiesSafely();
  const ses = session.fromPartition(PARTITION);
  await sleep(1000);
  const cookies = await ses.cookies.get({});
  const names = new Set(cookies.map(c => c.name));
  const sessionNames = ["SAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID"].filter(n => names.has(n));
  log("partition cookies:", cookies.length, "session:", sessionNames.join(",") || "none", "live:", !!res.live);
  log("set-cookie deletions:", deletions.join(" ") || "none");
  try { await dbg.detach(); } catch { /* 未attachなら無視 */ }

  await sleep(4000);
  const state = await execSite(`JSON.stringify({
    title: document.title.slice(0, 40),
    online: navigator.onLine,
    avatar: !!document.querySelector("#avatar-btn"),
    signin: !!document.querySelector("#masthead a[href*='accounts.google']"),
    ytcfgLoggedIn: (function () {
      try { return window.ytcfg.get("LOGGED_IN"); } catch (e) { return "n/a"; }
    })()
  })`).catch(e => "err " + e.message);
  log("home state:", state);
  setMode("site");
  await sleep(800);
  await probeShot(ctx.site.webContents, path.join(DATA_DIR, "probe", "probe-import.png"));
  app.exit(0);
}

// サイト表示モードの実見(アプリのトップバーがちゃんと見えているか)をデスクトップごと撮る
async function runProbeDesktop() {
  const log = (...a) => console.log("probe-desktop:", ...a);
  const { desktopCapturer } = await import("electron");
  await sleep(2000);
  ensureSite();
  await ctx.site.webContents.loadURL("https://www.youtube.com/");
  await sleep(5000);
  await probeShot(ctx.win.webContents, path.join(DATA_DIR, "probe", "probe-ui.png")); // 音楽モードのUI
  setMode("site");
  await sleep(2500);
  // レンダラ側の状態が追従したか(ラベル不一致事故の再発チェック)
  try {
    const rstate = await ctx.win.webContents.executeJavaScript(
      `(typeof window.musicview) + " / " + document.body.dataset.mode + " / " + document.getElementById("mode").textContent`,
    );
    log("renderer mode state:", rstate);
  } catch (e) { log("renderer state err:", e.message); }
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1920, height: 1080 } });
  if (sources.length) {
    const file = path.join(DATA_DIR, "probe", "probe-desktop.png");
    await fs.writeFile(file, sources[0].thumbnail.toPNG());
    log("desktop shot saved:", file);
  } else {
    log("no screen source");
  }
  app.exit(0);
}

// クロスフェードの実走確認: 曲の終端付近へシークして、フェード→主役交代を観測する
async function runProbeXfade() {
  const log = (...a) => console.log("probe-xfade:", ...a);
  await sleep(1500);
  ensureSite();
  ctx.site.webContents.loadURL(mixUrl("dQw4w9WgXcQ"));
  let s = null;
  for (let i = 0; i < 14; i++) {
    await sleep(2500);
    s = await pollOnce();
    if (s?.ok && s.snap.state === 1 && s.snap.dur > 0) break;
  }
  log("playing:", s?.snap?.videoId, "dur:", Math.round(s?.snap?.dur ?? 0));
  if (!s?.ok) { app.exit(1); return; }
  ctx.setXfadeSec(8);
  const seed = s.snap.videoId;
  await execCmd("seek", Math.max(1, s.snap.dur - 12));
  log("seeked to", Math.round(s.snap.dur - 12), "xfadeSec=8");
  let prevVid = seed;
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const r = await pollOnce();
    const vid = r?.snap?.videoId ?? "?";
    const phase = ctx.xfade ? ctx.xfade.phase : "idle";
    log(`t+${Math.round((i + 1) * 1.5)}s`, "phase:", phase, "videoId:", vid,
      "time:", Math.round(r?.snap?.time ?? -1), "mainVol:", Math.round(r?.snap?.vol ?? -1));
    if (prevVid !== "dQw4w9WgXcQ" && vid === prevVid && !xfade && i > 3) {
      log("xfade OK: swapped to next track,", "newVol:", Math.round(r?.snap?.vol ?? -1));
      // 手動遷移(ミックス起動)もクロスフェードに乗ることを確認する(実際のボタン経由)
      const beforeId = (await pollOnce())?.snap?.videoId;
      log("manual transition test: mix() click, current =", beforeId);
      const clicked = await ctx.win.webContents.executeJavaScript("window.musicview.mix()");
      log("mix() returned:", clicked);
      for (let j = 0; j < 45; j++) {
        await sleep(1500);
        const r2 = await pollOnce();
        const vid2 = r2?.snap?.videoId ?? "?";
        log(`manual t+${Math.round((j + 1) * 1.5)}s`, "phase:", ctx.xfade ? ctx.xfade.phase : "idle",
          "videoId:", vid2, "time:", Math.round(r2?.snap?.time ?? -1), "vol:", Math.round(r2?.snap?.vol ?? -1));
        if (!xfade && vid2 !== beforeId && r2?.snap?.state === 1 && (r2?.snap?.time ?? 99) < 15) {
          log("manual transition OK: next track playing with volume carried over");
          // 深シーク(フェード窓より深い)でも破綻しないことを確認する
          const deep = (await pollOnce())?.snap;
          if (deep && deep.dur > 30) {
            log("deep seek test ->", Math.round(deep.dur - 1.5));
            await execCmd("seek", deep.dur - 1.5);
            for (let k = 0; k < 30; k++) {
              await sleep(1500);
              const r3 = await pollOnce();
              log(`deep t+${Math.round((k + 1) * 1.5)}s`, "videoId:", r3?.snap?.videoId,
                "state:", r3?.snap?.state, "time:", Math.round(r3?.snap?.time ?? -1),
                "vol:", Math.round(r3?.snap?.vol ?? -1), "xfade:", ctx.xfade ? ctx.xfade.phase : "none");
            }
          }
          break;
        }
      }
      break;
    }
    if (vid !== "dQw4w9WgXcQ") prevVid = vid;
  }
  app.exit(0);
}

// EQ/ビジュアライザーの実走確認: 再生中のページにオーディオグラフを接続し、
// ゲイン反映と解析値の流れを確認する
async function runProbeAudio() {
  const log = (...a) => console.log("probe-audio:", ...a);
  await sleep(1500);
  ensureSite();
  ctx.site.webContents.loadURL(watchUrl("dQw4w9WgXcQ"));
  let s = null;
  for (let i = 0; i < 14; i++) {
    await sleep(2500);
    s = await pollOnce();
    if (s?.ok && s.snap.state === 1 && s.snap.dur > 0) break;
  }
  log("playing:", s?.snap?.videoId, "state:", s?.snap?.state);
  if (!s?.ok) { app.exit(1); return; }
  ctx.setEqGains(clampGains([12, 2, -2, 0, 2]));
  await applyAudioTo(ctx.site);
  await sleep(2500);
  const chk = await execOn(ctx.site, `JSON.stringify({
    has: !!window.__mvAudio,
    g0: window.__mvAudio ? window.__mvAudio.bands[0].gain.value : null,
    g2: window.__mvAudio ? window.__mvAudio.bands[2].gain.value : null,
    lv: window.__mvCtl ? window.__mvCtl.levels(8) : null
  })`);
  log("audio:", chk);
  const r = await pollOnce();
  log("viz:", ctx.vizOn, "pump-sent:", r?.ok, "levels-via-renderer:", "see-ui");
  setMode("music");
  await sleep(1500);
  await probeShot(ctx.win.webContents, path.join(DATA_DIR, "probe", "probe-audio.png"));
  app.exit(0);
}

// Discord接続の実走確認: 保存済みIDで接続し、テストプレゼンスを送る
async function runProbeDiscord() {
  const log = (...a) => console.log("probe-discord:", ...a);
  await sleep(1000);
  const id = (await fs.readFile(path.join(DATA_DIR, "discord.id"), "utf8")).trim();
  log("client id:", id ? `${id.slice(0, 6)}…` : "(none)");
  const dc = new DiscordPresence(id, (...a) => log("discord", ...a));
  dc.start();
  await sleep(5000);
  log("connected:", dc.connected);
  if (dc.connected) {
    // CustomRP のドキュメント準拠: 外部画像の直接リンクはそのまま large_image に使える
    dc.update({
      details: "musicview 接続テスト(60秒間表示)",
      state: "リックのサムネ画像が出ているか確認してください",
      startAt: Date.now() - 10000,
      largeImage: thumbUrl("dQw4w9WgXcQ"),
      largeText: "Never Gonna Give You Up — musicview",
      force: true,
    });
    log("test presence sent — 60秒間表示されます");
    await sleep(60000);
    dc.clear();
    await sleep(1000);
  }
  dc.close();
  app.exit(0);
}
  return { runProbe, runProbeSpa, runProbeImport, runProbeDesktop, runProbeXfade, runProbeAudio, runProbeDiscord };
}
