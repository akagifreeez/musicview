// musicview — YouTube 動画を音楽として聴くことに特化したプレイヤー
// 実サイト(youtube.com)を WebContentsView で包み、音楽向けの操作面を上に重ねる。
// 広告は webRequest(EasyList エンジン)+ プレイヤー内スキップ + CSS 隠しの 3 段構え
import { app, BrowserWindow, WebContentsView, ipcMain, globalShortcut, session, contentTracing, net, dialog, shell } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { extractVideoId, mixUrl, watchUrl, searchUrl, thumbUrl } from "../lib/urlutil.mjs";
import { normalizeQueue, shuffledOrder, nextShuffled, sanitizeQueue, removeOne, insertAfterOne } from "../lib/queue.mjs";
import { parseRecResults, parseDomItems, parseQueueItems, parseGenericItems } from "../lib/recs.mjs";
import { makeSnapshot, validateSnapshot } from "../lib/restore.mjs";
import { clampGains, isFlat } from "../lib/eq.mjs";
import { SITE_BOOTSTRAP, EXTRACT_ITEMS, AD_HIDE_CSS, VISIBILITY_PATCH } from "./inject.mjs";
import { importYoutubeCookies } from "./browser-import.mjs";
import { DiscordPresence } from "./discord.mjs";
import { createRecoveryState, stepRecovery, needsPageCheck, recordEvent, RECOVERY_KIND_JA } from "../lib/recovery.mjs";
import { makeProbes } from "./probes.mjs";

const require = createRequire(import.meta.url);

// メインプロセスの未処理例外は Electron がモーダルダイアログを出して停止してしまう。
// undici の assert(this.paused)(中断応答の後処理で飛ぶ既知バグ)等は継続できる類なので
// 記録して生存する。致命傷になった場合はログで追える
process.on("uncaughtException", (e) => {
  console.error("musicview: uncaught exception (続行):", String((e && (e.stack || e.message)) || e).slice(0, 400));
});
process.on("unhandledRejection", (e) => {
  console.error("musicview: unhandled rejection (続行):", String((e && (e.reason && (e.reason.stack || e.reason.message))) || e).slice(0, 400));
});
const { AdblockEngine, FILTER_ALLOW_PREFIX } = require("./adblock.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv;
// 本体起動中の検証用: userData を分離すればシングルロックに当たららず並行起動できる
if (process.env.MUSICVIEW_USER_DATA) {
  app.setPath("userData", path.join(os.tmpdir(), process.env.MUSICVIEW_USER_DATA));
}
// 実行データ(session/filters/titles)の置き場。パッケージ時は ROOT が app.asar 内に
// なるため書き込めず、userData 配下へ切り替える(迁移植行はしない=初回は取り込み直し)
const DATA_DIR = app.isPackaged ? path.join(app.getPath("userData"), "data") : path.join(ROOT, "data");
const SESSION_FILE = path.join(DATA_DIR, "session.json");
const TITLES_FILE = path.join(DATA_DIR, "titles.json");
const FILTERS_DIR = path.join(DATA_DIR, "filters");
const IS_PROBE = argv.includes("--probe");
// Cookie 取り込みの検証は本番パーティションに対して行う(そのままログイン済みになる)
const IS_IMPORT_PROBE = argv.includes("--probe-import");
// サイト表示時の実際の見た目(トップバーの可視性)をデスクトップごと撮って確認する
const IS_DESKTOP_PROBE = argv.includes("--probe-desktop");
const IS_XFADE_PROBE = argv.includes("--probe-xfade");
const IS_AUDIO_PROBE = argv.includes("--probe-audio");
const IS_DISCORD_PROBE = argv.includes("--probe-discord");
// サイト画面でのホーム→動画クリック(SPA遷移)の実走観測。「読み込みが止まる」の捕獲用
const IS_SPA_PROBE = argv.includes("--probe-spa");
const IS_ANY_PROBE = IS_PROBE || IS_IMPORT_PROBE || IS_DESKTOP_PROBE || IS_XFADE_PROBE || IS_AUDIO_PROBE || IS_DISCORD_PROBE || IS_SPA_PROBE;
// 広告ブロックが再生を詰まらせているかの切り分け用(musicview: adblock off で起動)
const ADBLOCK_OFF = process.env.MUSICVIEW_NO_ADBLOCK === "1";
const PARTITION = IS_PROBE ? "persist:musicview-probe" : "persist:musicview";
const TOPBAR_H = 44;

// ── 基本設定 ──────────────────────────────────
// 動画の自動再生(ユーザー操作なしで鳴らす)
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// UA は素の Chrome と同じ表記に統一する(Electron トークンが残ると Google 関連で弾まれる)。
// Chromium の実バージョン(process.versions.chrome)と揃えるのが安全
app.userAgentFallback = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// ── 状態 ──────────────────────────────────────
let win = null;
let site = null;            // youtube.com の視聴(再生)ビュー
let browse = null;          // 検索結果を読むための隠しビュー(再生ビューを遷移させない)
let mode = "music";         // "music" = 音楽モード(サイト非表示) / "site" = 実サイト表示
let lastSnap = null;
let lastVideoId = null;
let sessionData = null;     // 復元用スナップショット
let shuffleOn = false;
let shuffleOrder = null;
let blockedCount = 0;
const blockedSamples = []; // 切り分け用: 直近のブロック/リダイレクトURL
let recsTimer = null;
let lastQueueIds = null;    // プレイリストパネルから取ったキュー(getPlaylist が null のときの代役)
let bootHasSession = false; // 起動時にセッション Cookie があるか(無いなら youtube を自動ロードしない)

// 再生異常の監視状態と回復履歴。判定そのものは lib/recovery.mjs の
// stepRecovery(純関数)が担い、ここは状態の器とアクションの実行だけを持つ
const rec = createRecoveryState();
// アプリ自身が execCmd("load"/"loadlist") で投入した動画と時刻。loadVideoById は
// URL を変えないため「URL=旧曲・プレイヤー=新曲」になるが、これは破損ではなく
// アプリ起因の食い違い。回復判定器の遷移後番犬が投入を旧URLへ引き戻さないよう伝える
let appLoadVid = null;
let appLoadAt = 0;
let bootAt = 0;             // 起動時刻(診断レポート用)
const RECOVERY_LOG = (...a) => console.log("musicview:", ...a);

// 曲名キャッシュ(キュー表示用)。oEmbed で解決し data/titles.json に永続化
const titles = new Map();
let titlesDirty = false;
const titlesQueue = [];
let titlesFetching = 0;

// ── 広告ブロック(EasyList エンジン)──────────
const adblock = new AdblockEngine();
let adblockReady = false;

// EasyList が無い時間の保険(ドメイン単位)。フィルタ未ロード時のみ使う:
// 読み込み済みなら EasyList 本体(+例外ルール)に任せ、この正規表現が
// 例外(@@)を打ち消して誤ブロックを起こさないようにする
const AD_URL_RE = new RegExp([
  "doubleclick\\.net",
  "googlesyndication\\.com",
  "googleadservices\\.com",
  "adservice\\.google\\.",
  "google-analytics\\.com",
  "googletagmanager\\.com",
  "2mdn\\.net",
  "/pagead/",
  "pubads\\.g\\.doubleclick",
  "securepubads",
].join("|"), "i");

// 取得元(先頭から順に試す)。easylist.to は落ちていることがあるため GitHub ミラーを置く
const FILTER_SOURCES = [
  [
    "https://easylist.to/easylist/easylist.txt",
    "https://raw.githubusercontent.com/easylist/easylist/master/easylist.txt",
  ],
  [
    "https://raw.githubusercontent.com/k2jp/abp-japanese-filters/master/abpjf.txt",
  ],
];
// YouTube 自社の計測を通す例外プリフィクスは adblock.cjs の FILTER_ALLOW_PREFIX
// (本体・filter-battery・テストで同じ定義を共有する)
const FILTERS_MAX_AGE = 24 * 60 * 60 * 1000;

async function downloadFilters() {
  await fs.mkdir(FILTERS_DIR, { recursive: true });
  let combined = "";
  for (const candidates of FILTER_SOURCES) {
    let got = null;
    for (const url of candidates) {
      try {
        const res = await net.fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        got = await res.text();
        break;
      } catch (e) {
        console.error("musicview: filter download failed:", url.slice(0, 60), e.message);
      }
    }
    if (got != null) combined += got + "\n";
  }
  if (!combined) throw new Error("no filter list downloaded");
  await fs.writeFile(path.join(FILTERS_DIR, "combined.txt"), combined, "utf8");
  await fs.writeFile(path.join(FILTERS_DIR, "updated-at"), String(Date.now()), "utf8");
  return combined;
}

async function loadFilters(force = false) {
  const stampFile = path.join(FILTERS_DIR, "updated-at");
  const cacheFile = path.join(FILTERS_DIR, "combined.txt");
  let text = null;
  const cachedAt = Number(await fs.readFile(stampFile, "utf8").catch(() => 0));
  if (!force && Date.now() - cachedAt < FILTERS_MAX_AGE) {
    text = await fs.readFile(cacheFile, "utf8").catch(() => null);
  }
  if (!text) {
    try {
      text = await downloadFilters();
    } catch {
      text = await fs.readFile(cacheFile, "utf8").catch(() => null);
      if (!text) {
        console.error("musicview: adblock filters unavailable (domain block only)");
        return false;
      }
    }
  }
  const n = adblock.loadFromText(FILTER_ALLOW_PREFIX + text);
  adblockReady = true;
  console.log(`musicview: adblock filters loaded (${n} rules)`);
  return true;
}

function noteBlocked(url, kind) {
  if (blockedSamples.length < 40) blockedSamples.push(`${kind} ${url.slice(0, 150)}`);
}

function installAdblock(ses) {
  ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    const url = details.url;
    if (adblockReady) {
      const referrer = details.referrer ?? "";
      const sourceDomain = referrer ? (referrer.match(/^https?:\/\/([^/?#]+)/i)?.[1] ?? null) : null;
      if (adblock.shouldBlock(url, sourceDomain, details.resourceType)) {
        blockedCount++;
        noteBlocked(url, "easy");
        callback({ cancel: true });
        return;
      }
    } else if (AD_URL_RE.test(url)) {
      // 保険はフィルタ未ロード時のみ。ロード済みなら例外(@@)ルールが
      // 優先される通常経路に一本化する(頑固な再ブロックによる誤ブロック防止)
      blockedCount++;
      noteBlocked(url, "domain");
      callback({ cancel: true });
      return;
    }
    callback({});
  });
}

// フィルタの取得スケジュール。初回失敗(オフライン等)でも5分再試行で諦めず、
// ロード済みなら6時間ごとに鮮度を確認して24時間経過分を更新する
// (音楽プレイヤーは数日起動しっぱなしのため、起動時1回ではリストが古びる)
function scheduleFilterLoad() {
  loadFilters()
    .then((ok) => {
      if (ok) setInterval(() => { loadFilters().catch(() => {}); }, 6 * 60 * 60 * 1000);
      else setTimeout(scheduleFilterLoad, 5 * 60 * 1000);
    })
    .catch(() => setTimeout(scheduleFilterLoad, 5 * 60 * 1000));
}

// ── サイトビュー ────────────────────────────────
// F12 / Ctrl+Shift+I でそのビューの DevTools を開閉する(ページ側の調査用)。
// WebContentsView は分割表示できないため別窓(detach)で開く
function attachDevtoolsToggle(wc) {
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isF12 = input.key === "F12";
    const isCtrlShiftI = input.control && input.shift && !input.alt && input.key.toLowerCase() === "i";
    if (!isF12 && !isCtrlShiftI) return;
    event.preventDefault();
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: "detach" });
  });
}

// youtube.com を載せるビューの共通工場。主役(視聴)・検索・クロスフェード退避の
// 3 用途で同じ配線(注入/広告スキップ/Ctrl+M/新窓処理)を使い回す
function makeYouTubeView() {
  const v = new WebContentsView({
    webPreferences: {
      // yt-preload(データ層の広告剥ぎ)はページスクリプトより先に main world で
      // 走る必要があるため、このビュー群だけ sandbox/contextIsolation を切る
      sandbox: false,
      contextIsolation: false,
      preload: process.env.MUSICVIEW_NO_PRELOAD === "1" ? undefined : path.join(ROOT, "electron", "yt-preload.cjs"),
      backgroundThrottling: false, // 非表示でも広告スキップ等のタイマを止めない
      partition: PARTITION,
    },
  });
  v.setBackgroundColor("#0f0f0f");
  const wc = v.webContents;
  wc.on("preload-error", (_e, preloadPath, error) => {
    console.error("musicview: yt preload-error", path.basename(preloadPath), error.message);
  });
  // ページのコンソールエラー。音声デバイス/WebAudioレンダラーが死ぬと
  // 「AudioContext encountered an error」が解析ポンプの周期(約90ms)で無限に出続け、
  // メインプロセスがログ書き出しでCPUを食い潰す(実測で44%)ため:
  //  3回検知したらそのビューのWebAudioを諦めさせて素通しに切り替え、
  //  ログは同一メッセージを10秒に1回へ間引く
  let acFails = 0, lastMsg = "", lastMsgAt = 0;
  wc.on("console-message", (_e, level, message) => {
    const msg = String(message || "");
    if (msg.indexOf("AudioContext") !== -1) {
      if (++acFails === 3) {
        console.error("musicview: audio device error flood, disabling webaudio on this view");
        wc.executeJavaScript(`try { window.__mvCtl.cmd("teardownAudio"); } catch (e) { window.__mvAudioDisabled = true; }`)
          .catch(() => {});
      }
      return; // フラッド中は個別に記録しない
    }
    if (level >= 3) {
      const now = Date.now();
      if (msg === lastMsg && now - lastMsgAt < 10000) return;
      lastMsg = msg;
      lastMsgAt = now;
      noteDiagConsole("site", msg);
      console.error("musicview: yt console:", msg.slice(0, 180));
    }
  });
  // レンダラー/GPU の死は「画面が止まる」としてしか見えないので、原因追えるよう常時記録し、
  // 主役が死んだ場合は同じURLを作り直して「読み込みが終わらないまま放置」を防ぐ
  wc.on("render-process-gone", (_e, d) => {
    console.error("musicview: yt renderer gone", JSON.stringify(d));
    if (d && d.reason === "clean-exit") return;
    setTimeout(() => {
      try {
        const u = wc.getURL();
        if (u && u !== "about:blank" && !wc.isLoading() && !wc.isDestroyed()) {
          console.log("musicview: renderer self-heal reload");
          wc.loadURL(u);
        }
      } catch { /* 無視 */ }
    }, 1500);
  });
  wc.on("dom-ready", () => injectInto(wc));
  // 骨格ページ(起動に失敗してコンテンツ要素が生えない)の自動リロード。
  // 4秒後に内容要素を確認し、無ければ F5 相当を最大2回まで当てる
  wc.on("dom-ready", () => {
    setTimeout(async () => {
      try {
        if (wc.isDestroyed() || wc.isLoading()) return;
        const ok = await wc.executeJavaScript(
          '!!document.querySelector("ytd-watch-flexy, ytd-rich-item-renderer, yt-lockup-view-model, ytd-browse, ytd-search, ytd-video-renderer") || (document.body && document.body.innerText.length > 40)',        );
        if (ok) {
          rec.skeletonReloads.delete(wc.id);
          return;
        }
        const n = rec.skeletonReloads.get(wc.id) || 0;
        if (n < 2 && !wc.isLoading()) {
          rec.skeletonReloads.set(wc.id, n + 1);
          recordEvent(rec, Date.now(), "skeleton-reload", 2, `view=${wc.id} try${n + 1}`);
          RECOVERY_LOG("skeletal page, auto-reload", n + 1);
          wc.reload();
        }
      } catch { /* 無視 */ }
    }, 4000);
  });
  // 主役ビューの遷移だけ曲追跡をリセットする(退避ビューの遷移では触れない)。
  // ユーザーが画面内で遷移した=意図が変わったので、進行中のクロスフェードは打ち切る
  // (放置すると待機ビューが裏で完走し、クリックした曲と無関係な交代/駐車が起きる)
  wc.on("did-navigate", () => {
    if (v === site) {
      lastVideoId = null;
      rec.navAt = Date.now();
      if (xfade) cancelXfade("user navigation");
    }
  });
  wc.on("did-navigate-in-page", () => {
    if (v === site) {
      lastVideoId = null;
      rec.navAt = Date.now();
      if (xfade) cancelXfade("user in-page navigation");
    }
  });
  // サイト表示中はキーボードが YouTube 側に取られるため、Ctrl+M だけは横取りして
  // プレイヤー⇔サイトの切替に使う(YouTube 自体の操作は壊さない)
  wc.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.control && !input.alt && !input.shift
      && input.key.toLowerCase() === "m") {
      event.preventDefault();
      setMode(mode === "music" ? "site" : "music");
    }
  });
  attachDevtoolsToggle(wc);
  // 新窓要求はアプリ内で受ける(youtube 以外は開かない)
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(www\.)?youtube\.com\//.test(url)) wc.loadURL(url);
    return { action: "deny" };
  });
  return v;
}

function ensureSite() {
  if (site && !site.webContents.isDestroyed()) return site;
  site = makeYouTubeView();
  if (win) win.contentView.addChildView(site);
  site.webContents.loadURL(sessionData?.url ?? (bootHasSession ? "https://www.youtube.com/" : "about:blank"));
  applyMode();
  return site;
}

async function injectInto(wc) {
  if (!wc || wc.isDestroyed()) return;
  // 切り分け用: 注入(可視性スプーフ/操作ブリッジ/CSS/EQ反映)を部位ごと外せる
  if (process.env.MUSICVIEW_NO_INJECT === "1") return;
  try {
    const parts = [];
    if (process.env.MUSICVIEW_NO_VIS !== "1") parts.push(VISIBILITY_PATCH);
    if (process.env.MUSICVIEW_NO_BOOT !== "1") parts.push(SITE_BOOTSTRAP);
    if (parts.length) await wc.executeJavaScript(parts.join("\n"));
    if (process.env.MUSICVIEW_NO_CSS !== "1") await wc.insertCSS(AD_HIDE_CSS);
    // EQ/ビジュアライザーを使う設定のときはオーディオグラフを接続してゲインを反映
    if (process.env.MUSICVIEW_NO_EQ !== "1" && (!isFlat(eqGains) || vizOn)) {
      await wc.executeJavaScript(`window.__mvCtl && window.__mvCtl.cmd("eq", ${JSON.stringify(eqGains)})`);
    }
  } catch { /* 遷移直後のレースは無視(次の poll で再注入される) */
  }
}

// 検索用の隠しビュー。再生ビューを遷移させると音楽が止まるため、検索はこちらで行う
function ensureBrowse() {
  if (browse && !browse.webContents.isDestroyed()) return browse;
  browse = new WebContentsView({
    webPreferences: {
      // makeYouTubeView と同じ yt-preload 配線(検索結果側で鳴る埋め込みにも備える)
      sandbox: false,
      contextIsolation: false,
      preload: process.env.MUSICVIEW_NO_PRELOAD === "1" ? undefined : path.join(ROOT, "electron", "yt-preload.cjs"),
      backgroundThrottling: false,
      partition: PARTITION,
    },
  });
  browse.setBackgroundColor("#0f0f0f");
  attachDevtoolsToggle(browse.webContents);
  if (win) {
    win.contentView.addChildView(browse);
    browse.setVisible(false);
  }
  return browse;
}

// ── 曲名解決(oEmbed)────────────────────────────
async function fetchTitle(id) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}&format=json`;
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    titles.set(id, { title: String(j.title ?? ""), author: String(j.author_name ?? "") });
    titlesDirty = true;
  } catch {
    titles.set(id, {}); // 失敗も記録して再試行ループを避ける
  }
  titlesQueue.splice(titlesQueue.indexOf(id), 1);
}

function pumpTitles() {
  while (titlesFetching < 2 && titlesQueue.length) {
    titlesFetching++;
    fetchTitle(titlesQueue[0]).finally(() => {
      titlesFetching--;
      pumpTitles();
    });
  }
}

function resolveTitles(ids) {
  for (const id of ids) {
    if (!titles.has(id)) {
      titles.set(id, null); // 解決中マーク
      titlesQueue.push(id);
    }
  }
  if (titlesQueue.length) pumpTitles();
}

async function saveTitles() {
  if (!titlesDirty) return;
  try {
    const obj = {};
    for (const [id, v] of titles) {
      if (v && v.title) obj[id] = v;
    }
    await fs.writeFile(TITLES_FILE, JSON.stringify(obj), "utf8");
    titlesDirty = false;
  } catch { /* 永続化は気楽に失敗させる */ }
}

async function loadTitles() {
  try {
    const obj = JSON.parse(await fs.readFile(TITLES_FILE, "utf8"));
    for (const [id, v] of Object.entries(obj ?? {})) titles.set(id, v);
  } catch { /* 初回は無い */ }
}

// 3 段構えで曲一覧を組み立てる: 既知ラッパー → DOM アンカー → videoId 直接ノード。
// どの経路でも最終形は「11文字の動画ID + タイトルがあるもの」に揃える
function pickItems(raw) {
  const chain = [
    parseRecResults(raw?.json),
    parseDomItems(raw?.dom),
    parseGenericItems(raw?.generic),
  ];
  const merged = [];
  const seen = new Set();
  for (const list of chain) {
    for (const it of list) {
      if (typeof it?.id !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(it.id) || !it.title) continue;
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      merged.push(it);
    }
    if (merged.length >= 5) break; // 最初に5件以上取れた形を採用
  }
  return merged;
}

// ── おすすめ欄の抽出 ────────────────────────────
async function extractRecs() {
  if (!site || site.webContents.isDestroyed()) return [];
  let raw = null;
  try {
    raw = await site.webContents.executeJavaScript(EXTRACT_ITEMS);
  } catch { return []; }
  const items = pickItems(raw).filter(it => it.id && it.id !== lastVideoId && it.title);
  lastRecsIds = items.map(it => it.id);
  const qItems = parseQueueItems(raw?.queue);
  if (qItems.length) {
    lastQueueIds = qItems.map(it => it.id);
    // キューの曲名はサイトのデータから直に取れる(oEmbed 不要・埋め込み無効動画も漏れない)
    for (const it of qItems) {
      if (it.title && !titles.get(it.id)?.title) titles.set(it.id, { title: it.title, author: it.author });
    }
    titlesDirty = true;
  }
  if (IS_PROBE) console.log("probe: extractRecs raw json", raw?.json?.length, "generic", raw?.generic?.length, "queue", qItems.length, "dom", raw?.dom?.length, "items", items.length);
  if (items.length) {
    for (const it of items) {
      if (!titles.has(it.id) && it.title) titles.set(it.id, { title: it.title, author: it.author });
    }
    titlesDirty = true;
  }
  win?.webContents.send("mv:recs", { kind: "watch", items });
  return items;
}

function scheduleRecsExtract() {
  clearTimeout(recsTimer);
  recsTimer = setTimeout(() => { extractRecs().catch(() => {}); }, 1800);
}

async function extractSearchResults(query) {
  if (!browse || browse.webContents.isDestroyed()) return [];
  // 検索結果は初期HTML後の描画で確定するので、最大5回・10秒の窓で待つ
  await sleep(1500);
  let items = [];
  for (let attempt = 0; attempt < 5 && !items.length; attempt++) {
    if (attempt > 0) await sleep(2000);
    let raw = null;
    try {
      raw = await browse.webContents.executeJavaScript(EXTRACT_ITEMS);
    } catch { continue; }
    if (IS_PROBE) {
      const census = await browse.webContents.executeJavaScript(`JSON.stringify({
        ready: document.readyState,
        title: document.title.slice(0, 40),
        els: document.querySelectorAll("ytd-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model").length,
        videoIdCount: (JSON.stringify(window.ytInitialData || {}).match(/"videoId":"[a-zA-Z0-9_-]{11}"/g) || []).length
      })`).catch(() => null);
      console.log("probe: search try", attempt, "json", raw?.json?.length, "generic", raw?.generic?.length, "dom", raw?.dom?.length, "census", census);
    }
    items = pickItems(raw).filter(it => it.id && it.id !== lastVideoId && it.title);
  }
  win?.webContents.send("mv:recs", { kind: "search", query, items });
  return items;
}

// ── 演奏操作 ──────────────────────────────────
async function execSite(code) {
  if (!site || site.webContents.isDestroyed()) return null;
  try {
    return await site.webContents.executeJavaScript(code);
  } catch {
    return null;
  }
}

async function execOn(view, code) {
  if (!view || view.webContents.isDestroyed()) return null;
  try {
    return await view.webContents.executeJavaScript(code);
  } catch {
    return null;
  }
}

async function snapOf(view) {
  return await execOn(view, "window.__mvCtl ? window.__mvCtl.snap() : null");
}

async function execCmd(name, arg) {
  // アプリ主導の投入を記録(回復判定器の遷移後番犬がこれを引き戻さないように)
  if (name === "load") {
    appLoadVid = String(arg ?? "");
    appLoadAt = Date.now();
  } else if (name === "loadlist") {
    appLoadVid = String((arg && arg.videoId) ?? "");
    appLoadAt = Date.now();
  }
  return await execSite(`(window.__mvCtl ? window.__mvCtl.cmd(${JSON.stringify(name)}, ${JSON.stringify(arg ?? null)}) : "no-ctl")`);
}

// ── クロスフェード ──────────────────────────────
// 退避ビューで次の曲を先に鳴らし始め、残り秒で両者の音量を交叉させ、
// 交差完了後に主役( site )を入れ替える。入れ替え後のキュー進行は自前管理になり、
// ミックスで取得済みのキューを順に進み、尽きたらおすすめ欄から補充する
let xfadeSec = 0;       // 0=オフ(3/5/8/12秒)
let xfadeView = null;   // 退避再生ビュー
let xfade = null;       // { phase:"wait"|"fade", nextId, baseVol, tries, ramp }
let loopOn = false;     // 1曲ループ中はクロスフェードしない
let lastRecsIds = [];   // おすすめ欄のID(キュー末端の補充に使う)
let desiredVol = 100;   // アプリ側が管理する音量/速度(遷移しても YouTube の記憶値に戻されない)
let desiredRate = 1;
let xfadeCooldownUntil = 0; // キャンセル直後の再開を抑える(シーク連打などでのチャーン防止)
let playHistory = [];       // 「前の曲」用の再生履歴(あとから鳴った順・最大50)

// ユーザーが並べ替えたアプリ側キュー(videoId配列)。YouTube プレイヤー自身のキューは
// 外から並べ替えられないため、ユーザーがキューを触った時点でこちらへ引き取り、
// 次曲選択(queueNextId)と表示を優先する。null=未操作(プレイヤーのキューに任せる)
let queueOverride = null;

let userPauseAt = 0;        // ユーザー自身の一時停止操作の時刻

let sleepPauseAt = 0;       // スリープタイマーによる一時停止の時刻
let vizPump = null;
let eqGains = [0, 0, 0, 0, 0]; // 5バンドEQ(60Hz lowshelf が CLEAR BASS 相当)
let vizOn = true;       // ビジュアライザー(解析値をUIへ送って描画)
let discordClient = null;
let lastPresenceKey = "";

// EQ/ビジュアライザーのゲインをビューへ反映(注入直後と設定変更時に呼ぶ)
async function applyAudioTo(view) {
  if (isFlat(eqGains) && !vizOn) return;
  if (!view || view.webContents.isDestroyed()) return;
  await execOn(view, `window.__mvCtl && window.__mvCtl.cmd("eq", ${JSON.stringify(eqGains)})`);
}

function ensureXfadeView() {
  if (xfadeView && !xfadeView.webContents.isDestroyed()) {
    // 再利用分(1回目のクロスフェードで主役だったビュー)はミュート解除済み。
    // 戻し忘れると次の動画の読み込み開始と同時に大音量で流れる
    xfadeView.webContents.setAudioMuted(true);
    return xfadeView;
  }
  xfadeView = makeYouTubeView();
  if (win) win.contentView.addChildView(xfadeView);
  xfadeView.setVisible(false);
  xfadeView.webContents.setAudioMuted(true); // フェード開始まで完全無音(プリロード/広告の音漏れ防止)
  return xfadeView;
}

function cancelXfade(reason) {
  if (!xfade) return;
  console.log("musicview: xfade cancel:", reason);
  if (xfade.ramp) clearInterval(xfade.ramp);
  execCmd("vol", desiredVol); // 主役側の音量を戻す
  try {
    xfadeView?.webContents.setAudioMuted(true);
    xfadeView?.webContents.loadURL("about:blank");
  } catch { /* 無視 */ }
  xfade = null;
  xfadeCooldownUntil = Date.now() + 3000; // 連打/連続シークでの再開チャーンを抑える
}

// 再生しながらの遷移(ミックス起動・選曲)はクロスフェードで滑らかに繋ぐ(Apple Music 風)。
// 未再生/クロスフェード無効/1曲ループ中は即時遷移。
// skipSeed: 今の曲をシードにするミックスの場合、ラジオの2曲目から再生させ
// 同じ曲の最初からやり直しになるのを防ぐ
async function transitionTo(url, opts = {}) {
  const playing = lastSnap?.ok && lastSnap.snap.state === 1 && lastSnap.snap.dur > 30;
  if (xfadeSec > 0 && !loopOn && playing) {
    cancelXfade("new manual transition");
    ensureXfadeView();
    xfade = { phase: "load", url, manual: true, skipSeed: opts.skipSeed ?? null, kicks: 0, lastKick: 0, bornAt: Date.now(), ramp: null };
    xfadeView.webContents.setAudioMuted(true);
    xfadeView.webContents.loadURL(url);
    return true;
  }
  ensureSite().webContents.loadURL(url);
  return false;
}

function queueNextId(snap) {
  // 現在曲そのものを返すと同じ曲へのクロスフェード無限ループになるため、常に自己排除する
  const pick = (list, from) => list.slice(from).find(id => id && id !== snap.videoId) ?? null;
  // ユーザーが並べ替えたキューがあればその順序を優先する。現在曲が override に無い
  // (別の曲へ飛んだ後等)ときは null で従来経路に落とす=キューは放棄した扱い。
  // override の末端ではラジオ継続フォールバック(曲末進行の radio fallback)に譲る
  if (Array.isArray(queueOverride) && queueOverride.length) {
    const i = queueOverride.indexOf(snap.videoId);
    return i >= 0 ? pick(queueOverride, i + 1) : null;
  }
  if (Array.isArray(snap.queue) && snap.qIdx >= 0) {
    const n = pick(snap.queue, snap.qIdx + 1);
    if (n) return n;
  }
  if (Array.isArray(lastQueueIds)) {
    const i = lastQueueIds.indexOf(snap.videoId);
    const n = i >= 0 ? pick(lastQueueIds, i + 1) : null;
    if (n) return n;
    return lastRecsIds.find(id => id !== snap.videoId) ?? null;
  }
  return null;
}

// ── キュー操作(オーバーライド)──────────────────────
// 現在のキュー(プレイヤーのキュー → 取得済みキューの順で解決)を引き取る。
// 未操作の状態で削除/「次に再生」をされたときの下準備
function seizeQueue() {
  if (!Array.isArray(queueOverride)) {
    const snap = lastSnap?.snap;
    const base = Array.isArray(snap?.queue) ? snap.queue
      : (Array.isArray(lastQueueIds) ? lastQueueIds : null);
    if (!base) return false;
    queueOverride = sanitizeQueue(base);
  }
  return queueOverride.length > 0;
}

function queueReorderIds(ids) {
  const clean = sanitizeQueue(ids);
  if (!clean.length) return false;
  queueOverride = clean;
  return true;
}

function queueRemoveId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return false;
  if (!seizeQueue()) return false;
  queueOverride = removeOne(queueOverride, id);
  return true;
}

function queuePlayNextId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return false;
  if (!seizeQueue()) return false;
  const cur = lastSnap?.snap?.videoId;
  queueOverride = insertAfterOne(queueOverride, cur, id);
  return true;
}

// ── 前/次の曲 ──────────────────────────────────
// プレイヤーAPIの previousVideo/nextVideo は実走で無反応だった(プレイリスト接続の
// 有無にかかわらず信用できない)。そのため両方とも loadVideoById で飛ぶ:
// 「前」は再生履歴、「次」は自前キュー(ミックス接続中はそのキュー、裸ページでは
// 取得済みキュー/おすすめ)。shuffle の次曲と同じ確実な経路
function goPrev() {
  const cur = lastSnap?.snap?.videoId;
  while (playHistory.length) {
    const id = playHistory.pop();
    if (id && id !== cur) {
      execCmd("load", id);
      return id;
    }
  }
  execCmd("prev"); // 履歴が無いときの一抑え(効かなければ現状維持)
  return null;
}

function goNext() {
  const snap = lastSnap?.snap;
  const nid = snap ? queueNextId(snap) : null;
  if (nid) {
    execCmd("load", nid);
    return nid;
  }
  execCmd("next"); // 自前キューでも次が取れないときの最後の一抑え
  return "player";
}

async function tickXfade() {
  if (xfadeSec <= 0 || loopOn || !site || site.webContents.isDestroyed()) return;
  const s = lastSnap;
  if (!s || !s.ok) return;
  const remain = s.snap.dur - s.snap.time;

  if (!xfade) {
    // 新規開始は主役が再生中のときだけ。
    // 深シークでフェード窓を飛ばされて曲が終わった場合は、ハードカットで次曲へ進む。
    // この進行はクロスフェード専用パスなので回復判定器(stepRecovery)の対象外
    if (s.snap.state !== 1 || s.snap.ad || s.snap.dur < 30) {
      if (s.snap.state === 0 && Date.now() > xfadeCooldownUntil) {
        const nextId = queueNextId(s.snap);
        if (nextId && nextId !== s.snap.videoId) {
          console.log("musicview: hard-cut advance ->", nextId);
          site.webContents.loadURL(watchUrl(nextId));
        }
      }
      return;
    }
    // フェード窓の20秒前からプリロードを始める(広告のスキップと再生開始を待つ余裕)。
    // 窓より深くまでシークされた場合(残り数秒)は間に合わないので、この曲はネイティブ遷移
    if (remain <= xfadeSec + 20 && remain >= xfadeSec + 2 && Date.now() > xfadeCooldownUntil) {
      const nextId = queueNextId(s.snap);
      if (!nextId || nextId === s.snap.videoId) return;
      ensureXfadeView();
      xfade = { phase: "load", url: watchUrl(nextId), manual: false, kicks: 0, lastKick: 0, bornAt: Date.now(), ramp: null };
      console.log(`musicview: xfade begin -> ${nextId} (remain ${Math.round(remain)}s, standbyMuted=${xfadeView.webContents.isAudioMuted()})`);
      xfadeView.webContents.loadURL(xfade.url);
    }
    return;
  }

  let st = await snapOf(xfadeView);
  if (!st) {
    // dom-ready の注入がレースで失敗することがあるため、ここで再注入する
    await execOn(xfadeView, VISIBILITY_PATCH + "\n" + SITE_BOOTSTRAP);
    st = await snapOf(xfadeView);
  }
  if (!st) {
    if (Date.now() - xfade.bornAt > 30000) cancelXfade("standby dead");
    return;
  }

  // 待機ビューが広告中: スキップは skipTick に任せ、再生キックだけ続ける。
  // 広告の進行中に読み直すと広告が最初からやり直しになり、待機が永久に終わらない。
  // ただし広告から抜けられないまま固着した場合は打ち切って主役を直読み替えする
  // (永久待ち=手動遷移の「読み込みが終わらない」の防止)
  if (st.ad) {
    if (Date.now() - xfade.bornAt > 45000) {
      console.log("musicview: xfade standby stuck on ad, hard fallback");
      const url = xfade.url;
      cancelXfade("standby stuck on ad");
      site.webContents.loadURL(url);
      return;
    }
    if (Date.now() - xfade.lastKick > 800) {
      xfade.lastKick = Date.now();
      await execOn(xfadeView, `window.__mvCtl.cmd("play")`);
    }
    return;
  }

  // 未開始: プレイヤーミュート+再生を蹴り続け(ミュートなら自動再生が必ず通り、
  // 無音)、詰まっていたら読み直して再生開始をやり直す。読み直しても45秒立つなら諦める
  if (st.state === -1 || st.state === 5) {
    if (Date.now() - xfade.bornAt > 45000) {
      console.log("musicview: xfade standby never started, hard fallback");
      const url = xfade.url;
      cancelXfade("standby never started");
      site.webContents.loadURL(url);
      return;
    }
    if (Date.now() - xfade.lastKick > 800) {
      xfade.lastKick = Date.now();
      xfade.kicks++;
      await execOn(xfadeView, `window.__mvCtl.cmd("mute")`);
      await execOn(xfadeView, `window.__mvCtl.cmd("vol", 0)`);
      await execOn(xfadeView, `window.__mvCtl.cmd("play")`);
      if (xfade.kicks % 12 === 0) {
        console.log("musicview: xfade standby stalled, reloading");
        xfadeView.webContents.loadURL(xfade.url);
      }
    }
    return;
  }

  // 主役が先に終わった(深シーク等): 待機ビューが鳴り始めたら即交代する。
  // ここでは主役の状態に依存せず待機ビューを進める(止まったまま放置されないように)
  if (s.snap.state === 0) xfade.endPending = true;
  if (xfade.endPending && st.state === 1 && !st.ad && st.time > 0.5) {
    console.log("musicview: xfade main ended early, promoting standby");
    await finalizeXfade();
    return;
  }

  // 再生が始まったら(手動ミックスはラジオの2曲目へ飛ばして)頭出しする
  if (xfade.phase === "load" && st.state === 1 && st.time > 1.2) {
    await execOn(xfadeView, `window.__mvCtl.cmd("vol", 0)`);
    if (xfade.manual && xfade.skipSeed) {
      // シード曲(=今の曲)の最初からのやり直しを避ける。
      // プレイヤーにキューが接続されたら、シードの次(シード自体がキューに無ければ先頭)へ playAt。
      // 接続前の playAt は無視されるため、接続を最大30秒待つ
      const q = Array.isArray(st.queue) ? st.queue : null;
      if (q && q.length >= 2) {
        const qi = q.indexOf(xfade.skipSeed);
        const idx = qi >= 0 && qi + 1 < q.length ? qi + 1 : 0;
        if (q[idx] !== xfade.skipSeed) {
          xfade.skipTarget = q[idx];
          xfade.skipFails = 0;
          await execOn(xfadeView, `window.__mvCtl.cmd("playAt", ${idx})`);
          xfade.phase = "skip";
          console.log(`musicview: xfade skip seed -> ${xfade.skipTarget} (idx ${idx})`);
          return;
        }
      }
      // キュー未接続: 接続を待つ(来なければシード再生にフォールバック)
      if (++xfade.skipTries < 60) return;
      console.log("musicview: xfade queue not attached, playing seed");
    }
    startFade(st.state);
    return;
  }

  // シード飛ばし後、飛び先が正しく鳴っているか確認する
  if (xfade.phase === "skip") {
    if (IS_ANY_PROBE) console.log(`musicview: xfade-skip st(state=${st.state},vid=${st.videoId},t=${Number(st.time).toFixed(1)},q=${st.queue?.length ?? null}) target=${xfade.skipTarget}`);
    if (st.videoId === xfade.skipTarget && st.state === 1 && st.time > 1.2) {
      await execOn(xfadeView, `window.__mvCtl.cmd("vol", 0)`);
      await execOn(xfadeView, `window.__mvCtl.cmd("seek", 0.3)`);
      await execOn(xfadeView, `window.__mvCtl.cmd("pause")`);
      xfade.phase = "hold";
      console.log("musicview: xfade radio second track held:", st.videoId);
      return;
    }
    // playAt が効かなかった場合の訂正(次曲のロード自体に数秒かかるので猶予は長め)
    if (Date.now() - (xfade.lastVerify ?? 0) > 4000) {
      xfade.lastVerify = Date.now();
      xfade.skipFails = (xfade.skipFails ?? 0) + 1;
      const playerIdx = Array.isArray(st.queue) ? st.queue.indexOf(xfade.skipTarget) : -1;
      if (xfade.skipFails === 1 && playerIdx >= 0) {
        await execOn(xfadeView, `window.__mvCtl.cmd("playAt", ${playerIdx})`);
        console.log("musicview: xfade re-playAt", playerIdx);
      } else if (xfade.skipFails === 2) {
        await execOn(xfadeView, `window.__mvCtl.cmd("load", ${JSON.stringify(xfade.skipTarget)})`);
        console.log("musicview: xfade fallback load", xfade.skipTarget);
      } else if (xfade.skipFails === 3) {
        await execOn(xfadeView, `window.__mvCtl.cmd("load", ${JSON.stringify(xfade.skipTarget)})`);
        console.log("musicview: xfade fallback load(2)", xfade.skipTarget);
      } else if (xfade.skipFails > 14) {
        // どうしても飛べない場合はシード再生に戻して普通にフェードする
        await execOn(xfadeView, `window.__mvCtl.cmd("vol", 0)`);
        await execOn(xfadeView, `window.__mvCtl.cmd("seek", 0.3)`);
        await execOn(xfadeView, `window.__mvCtl.cmd("pause")`);
        xfade.phase = "hold";
        console.log("musicview: xfade skip gave up, holding seed");
      }
    }
    return;
  }

  // 保留中に待機ビューが再生し出したら再ポーズする(ポーズ失敗時の暴走防止)
  if (xfade.phase === "hold" && st.state === 1 && st.time > 1.5) {
    await execOn(xfadeView, `window.__mvCtl.cmd("pause")`);
    return;
  }

  // 保留からのフェード開始(手動は準備完了直後=即応、自動はフェード窓)。
  // 待機ビューが広告中は広告をフェードインしてしまうため、抜けるまで待つ
  if (xfade.phase === "hold" && !st.ad && (xfade.manual || remain <= xfadeSec + 0.5)) {
    startFade(st.state);
  }
}

function startFade(standbyState) {
  if (!xfade || xfade.phase === "fade") return;
  xfade.phase = "fade";
  xfade.startedAt = Date.now();
  xfadeView.webContents.setAudioMuted(false);
  execOn(xfadeView, `window.__mvCtl.cmd("unMute")`);
  execOn(xfadeView, `window.__mvCtl.cmd("vol", 0)`);
  if (standbyState === 2) execOn(xfadeView, `window.__mvCtl.cmd("play")`);
  xfade.ramp = setInterval(() => { fadeStep().catch(() => {}); }, 150);
  console.log("musicview: xfade fade started");
}

async function fadeStep() {
  if (!xfade || xfade.phase !== "fade") {
    if (xfade?.ramp) clearInterval(xfade.ramp);
    return;
  }
  const m = await snapOf(site);
  const st = await snapOf(xfadeView);
  // 主役が広告に入ると time/dur が広告のタイムラインになるため、進行計算も終了判定も保留する
  if (m && m.ad) return;
  const base = desiredVol;
  // 進捗の基準: 手動遷移=開始からの経過時間(今すぐ切り替えるのが目的)、
  // 自動=主役の残り時間(xfadeSec 前から 0 → 曲末で 1)
  let p;
  if (xfade.manual) {
    p = Math.min(1, (Date.now() - (xfade.startedAt ?? Date.now())) / (xfadeSec * 1000));
  } else {
    const remain = m ? m.dur - m.time : 0;
    p = 1 - Math.min(1, Math.max(0, remain / xfadeSec));
  }
  const mainEnded = !xfade.manual && (!m || m.state === 0 || (m.dur > 0 && m.time >= m.dur - 0.4));
  if (IS_ANY_PROBE) console.log(`musicview: xfade-fade p=${Number(p).toFixed(2)} remain=${Number(m ? m.dur - m.time : 0).toFixed(1)} main(state=${m?.state},t=${Number(m?.time ?? 0).toFixed(1)}) st(state=${st?.state},t=${Number(st?.time ?? 0).toFixed(1)})`);
  await execOn(site, `window.__mvCtl.cmd("vol", ${Math.round(base * (1 - p))})`);
  await execOn(xfadeView, `window.__mvCtl.cmd("vol", ${Math.round(base * p)})`);
  if (p >= 1 || mainEnded) await finalizeXfade();
}

async function finalizeXfade() {
  if (!xfade) return;
  if (xfade.ramp) clearInterval(xfade.ramp);
  await execCmd("pause"); // 旧プレイヤーを止める
  await execOn(xfadeView, `window.__mvCtl.cmd("vol", ${desiredVol})`);
  const old = site;
  site = xfadeView;
  xfadeView = old;
  xfade = null;
  try {
    xfadeView.setVisible(false);
    xfadeView.webContents.setAudioMuted(true); // 駐車中も無音を保つ(次の再利用時に漏れないように)
    xfadeView.webContents.loadURL("about:blank");
  } catch { /* 無視 */ }
  lastVideoId = null; // 新主役の曲としておすすめを再抽出
  applyMode();
  // 交代先はミュート解除を保証(保留からの再開と合わせて無音化を防ぐ)
  try { site.webContents.setAudioMuted(false); } catch { /* 無視 */ }
  // 保留中(一時停止)の待機ビューに交代した場合はここで再生を再開しないと無音になる
  const ns = await snapOf(site);
  if (ns && (ns.state === 2 || ns.state === -1 || ns.state === 5)) {
    await execOn(site, `window.__mvCtl.cmd("play")`);
  }
  console.log("musicview: xfade done, swapped to", site?.webContents?.getURL?.().slice(0, 60));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── スナップショット(poll の実体)──────────────
function safeSiteUrl() {
  try { return site.webContents.getURL(); } catch { return null; }
}
function siteLoading() {
  try { return site.webContents.isLoading(); } catch { return false; }
}
function siteMuted() {
  try { return site.webContents.isAudioMuted(); } catch { return false; }
}

// 回復判定器(stepRecovery)が返したアクションを順に実行する。
// 判定と副作用を分けているので、ここに分岐の知識は無い(しきい値は lib/recovery.mjs)
async function runRecoveryActions(actions) {
  for (const a of actions) {
    switch (a.kind) {
      case "recovery-unmute":
        RECOVERY_LOG("recovery unmute");
        await execCmd("unmute");
        await execCmd("vol", desiredVol);
        break;
      case "unmute-main":
        try {
          site.webContents.setAudioMuted(false);
          RECOVERY_LOG("main view was muted, unmuted");
        } catch { /* 無視 */ }
        break;
      case "play-kick":
      case "nav-play":
        await execCmd("play");
        break;
      case "self-heal-reload":
        RECOVERY_LOG("site unresponsive, self-heal reload");
        try { site.webContents.loadURL(a.url); } catch { /* 無視 */ }
        break;
      case "nav-full-reload":
        RECOVERY_LOG("post-nav on broken page, full re-load", String(a.url ?? "").slice(0, 60));
        try { site.webContents.loadURL(a.url); } catch { /* 無視 */ }
        break;
      case "nav-force-loadlist":
        RECOVERY_LOG("post-nav force load", a.videoId, "with list", String(a.list).slice(0, 24));
        await execCmd("loadlist", { videoId: a.videoId, list: a.list });
        break;
      case "nav-force-load":
        RECOVERY_LOG("post-nav force load", a.videoId, "(player stuck)");
        await execCmd("load", a.videoId);
        break;
      case "unstarted-mute-play":
        RECOVERY_LOG("recovery mute-play");
        await execSite(`(function(){var p=document.getElementById("movie_player");if(!p)return;try{p.mute();p.playVideo();}catch(e){}})()`);
        break;
      case "unstarted-load":
        await execCmd("load", a.videoId);
        break;
      case "stall-reacquire":
        RECOVERY_LOG("playback frozen 15s, re-acquire stream", a.videoId, "@", Math.round(a.seekTo), "try", a.tryN);
        // 位置を保持したままストリームを取り直し、停滞位置から再生し直す
        execCmd("load", a.videoId).catch(() => {}).then(async () => {
          await sleep(1500);
          await execCmd("seek", a.seekTo).catch(() => {});
          await execCmd("play").catch(() => {});
        });
        break;
      case "stall-page-reload":
        RECOVERY_LOG("playback frozen after retries, page re-acquire");
        try { site.webContents.loadURL(a.url); } catch { /* 無視 */ }
        break;
      case "end-advance":
        RECOVERY_LOG("end-of-track advance ->", a.videoId, a.queued ? "(queue)" : "(radio fallback)");
        try {
          site.webContents.loadURL(mixUrl(a.videoId));
          rec.navAt = Date.now();
        } catch { /* 無視 */ }
        break;
      default:
        RECOVERY_LOG("unknown recovery action", a.kind);
    }
  }
}

async function pollOnce() {
  if (!site) return { ok: false, mode, blocked: blockedCount };
  let snap = await execSite("window.__mvCtl ? window.__mvCtl.snap() : null");
  if (!snap) {
    await injectInto(site.webContents);
    snap = await execSite("window.__mvCtl ? window.__mvCtl.snap() : null");
  }
  if (!snap || !snap.videoId) {
    // 応答がない状態が続くならレンダラーが固まっている。about:blank 駐車中を除き、
    // 同じURLを作り直して自己回復させる(「読み込みが終わらないまま放置」の止め)
    await runRecoveryActions(stepRecovery(rec, {
      now: Date.now(), isProbe: IS_ANY_PROBE, snapOk: false, snap: null,
      url: safeSiteUrl(), urlLoading: siteLoading(),
    }).actions);
    return { ok: false, mode, blocked: blockedCount };
  }

  if (snap.videoId !== lastVideoId) {
    if (lastVideoId && lastVideoId !== snap.videoId) {
      playHistory.push(lastVideoId);
      if (playHistory.length > 50) playHistory.shift();
    }
    lastVideoId = snap.videoId;
    scheduleRecsExtract();
    // 遷移のたびにアプリ側の音量/速度を引き継ぐ(YouTube の記憶値に戻されるのを防ぐ。
    // 「この曲からミックス」等の遷移で音量が 100 に飛ぶ問題の修正)
    await execCmd("vol", desiredVol);
    await execCmd("rate", desiredRate);
  }

  // ── 回復判定(監視状態の更新+アクション決定は lib/recovery.mjs が担う)────
  // 遷移直後の強制投入のときだけ、ページの骨格判定のコストを払う
  const nowMs = Date.now();
  const url = safeSiteUrl();
  let urlVideoId = null, urlList = null;
  try {
    const u = new URL(url);
    urlVideoId = u.searchParams.get("v");
    urlList = u.searchParams.get("list");
  } catch { /* URL 取得失敗は無視 */ }
  let pageOk = null;
  if (needsPageCheck(rec, { now: nowMs, urlVideoId, videoId: snap.videoId, appLoadVid, appLoadAt })) {
    pageOk = await execSite('!!document.querySelector("ytd-watch-flexy, ytd-rich-item-renderer, yt-lockup-view-model")').catch(() => null);
  }
  await runRecoveryActions(stepRecovery(rec, {
    now: nowMs, isProbe: IS_ANY_PROBE, snapOk: true, snap,
    url, urlLoading: siteLoading(), mainMuted: siteMuted(),
    urlVideoId, urlList, pageOk,
    xfadeOff: xfadeSec <= 0, loopOn, xfadeCooldownActive: nowMs < xfadeCooldownUntil,
    nextId: queueNextId(snap),
    appLoadVid, appLoadAt,
  }).actions);

  // Discord Rich Presence(曲/再生状態が変わったときだけ送る)
  // 画像: 大=再生中動画のサムネイル(外部直接リンク)、小=アプリのロゴアセット("art")
  const pkey = `${snap.videoId}|${snap.state}|${snap.title}`;
  // 広告中は state/time が広告側に引っ張られるので presence を更新しない(楽曲表示を維持)
  if (!snap.ad && pkey !== lastPresenceKey && discordClient) {
    lastPresenceKey = pkey;
    const presencePayload = {
      largeImage: thumbUrl(snap.videoId),
      largeText: snap.title || "musicview",
      smallImage: "art",
      smallText: "musicview",
    };
    if (snap.state === 1 || snap.state === 3) {
      discordClient.update({
        details: snap.title || "YouTube",
        state: snap.author || "musicview",
        startAt: snap.state === 1 ? Date.now() - snap.time * 1000 : undefined,
        ...presencePayload,
        type: 2, // LISTENING(〜を再生中)
        buttons: [{ label: "YouTubeで開く", url: `https://www.youtube.com/watch?v=${snap.videoId}` }],
      });
    } else if (snap.state === 2) {
      discordClient.update({
        details: snap.title || "YouTube",
        state: "一時停止",
        ...presencePayload,
        type: 2,
        buttons: [{ label: "YouTubeで開く", url: `https://www.youtube.com/watch?v=${snap.videoId}` }],
        force: true,
      });
    } else {
      discordClient.clear();
    }
    console.log(`musicview: presence large_image=${presencePayload.largeImage} small=${presencePayload.smallImage} type=${"2"} state=${snap.state}`);
  }

  // 現在曲の曲名はプレイヤーから直に取れる(oEmbed を待たずにキュー表示が埋まる)
  if (snap.title && !titles.get(snap.videoId)?.title) {
    titles.set(snap.videoId, { title: snap.title, author: snap.author });
    titlesDirty = true;
  }

  // 非表示のサイトでの未開始(-1/5)への再生キックと段階的回復は、
  // 上の回復判定器(stepRecovery)が担う

  resolveTitles(snap.queue ?? [snap.videoId]);

  // プレイヤー API にキューが無いときはプレイリストパネル抽出で代用する
  // (ユーザーが並べ替えた override がある間は推定を挟まない)
  let queueEstimated = false;
  if (!Array.isArray(snap.queue) && !(Array.isArray(queueOverride) && queueOverride.length)
    && Array.isArray(lastQueueIds) && lastQueueIds.length > 1) {
    snap.queue = lastQueueIds;
    snap.qIdx = lastQueueIds.indexOf(snap.videoId);
    queueEstimated = true;
  }

  // 復元設定(音量・速度)は desiredVol/desiredRate 経由で遷移ごとに当たるため個別処理は不要

  const q = (Array.isArray(queueOverride) && queueOverride.length) ? queueOverride : normalizeQueue(snap);
  const historyIds = playHistory.slice(-50).reverse(); // 履歴は新しい順で見せる
  resolveTitles(historyIds);
  const queueIsOverride = Array.isArray(queueOverride) && queueOverride.length > 0;
  const result = {
    ok: true,
    mode,
    blocked: blockedCount,
    ad: !!snap.ad,
    snap,
    queueEstimated,
    queueOverride: queueIsOverride,
    xfadeSec,
    loopOn,
    xfading: !!xfade,
    eq: eqGains,
    viz: vizOn,
    discord: discordClient?.connected ? "on" : (discordClient ? "off" : "no-id"),
    thumb: thumbUrl(snap.videoId, "maxres"),
    queueItems: q.map(id => ({ id, title: titles.get(id)?.title ?? null, author: titles.get(id)?.author ?? null })),
    historyItems: historyIds.map(id => ({ id, title: titles.get(id)?.title ?? null, author: titles.get(id)?.author ?? null })),
  };
  lastSnap = result;
  tickXfade().catch(() => {}); // クロスフェード進行(フェード中はこちらの 150ms 基調が担う)
  return result;
}

// ── セッション保存/復元 ─────────────────────────
async function saveSession() {
  if (IS_ANY_PROBE) return; // 実プロファイルのセッションを検証実行で上書きしない
  try {
    const url = site && !site.webContents.isDestroyed() ? site.webContents.getURL() : null;
    const s = makeSnapshot({
      url,
      time: lastSnap?.snap?.time ?? 0,
      vol: desiredVol,
      rate: desiredRate,
      mode,
      xfade: xfadeSec,
      eq: eqGains,
      viz: vizOn,
    });
    if (!s) return;
    sessionData = s;
    await fs.writeFile(SESSION_FILE, JSON.stringify(s), "utf8");
  } catch { /* 保存失敗は次回に譲る */ }
}

async function loadSession() {
  try {
    sessionData = validateSnapshot(JSON.parse(await fs.readFile(SESSION_FILE, "utf8")));
  } catch {
    sessionData = null;
  }
  if (sessionData) mode = sessionData.mode;
}

// ── Cookie 取り込み ──────────────────────────────
// 生きている youtube.com ページ(未ログイン状態のもの)はセッション Cookie を
// 明示的に削除してくるため、全ビューを about:blank へ退避させてから取り込む。
// 取り込み後に最後の視聴位置(またはホーム)を読み直す
async function importCookiesSafely() {
  for (const v of [site, browse]) {
    try {
      v?.webContents.loadURL("about:blank");
    } catch { /* 無い場合は無視 */ }
  }
  await sleep(700);
  const ses = session.fromPartition(PARTITION);
  const res = await importYoutubeCookies(ses, app.userAgentFallback, (...a) => console.log("musicview: import", ...a));
  if (res.ok) {
    ensureSite().webContents.loadURL(sessionData?.url ?? "https://www.youtube.com/");
  }
  return res;
}

// ── 診断レポート ──────────────────────────────
// 不具合報告の材料を 1 つのテキストにまとめる。回復履歴/コンソールエラー/prune
// 統計/ビュー状態を含む。Cookie やセッションの中身は含めない(URL の v/list のみ)
const diagConsole = []; // 直近のコンソールエラー(リング 100)
function noteDiagConsole(src, msg) {
  diagConsole.push({ at: Date.now(), src, msg: String(msg).slice(0, 220) });
  if (diagConsole.length > 100) diagConsole.shift();
}

function fmtStamp(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function viewDiag(name, v) {
  try {
    if (!v) return `${name}: (無し)`;
    const wc = v.webContents;
    if (wc.isDestroyed()) return `${name}: (破棄済み)`;
    return `${name}: url=${wc.getURL().slice(0, 100)} loading=${wc.isLoading()} muted=${wc.isAudioMuted()}`;
  } catch { return `${name}: (取得失敗)`; }
}

async function collectDiagnostics() {
  const L = [];
  L.push("musicview 診断レポート");
  L.push(`生成: ${fmtStamp(Date.now())} / 版: ${app.getVersion()} / 起動: ${fmtStamp(bootAt)}`);
  L.push(`UA: ${app.userAgentFallback}`);
  L.push(`partition: ${PARTITION} / モード: ${mode} / 検証実行: ${IS_ANY_PROBE ? "はい" : "いいえ"}`);
  L.push("");
  L.push("## 再生状態");
  const s = lastSnap?.snap;
  if (s) {
    L.push(`曲: ${s.title ?? "?"} / ${s.author ?? "?"} (id=${s.videoId} state=${s.state} time=${Math.round(s.time)}s dur=${Math.round(s.dur)}s ad=${!!s.ad})`);
    if (Array.isArray(s.queue)) L.push(`キュー: ${s.queue.length} 件 (qIdx=${s.qIdx})`);
  } else {
    L.push("スナップなし(未再生 or ビュー無応答)");
  }
  L.push("");
  L.push("## ビュー");
  L.push(viewDiag("site(再生)", site));
  L.push(viewDiag("browse(検索)", browse));
  L.push(viewDiag("xfade(退避)", xfadeView));
  let prune = "(取得できず)";
  try { prune = (await execSite("JSON.stringify(window.__mvPrune ?? null)")) ?? prune; } catch { }
  L.push(`prune統計: ${prune}`);
  L.push(`adblock: 準備=${adblockReady ? "済" : "未"} ブロック累計=${blockedCount}`);
  if (blockedSamples.length) {
    L.push("ブロック例(直近 10 件):");
    for (const b of blockedSamples.slice(-10)) L.push(`  ${b}`);
  }
  L.push(`設定: xfade=${xfadeSec}s loop=${loopOn} eq=${JSON.stringify(eqGains)} viz=${vizOn} discord=${discordClient ? (discordClient.connected ? "接続" : "未接続") : "設定なし"}`);
  L.push(`セッション: ${sessionData ? "あり" : "なし"} / 起動時ログイン=${bootHasSession ? "あり" : "なし"}`);
  L.push("");
  L.push("## 回復履歴(新しい順・直近 60 件)");
  if (rec.events.length) {
    for (const e of rec.events.slice(-60).reverse()) {
      L.push(`  [${fmtStamp(e.at)}] ${RECOVERY_KIND_JA[e.kind] ?? e.kind} (lv${e.level}) ${e.detail}`);
    }
  } else {
    L.push("  (記録なし=回復は発火していない)");
  }
  L.push("");
  L.push("## コンソールエラー(新しい順・直近 40 件)");
  if (diagConsole.length) {
    for (const e of diagConsole.slice(-40).reverse()) {
      L.push(`  [${fmtStamp(e.at)}] (${e.src}) ${e.msg}`);
    }
  } else {
    L.push("  (記録なし)");
  }
  return L.join("\n");
}

// ── モード切替 ────────────────────────────────
function applyMode() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  if (site && !site.webContents.isDestroyed()) {
    if (mode === "site") {
      site.setBounds({ x: 0, y: TOPBAR_H, width: w, height: Math.max(0, h - TOPBAR_H) });
      site.setVisible(true);
    } else {
      site.setVisible(false);
    }
  }
  win.webContents.send("mv:mode", mode);
}

function setMode(m) {
  mode = m === "site" ? "site" : "music";
  applyMode();
  saveSession();
}

// ── IPC ──────────────────────────────────────
function registerIpc() {
  ipcMain.handle("mv:poll", () => pollOnce());

  ipcMain.handle("mv:cmd", (_e, name, arg) => {
    if (typeof name !== "string") return null;
    // ユーザーの操作(次曲/シーク/停止など)が来たらクロスフェードは中断して音量を戻す
    if (xfade && !["vol", "rate"].includes(name)) cancelXfade(`user cmd: ${name}`);
    if (name === "pause") userPauseAt = Date.now();
    if (name === "sleep-pause") sleepPauseAt = Date.now();
    if (name === "vol") desiredVol = Math.min(100, Math.max(0, Number(arg) || 0));
    if (name === "rate") desiredRate = Math.min(2, Math.max(0.25, Number(arg) || 1));
    return execCmd(name, arg);
  });

  ipcMain.handle("mv:set-xfade", (_e, sec) => {
    xfadeSec = [0, 3, 5, 8, 12].includes(Number(sec)) ? Number(sec) : 0;
    if (xfadeSec === 0) cancelXfade("xfade off");
    saveSession();
    return xfadeSec;
  });

  ipcMain.handle("mv:set-loop", (_e, on) => {
    loopOn = !!on;
    if (loopOn) cancelXfade("loop on");
    return loopOn;
  });

  ipcMain.handle("mv:set-eq", (_e, gains) => {
    eqGains = clampGains(gains);
    applyAudioTo(site);
    applyAudioTo(xfadeView);
    saveSession();
    return eqGains;
  });

  ipcMain.handle("mv:set-viz", (_e, on) => {
    vizOn = !!on;
    if (!vizOn) win?.webContents.send("mv:viz", null); // UIを止めるシグナル
    saveSession();
    return vizOn;
  });

  ipcMain.handle("mv:dc-id-get", async () => {
    try {
      return (await fs.readFile(path.join(DATA_DIR, "discord.id"), "utf8")).trim();
    } catch { return ""; }
  });

  ipcMain.handle("mv:dc-id-set", (_e, id) => {
    const clean = String(id ?? "").trim();
    discordClient?.close();
    discordClient = null;
    lastPresenceKey = "";
    if (clean && /^\d+$/.test(clean)) {
      fs.writeFile(path.join(DATA_DIR, "discord.id"), clean, "utf8").catch(() => {});
      discordClient = new DiscordPresence(clean, (...a) => console.log("musicview: discord", ...a));
      discordClient.start();
      return { ok: true, saved: true };
    }
    try { fs.rm(path.join(DATA_DIR, "discord.id"), { force: true }); } catch { /* 無視 */ }
    return { ok: true, saved: false };
  });

  ipcMain.handle("mv:navigate", (_e, url) => {
    if (typeof url !== "string" || !/^https:\/\/(www\.)?youtube\.com\//.test(url)) return false;
    ensureSite().webContents.loadURL(url);
    return true;
  });

  ipcMain.handle("mv:search", (_e, q) => {
    if (typeof q !== "string" || !q.trim()) return false;
    const id = extractVideoId(q);
    if (id) {
      // URL / 動画ID はそのまま再生ビューへ(再生中はクロスフェード)
      return transitionTo(watchUrl(id));
    }
    ensureBrowse().webContents.loadURL(searchUrl(q.trim()));
    extractSearchResults(q.trim()).catch(() => {});
    return true;
  });

  ipcMain.handle("mv:login", () => {
    ensureSite().webContents.loadURL("https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F");
    setMode("site");
    return true;
  });

  // 普段の Firefox / Floorp で成立済みの YouTube セッションを複製する。
  // Electron からの Google ログインは「安全ではないブラウザ」で蹴られるための別ルート
  ipcMain.handle("mv:import-cookies", () => importCookiesSafely());

  ipcMain.handle("mv:mix", () => {
    // lastSnap は poll 結果オブジェクト(実スナップショットは .snap 配下)
    const snap = lastSnap?.snap;
    const id = snap?.videoId;
    if (!id) return false;
    // 「この曲からミックス」= 今の流れを継続させるボタン。
    // キューの次の曲へクロスフェードするのが確実(シードURLを開くと同じ曲の最初から
    // 再生になってしまうため)。キューが無いときだけシードのミックス起動にフォールバック
    const nextId = queueNextId(snap);
    if (nextId && nextId !== id) return transitionTo(watchUrl(nextId));
    return transitionTo(mixUrl(id), { skipSeed: id });
  });

  ipcMain.handle("mv:open-rec", (_e, { id, mix }) => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return false;
    return transitionTo(mix ? mixUrl(id) : watchUrl(id));
  });

  ipcMain.handle("mv:set-mode", (_e, m) => {
    setMode(m);
    return mode;
  });

  ipcMain.handle("mv:get-mode", () => mode);

  ipcMain.handle("mv:shuffle-next", () => {
    const snap = lastSnap?.snap;
    if (!snap || !Array.isArray(snap.queue) || snap.queue.length < 2) return null;
    const cur = snap.videoId;
    if (!shuffleOrder || !shuffleOrder.includes(cur)) {
      shuffleOrder = shuffledOrder(normalizeQueue(snap), snap.qIdx);
    }
    const next = nextShuffled(shuffleOrder, cur);
    if (next) execCmd("load", next);
    return next;
  });

  ipcMain.handle("mv:prev", () => goPrev());
  ipcMain.handle("mv:next", () => goNext());

  // キュー操作(アプリ側オーバーライド)。並べ替えた順序が次曲選択と表示の両方に効く
  ipcMain.handle("mv:queue-reorder", (_e, ids) => queueReorderIds(ids));
  ipcMain.handle("mv:queue-remove", (_e, id) => queueRemoveId(id));
  ipcMain.handle("mv:queue-play-next", (_e, id) => queuePlayNextId(id));
  ipcMain.handle("mv:queue-clear", () => { queueOverride = null; return true; });

  // 診断レポートの書き出し(保存先はユーザーが選ぶ。保存後にフォルダを開く)
  ipcMain.handle("mv:diag-save", async () => {
    try {
      const text = await collectDiagnostics();
      const r = await dialog.showSaveDialog(win, {
        title: "診断レポートの保存",
        defaultPath: path.join(app.getPath("desktop"), `musicview-diag-${new Date().toISOString().slice(0, 10)}.txt`),
        filters: [{ name: "テキスト", extensions: ["txt"] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      await fs.writeFile(r.filePath, text, "utf8");
      shell.showItemInFolder(r.filePath);
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// ── ウィンドウ ────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 840,
    minHeight: 560,
    show: false,
    icon: path.join(ROOT, "assets", "icon.png"),
    backgroundColor: "#1e1e20",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, "electron", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // サイト表示中はこの窓がサイトビューに覆われ「オクルード」扱いになる。
      // ここが間引かれると500msポーリング(自己回復/再生キック)が止まるため無効化
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(ROOT, "renderer", "index.html"));
  // アプリUI自体の調査用(音楽モード中にフォーカスがある側)。ドック表示で開く
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isF12 = input.key === "F12";
    const isCtrlShiftI = input.control && input.shift && !input.alt && input.key.toLowerCase() === "i";
    if (!isF12 && !isCtrlShiftI) return;
    event.preventDefault();
    const wwc = win.webContents;
    if (wwc.isDevToolsOpened()) wwc.closeDevTools();
    else wwc.openDevTools();
  });
  // preload や renderer の初動エラーは静かに死ぬと原因が見えないので、常にログへ出す
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    console.error("musicview: preload-error", path.basename(preloadPath), error.message);
  });
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 3) {
      noteDiagConsole("app-ui", message);
      console.error(`musicview: renderer[${path.basename(String(sourceId))}:${line}] ${String(message).slice(0, 200)}`);
    }
  });
  win.once("ready-to-show", () => win.show());
  win.on("resize", applyMode);
  win.on("maximize", applyMode);
  win.on("unmaximize", applyMode);
  win.on("close", () => {
    if (IS_ANY_PROBE) return; // 実プロファイルのセッションを probe で上書きしない
    saveSession();
    saveTitles();
  });
  win.on("closed", () => { win = null; });
}

// ビジュアライザー: 主役ビューの解析値をUIへ送る(約11fps、UI側で補間して描画)
function ensureVizPump() {
  if (vizPump) return;
  vizPump = setInterval(async () => {
    if (!vizOn || !site || site.webContents.isDestroyed()) return;
    try {
      const lv = await site.webContents.executeJavaScript(
        `(function () {
          if (!window.__mvCtl) return null;
          var s = window.__mvCtl.snap();
          return (s && (s.state === 1 || s.state === 3)) ? window.__mvCtl.levels(28) : null;
        })()`,
      );
      if (Array.isArray(lv)) win?.webContents.send("mv:viz", lv);
    } catch { /* 無視 */ }
  }, 90);
}
// ── 起動 ──────────────────────────────────────
app.whenReady().then(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await loadSession();
  await loadTitles();
  // セッション Cookie が無い初回起動では youtube を自動ロードしない。
  // 未ログインの youtube ページを生かしておくと、あとから Cookie を取り込んでも
  // そのページに消されるため(実走で確認済み)
  bootHasSession = (await session.fromPartition(PARTITION).cookies.get({}))
    .some(c => c.name === "SAPISID" || c.name === "__Secure-1PSID");
  xfadeSec = sessionData?.xfade ?? 0; // クロスフェード秒数は保存済み設定を引き継ぐ
  desiredVol = sessionData?.vol ?? 100;
  desiredRate = sessionData?.rate ?? 1;
  eqGains = sessionData?.eq ?? [0, 0, 0, 0, 0];
  vizOn = sessionData?.viz !== false;
  // Discord Rich Presence(data/discord.id にアプリケーションIDがあれば有効)
  try {
    const dcId = (await fs.readFile(path.join(DATA_DIR, "discord.id"), "utf8")).trim();
    if (/^\d+$/.test(dcId)) {
      discordClient = new DiscordPresence(dcId, (...a) => console.log("musicview: discord", ...a));
      discordClient.start();
    } else {
      console.log("musicview: discord presence disabled (no client id in data/discord.id)");
    }
  } catch { /* ファイル無し=無効 */ }
  eqGains = sessionData?.eq ?? [0, 0, 0, 0, 0];
  vizOn = sessionData?.viz !== false;
  registerIpc();
  // YouTube ドキュメント応答から CSP(Trusted Types 強制を含む)を外す。
  // Electron 環境だと YouTube の起動スクリプトが TT 違反の eval を踏み、
  // ポリマーの初期化が死んで骨格ページ(フィード/キューUIが空)になるため
  if (!ADBLOCK_OFF) {
    session.fromPartition(PARTITION).webRequest.onHeadersReceived(
      { urls: ["https://www.youtube.com/*"] },
      (details, callback) => {
        if (details.resourceType !== "mainFrame") return callback({});
        // responseHeaders は { 名前: [値, ...] } のオブジェクトマップ
        const headers = details.responseHeaders || {};
        const out = {};
        for (const name of Object.keys(headers)) {
          if (/^content-security-policy(-report-only)?$/i.test(name)) continue;
          out[name] = headers[name];
        }
        callback({ responseHeaders: out });
      },
    );
  }

  if (ADBLOCK_OFF) {
    console.log("musicview: adblock OFF (MUSICVIEW_NO_ADBLOCK=1)");
  } else {
    installAdblock(session.fromPartition(PARTITION));
    scheduleFilterLoad(); // 背景ロード(初回は DL に時間がかかる。失敗時も再試行する)
  }
  // Electron UAのままだとYouTubeのボット判定が動画データURLを403で拒否することが
  // あるため、実Chrome相当のUAに寄せる(Chromiumのバージョンは実値)
  try {
    const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
    session.fromPartition(PARTITION).setUserAgent(ua);
    console.log("musicview: ua override ->", ua.slice(0, 70));
  } catch (e) { console.error("musicview: ua override failed", e.message); }
  if (process.env.MUSICVIEW_NO_PRUNE === "1") {
    console.log("musicview: json-prune OFF (MUSICVIEW_NO_PRUNE=1)");
  }
  // 切り分け用: yt-preload(データ層の広告剥ぎ)を外して起動する
  if (process.env.MUSICVIEW_NO_PRELOAD === "1") {
    console.log("musicview: yt-preload OFF (MUSICVIEW_NO_PRELOAD=1)");
  }
  createWindow();
  if (sessionData || bootHasSession) ensureSite();
  applyMode();
  ensureVizPump();

  if (!IS_ANY_PROBE) {
    globalShortcut.register("MediaPlayPause", async () => {
      const s = await pollOnce();
      await execCmd(s?.snap?.state === 1 ? "pause" : "play");
    });
    globalShortcut.register("MediaNextTrack", () => goNext());
    globalShortcut.register("MediaPreviousTrack", () => goPrev());
  }

  if (!IS_ANY_PROBE) setInterval(() => { saveSession(); saveTitles(); }, 5000);

  // probe 群(probes.mjs)へ渡す橋渡し。probe は本体の状態に ctx 経由でだけ触れる
  const probes = makeProbes({
    DATA_DIR, PARTITION, TOPBAR_H,
    get site() { return site; },
    get win() { return win; },
    get browse() { return browse; },
    get xfade() { return xfade; },
    get vizOn() { return vizOn; },
    sessionUrl: () => sessionData?.url,
    setXfadeSec: (v) => { xfadeSec = v; },
    setEqGains: (g) => { eqGains = g; },
    ensureSite, ensureBrowse, setMode,
    pollOnce, execCmd, execSite, execOn, applyAudioTo,
    extractRecs, extractSearchResults, importCookiesSafely,
    diagReport: collectDiagnostics,
    blocked: () => blockedCount,
    blockedSamples: () => blockedSamples.slice(),
    queueReorder: queueReorderIds,
    queueRemove: queueRemoveId,
    queuePlayNext: queuePlayNextId,
    queueClear: () => { queueOverride = null; },
  });

  if (IS_PROBE) probes.runProbe().catch(e => { console.error("probe error:", e?.stack || e); app.exit(1); });
  if (IS_SPA_PROBE) probes.runProbeSpa().catch(e => { console.error("spa error:", e?.stack || e); app.exit(1); });

  // 調査用: メディアパイプラインとネットワークの詳細トレースを記録する。
  // --trace-media で起動し、止まりを再現したら F10 で保存(data/trace-media-*.json)。
  // 通常トレースに無い MediaLog(パイプライン状態/バッファ/エラー)を捕まえるのが目的
  if (argv.includes("--trace-media")) {
    const config = {
      included_categories: ["media", "benchmark", "devtools.timeline", "disabled-by-default-devtools.timeline"],
      record_mode: "record-continuously",
    };
    contentTracing.startRecording(config)
      .then(() => console.log("trace-media: recording started (F10 で保存)"))
      .catch(e => console.error("trace-media: start failed", e.message));
    const save = async () => {
      try {
        const out = path.join(DATA_DIR, `trace-media-${Date.now()}.json`);
        const p = await contentTracing.stopRecording(out);
        console.log("trace-media: saved", p);
      } catch (e) { console.error("trace-media: stop failed", e.message); }
    };
    globalShortcut.register("F10", save);
    if (process.env.MUSICVIEW_TRACE_STOP_MS) {
      setTimeout(save, Number(process.env.MUSICVIEW_TRACE_STOP_MS) || 15000);
    }
  }
  if (IS_IMPORT_PROBE) probes.runProbeImport().catch(e => { console.error("probe-import error:", e); app.exit(1); });
  if (IS_DESKTOP_PROBE) probes.runProbeDesktop().catch(e => { console.error("probe-desktop error:", e); app.exit(1); });
  if (argv.includes("--probe-xfade")) probes.runProbeXfade().catch(e => { console.error("probe-xfade error:", e); app.exit(1); });
  if (IS_AUDIO_PROBE) probes.runProbeAudio().catch(e => { console.error("probe-audio error:", e); app.exit(1); });
  if (IS_DISCORD_PROBE) {
    // 本体のシングルロックと無関係に接続テストだけを行う
    app.whenReady().then(() => probes.runProbeDiscord().catch(e => { console.error("probe-discord error:", e); app.exit(1); }));
    return;
  }
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => globalShortcut.unregisterAll());
