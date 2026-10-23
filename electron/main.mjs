// musicview — YouTube 動画を音楽として聴くことに特化したプレイヤー
// 実サイト(youtube.com)を WebContentsView で包み、音楽向けの操作面を上に重ねる。
// 広告は webRequest(EasyList エンジン)+ プレイヤー内スキップ + CSS 隠しの 3 段構え
import { app, BrowserWindow, WebContentsView, ipcMain, globalShortcut, session } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { extractVideoId, mixUrl, watchUrl, searchUrl, thumbUrl } from "../lib/urlutil.mjs";
import { normalizeQueue, shuffledOrder, nextShuffled } from "../lib/queue.mjs";
import { parseRecResults, parseDomItems, parseQueueItems, parseGenericItems } from "../lib/recs.mjs";
import { makeSnapshot, validateSnapshot } from "../lib/restore.mjs";
import { clampGains, isFlat } from "../lib/eq.mjs";
import { SITE_BOOTSTRAP, EXTRACT_ITEMS, AD_HIDE_CSS, VISIBILITY_PATCH } from "./inject.mjs";
import { importYoutubeCookies } from "./browser-import.mjs";
import { DiscordPresence } from "./discord.mjs";

const require = createRequire(import.meta.url);
const { AdblockEngine } = require("./adblock.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const SESSION_FILE = path.join(DATA_DIR, "session.json");
const TITLES_FILE = path.join(DATA_DIR, "titles.json");
const FILTERS_DIR = path.join(DATA_DIR, "filters");

const argv = process.argv;
// 本体起動中の検証用: userData を分離すればシングルロックに当たららず並行起動できる
if (process.env.MUSICVIEW_USER_DATA) {
  app.setPath("userData", path.join(os.tmpdir(), process.env.MUSICVIEW_USER_DATA));
}
const IS_PROBE = argv.includes("--probe");
// Cookie 取り込みの検証は本番パーティションに対して行う(そのままログイン済みになる)
const IS_IMPORT_PROBE = argv.includes("--probe-import");
// サイト表示時の実際の見た目(トップバーの可視性)をデスクトップごと撮って確認する
const IS_DESKTOP_PROBE = argv.includes("--probe-desktop");
const IS_XFADE_PROBE = argv.includes("--probe-xfade");
const IS_AUDIO_PROBE = argv.includes("--probe-audio");
const IS_DISCORD_PROBE = argv.includes("--probe-discord");
const IS_ANY_PROBE = IS_PROBE || IS_IMPORT_PROBE || IS_DESKTOP_PROBE || IS_XFADE_PROBE || IS_AUDIO_PROBE || IS_DISCORD_PROBE;
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
let playKickAt = 0;
let unstartedSince = 0;     // 広告詰まり等で unstarted が続いたときの自己回復用
let recoveryKey = null;
let recoveryTries = 0;
let weMutedForRecovery = false; // ミュート再生で始動したあと解除するためのフラグ
let lastQueueIds = null;    // プレイリストパネルから取ったキュー(getPlaylist が null のときの代役)
let bootHasSession = false; // 起動時にセッション Cookie があるか(無いなら youtube を自動ロードしない)

// 曲名キャッシュ(キュー表示用)。oEmbed で解決し data/titles.json に永続化
const titles = new Map();
let titlesDirty = false;
const titlesQueue = [];
let titlesFetching = 0;

// ── 広告ブロック(EasyList エンジン)──────────
const adblock = new AdblockEngine();
let adblockReady = false;

// EasyList が無い時間の保険(ドメイン単位)
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

const FILTER_SOURCES = [
  "https://easylist.to/easylist/easylist.txt",
  "https://raw.githubusercontent.com/k2jp/abp-japanese-filters/master/abpjf.txt",
];
// YouTube 自社の再生計測は通す(視聴履歴がブロックされるとミックスが育たなくなるため)。
// 広告配信系(pagead / doubleclick)はブロックのまま
const FILTER_ALLOW_PREFIX = `
@@||www.youtube.com/api/stats/$~third-party
@@||www.youtube.com/ptracking/$~third-party
@@||www.youtube.com/youtubei/$~third-party
`;
const FILTERS_MAX_AGE = 24 * 60 * 60 * 1000;

async function downloadFilters() {
  await fs.mkdir(FILTERS_DIR, { recursive: true });
  let combined = "";
  for (const url of FILTER_SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      combined += await res.text() + "\n";
    } catch (e) {
      console.error("musicview: filter download failed:", url.slice(0, 60), e.message);
    }
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
    }
    if (AD_URL_RE.test(url)) {
      blockedCount++;
      noteBlocked(url, "domain");
      callback({ cancel: true });
      return;
    }
    callback({});
  });
}

// ── サイトビュー ────────────────────────────────
// youtube.com を載せるビューの共通工場。主役(視聴)・検索・クロスフェード退避の
// 3 用途で同じ配線(注入/広告スキップ/Ctrl+M/新窓処理)を使い回す
function makeYouTubeView() {
  const v = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false, // 非表示でも広告スキップ等のタイマを止めない
      partition: PARTITION,
    },
  });
  v.setBackgroundColor("#0f0f0f");
  const wc = v.webContents;
  wc.on("dom-ready", () => injectInto(wc));
  // 主役ビューの遷移だけ曲追跡をリセットする(退避ビューの遷移では触れない)
  wc.on("did-navigate", () => { if (v === site) lastVideoId = null; });
  wc.on("did-navigate-in-page", () => { if (v === site) lastVideoId = null; });
  // サイト表示中はキーボードが YouTube 側に取られるため、Ctrl+M だけは横取りして
  // プレイヤー⇔サイトの切替に使う(YouTube 自体の操作は壊さない)
  wc.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.control && !input.alt && !input.shift
      && input.key.toLowerCase() === "m") {
      event.preventDefault();
      setMode(mode === "music" ? "site" : "music");
    }
  });
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
  try {
    await wc.executeJavaScript(VISIBILITY_PATCH + "\n" + SITE_BOOTSTRAP);
    await wc.insertCSS(AD_HIDE_CSS);
    // EQ/ビジュアライザーを使う設定のときはオーディオグラフを接続してゲインを反映
    if (!isFlat(eqGains) || vizOn) {
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
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      partition: PARTITION,
    },
  });
  browse.setBackgroundColor("#0f0f0f");
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
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
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

async function tickXfade() {
  if (xfadeSec <= 0 || loopOn || !site || site.webContents.isDestroyed()) return;
  const s = lastSnap;
  if (!s || !s.ok) return;
  const remain = s.snap.dur - s.snap.time;

  if (!xfade) {
    // 新規開始は主役が再生中のときだけ。
    // 深シークでフェード窓を飛ばされて曲が終わった場合は、ハードカットで次曲へ進む
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
  // 広告の進行中に読み直すと広告が最初からやり直しになり、待機が永久に終わらない
  if (st.ad) {
    if (Date.now() - xfade.lastKick > 800) {
      xfade.lastKick = Date.now();
      await execOn(xfadeView, `window.__mvCtl.cmd("play")`);
    }
    return;
  }

  // 未開始: プレイヤーミュート+再生を蹴り続け(ミュートなら自動再生が必ず通り、
  // 無音)、詰まっていたら読み直して再生開始をやり直す
  if (st.state === -1 || st.state === 5) {
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

// ── スナップショット(poll の実体)──────────────
async function pollOnce() {
  if (!site) return { ok: false, mode, blocked: blockedCount };
  let snap = await execSite("window.__mvCtl ? window.__mvCtl.snap() : null");
  if (!snap) {
    await injectInto(site.webContents);
    snap = await execSite("window.__mvCtl ? window.__mvCtl.snap() : null");
  }
  if (!snap || !snap.videoId) return { ok: false, mode, blocked: blockedCount };

  if (snap.videoId !== lastVideoId) {
    lastVideoId = snap.videoId;
    scheduleRecsExtract();
    // 遷移のたびにアプリ側の音量/速度を引き継ぐ(YouTube の記憶値に戻されるのを防ぐ。
    // 「この曲からミックス」等の遷移で音量が 100 に飛ぶ問題の修正)
    await execCmd("vol", desiredVol);
    await execCmd("rate", desiredRate);
  }

  // 回復でミュート再生した場合の解除(コンテンツが鳴り始めた時点で)
  if (weMutedForRecovery && snap.state === 1 && !snap.ad) {
    weMutedForRecovery = false;
    console.log("musicview: recovery unmute");
    await execCmd("unmute");
    await execCmd("vol", desiredVol);
  }

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

  // 非表示のサイトでは YouTube 側の判断で自動再生が始まらないことがあるため、
  // 未開始(unstarted -1 / cued 5)のままなら API で蹴る。ユーザーの任意停止(2)には触れない
  if (snap.state === -1 || snap.state === 5) {
    if (!unstartedSince) unstartedSince = Date.now();
    if (Date.now() - playKickAt > 2500) {
      playKickAt = Date.now();
      await execCmd("play");
    }
    // 広告ストリームの読み込み詰まりなどで立たない場合の自己回復。
    // ミュート再生なら自動再生が必ず通る(広告も無音でスキップされる)ことを利用し、
    // 同曲再読込 → ミュート再生 → 次曲読込 → 同曲再読込 の順で試す(動画あたり4回)
    if (Date.now() - unstartedSince > 8000 && recoveryTries < 4) {
      let target = null;
      try {
        target = new URL(site.webContents.getURL()).searchParams.get("v");
      } catch { /* 取れなければ諦める */ }
      if (target && /^[a-zA-Z0-9_-]{11}$/.test(target)) {
        if (recoveryKey !== target) { recoveryKey = target; recoveryTries = 0; }
        recoveryTries++;
        unstartedSince = Date.now();
        if (recoveryTries === 2) {
          weMutedForRecovery = true;
          console.log("musicview: recovery mute-play");
          await execSite(`(function(){var p=document.getElementById("movie_player");if(!p)return;try{p.mute();p.playVideo();}catch(e){}})()`);
        } else if (recoveryTries === 3) {
          const nid = queueNextId(snap);
          await execCmd("load", nid && nid !== target ? nid : target);
        } else {
          await execCmd("load", target);
        }
      } else {
        unstartedSince = Date.now();
      }
    }
  } else {
    unstartedSince = 0;
    if (snap.videoId !== recoveryKey) recoveryTries = 0;
  }

  resolveTitles(snap.queue ?? [snap.videoId]);

  // プレイヤー API にキューが無いときはプレイリストパネル抽出で代用する
  let queueEstimated = false;
  if (!Array.isArray(snap.queue) && Array.isArray(lastQueueIds) && lastQueueIds.length > 1) {
    snap.queue = lastQueueIds;
    snap.qIdx = lastQueueIds.indexOf(snap.videoId);
    queueEstimated = true;
  }

  // 復元設定(音量・速度)は desiredVol/desiredRate 経由で遷移ごとに当たるため個別処理は不要

  const q = normalizeQueue(snap);
  // 主役ビューがミュートのまま鳴らない事故の保険(クロスフェード交代パスの漏れ潰し)
  try {
    if (site.webContents.isAudioMuted()) {
      site.webContents.setAudioMuted(false);
      console.log("musicview: main view was muted, unmuted");
    }
  } catch { /* 無視 */ }
  const result = {
    ok: true,
    mode,
    blocked: blockedCount,
    ad: !!snap.ad,
    snap,
    queueEstimated,
    xfadeSec,
    loopOn,
    xfading: !!xfade,
    eq: eqGains,
    viz: vizOn,
    discord: discordClient?.connected ? "on" : (discordClient ? "off" : "no-id"),
    thumb: thumbUrl(snap.videoId, "maxres"),
    queueItems: q.map(id => ({ id, title: titles.get(id)?.title ?? null, author: titles.get(id)?.author ?? null })),
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
    },
  });
  win.loadFile(path.join(ROOT, "renderer", "index.html"));
  // preload や renderer の初動エラーは静かに死ぬと原因が見えないので、常にログへ出す
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    console.error("musicview: preload-error", path.basename(preloadPath), error.message);
  });
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 3) console.error(`musicview: renderer[${path.basename(String(sourceId))}:${line}] ${String(message).slice(0, 200)}`);
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

// ── probe(実走確認)────────────────────────────
async function probeShot(wc, file) {
  const img = await wc.capturePage();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, img.toPNG());
  console.log("probe: shot saved", file);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runProbe() {
  const log = (...a) => console.log("probe:", ...a);
  const TEST_VID = "dQw4w9WgXcQ";
  await sleep(1500);
  ensureSite();
  log("loading mix (hidden)", mixUrl(TEST_VID));
  site.webContents.loadURL(mixUrl(TEST_VID));

  // 可視性スプーフ+再生キックで非表示のまま流れ始めるかを観察
  let snap = null;
  for (let i = 0; i < 8; i++) {
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

  const recs = await extractRecs();
  log("watch recs:", recs.length, "first:", JSON.stringify(recs[0] ?? null));

  const searchQ = "ヨルシカ";
  ensureBrowse();
  browse.webContents.loadURL(searchUrl(searchQ));
  const sr = await extractSearchResults(searchQ);
  log("search results:", sr.length, "first:", JSON.stringify(sr[0] ?? null));
  // 検索中も再生が止まらないこと(別ビュー構成の根幹)を確認する
  const durSearch = await pollOnce();
  log("playback during search:", durSearch?.snap?.state, "time:", Math.round(durSearch?.snap?.time ?? -1));
  await sleep(1000);
  // 隠しビューは capturePage が空になるため、probe の間だけ可視化して撮る
  {
    const [w, h] = win.getContentSize();
    browse.setBounds({ x: 0, y: TOPBAR_H, width: w, height: Math.max(0, h - TOPBAR_H) });
    browse.setVisible(true);
    await sleep(800);
    await probeShot(browse.webContents, path.join(DATA_DIR, "probe", "probe-search.png"));
    browse.setVisible(false);
  }

  // 広告リクエストが止まっているか(サイト側コンテキストから promo ドメインを叩く)
  let adProbe = "fetch-failed";
  try {
    adProbe = await site.webContents.executeJavaScript(
      `fetch("https://securepubads.g.doubleclick.net/musicview-probe", { mode: "no-cors" }).then(() => "ad-NOT-blocked").catch(() => "ad-blocked")`,
    );
  } catch (e) { adProbe = "err:" + e.message; }
  log("adblock", adProbe, "blockedCount", blockedCount);
  for (const s of blockedSamples) log("blocked:", s);

  setMode("music");
  await sleep(1200);
  await probeShot(win.webContents, path.join(DATA_DIR, "probe", "probe-music.png"));

  setMode("site");
  await sleep(1500);
  await probeShot(site.webContents, path.join(DATA_DIR, "probe", "probe-site.png"));

  app.exit(0);
}

// Cookie 取り込みの実走確認: 実パーティションへ取り込み → ホームを開いてログイン面を確認。
// importCookiesSafely が既存クッキーを掃除してから入れるため、何度実行しても冪等
async function runProbeImport() {
  const log = (...a) => console.log("probe-import:", ...a);
  await sleep(1500);
  ensureSite();
  log("site UA:", site.webContents.getUserAgent());
  // ナビゲーション応答が運ぶ Set-Cookie(削除)を観測する(名前と削除フラグのみ)
  const deletions = [];
  const dbg = site.webContents.debugger;
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
  const res = await importCookiesSafely();
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
  await probeShot(site.webContents, path.join(DATA_DIR, "probe", "probe-import.png"));
  app.exit(0);
}

// サイト表示モードの実見(アプリのトップバーがちゃんと見えているか)をデスクトップごと撮る
async function runProbeDesktop() {
  const log = (...a) => console.log("probe-desktop:", ...a);
  const { desktopCapturer } = await import("electron");
  await sleep(2000);
  ensureSite();
  await site.webContents.loadURL("https://www.youtube.com/");
  await sleep(5000);
  await probeShot(win.webContents, path.join(DATA_DIR, "probe", "probe-ui.png")); // 音楽モードのUI
  setMode("site");
  await sleep(2500);
  // レンダラ側の状態が追従したか(ラベル不一致事故の再発チェック)
  try {
    const rstate = await win.webContents.executeJavaScript(
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
  site.webContents.loadURL(mixUrl("dQw4w9WgXcQ"));
  let s = null;
  for (let i = 0; i < 14; i++) {
    await sleep(2500);
    s = await pollOnce();
    if (s?.ok && s.snap.state === 1 && s.snap.dur > 0) break;
  }
  log("playing:", s?.snap?.videoId, "dur:", Math.round(s?.snap?.dur ?? 0));
  if (!s?.ok) { app.exit(1); return; }
  xfadeSec = 8;
  const seed = s.snap.videoId;
  await execCmd("seek", Math.max(1, s.snap.dur - 12));
  log("seeked to", Math.round(s.snap.dur - 12), "xfadeSec=8");
  let prevVid = seed;
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const r = await pollOnce();
    const vid = r?.snap?.videoId ?? "?";
    const phase = xfade ? xfade.phase : "idle";
    log(`t+${Math.round((i + 1) * 1.5)}s`, "phase:", phase, "videoId:", vid,
      "time:", Math.round(r?.snap?.time ?? -1), "mainVol:", Math.round(r?.snap?.vol ?? -1));
    if (prevVid !== "dQw4w9WgXcQ" && vid === prevVid && !xfade && i > 3) {
      log("xfade OK: swapped to next track,", "newVol:", Math.round(r?.snap?.vol ?? -1));
      // 手動遷移(ミックス起動)もクロスフェードに乗ることを確認する(実際のボタン経由)
      const beforeId = (await pollOnce())?.snap?.videoId;
      log("manual transition test: mix() click, current =", beforeId);
      const clicked = await win.webContents.executeJavaScript("window.musicview.mix()");
      log("mix() returned:", clicked);
      for (let j = 0; j < 45; j++) {
        await sleep(1500);
        const r2 = await pollOnce();
        const vid2 = r2?.snap?.videoId ?? "?";
        log(`manual t+${Math.round((j + 1) * 1.5)}s`, "phase:", xfade ? xfade.phase : "idle",
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
                "vol:", Math.round(r3?.snap?.vol ?? -1), "xfade:", xfade ? xfade.phase : "none");
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

// EQ/ビジュアライザーの実走確認: 再生中のページにオーディオグラフを接続し、
// ゲイン反映と解析値の流れを確認する
async function runProbeAudio() {
  const log = (...a) => console.log("probe-audio:", ...a);
  await sleep(1500);
  ensureSite();
  site.webContents.loadURL(watchUrl("dQw4w9WgXcQ"));
  let s = null;
  for (let i = 0; i < 14; i++) {
    await sleep(2500);
    s = await pollOnce();
    if (s?.ok && s.snap.state === 1 && s.snap.dur > 0) break;
  }
  log("playing:", s?.snap?.videoId, "state:", s?.snap?.state);
  if (!s?.ok) { app.exit(1); return; }
  eqGains = clampGains([12, 2, -2, 0, 2]);
  await applyAudioTo(site);
  await sleep(2500);
  const chk = await execOn(site, `JSON.stringify({
    has: !!window.__mvAudio,
    g0: window.__mvAudio ? window.__mvAudio.bands[0].gain.value : null,
    g2: window.__mvAudio ? window.__mvAudio.bands[2].gain.value : null,
    lv: window.__mvCtl ? window.__mvCtl.levels(8) : null
  })`);
  log("audio:", chk);
  const r = await pollOnce();
  log("viz:", vizOn, "pump-sent:", r?.ok, "levels-via-renderer:", "see-ui");
  setMode("music");
  await sleep(1500);
  await probeShot(win.webContents, path.join(DATA_DIR, "probe", "probe-audio.png"));
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
  if (ADBLOCK_OFF) {
    console.log("musicview: adblock OFF (MUSICVIEW_NO_ADBLOCK=1)");
  } else {
    installAdblock(session.fromPartition(PARTITION));
    loadFilters().catch(() => {}); // 背景ロード(初回は DL に時間がかかる)
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
    globalShortcut.register("MediaNextTrack", () => execCmd("next"));
    globalShortcut.register("MediaPreviousTrack", () => execCmd("prev"));
  }

  if (!IS_ANY_PROBE) setInterval(() => { saveSession(); saveTitles(); }, 5000);

  if (IS_PROBE) runProbe().catch(e => { console.error("probe error:", e); app.exit(1); });
  if (IS_IMPORT_PROBE) runProbeImport().catch(e => { console.error("probe-import error:", e); app.exit(1); });
  if (IS_DESKTOP_PROBE) runProbeDesktop().catch(e => { console.error("probe-desktop error:", e); app.exit(1); });
  if (argv.includes("--probe-xfade")) runProbeXfade().catch(e => { console.error("probe-xfade error:", e); app.exit(1); });
  if (IS_AUDIO_PROBE) runProbeAudio().catch(e => { console.error("probe-audio error:", e); app.exit(1); });
  if (IS_DISCORD_PROBE) {
    // 本体のシングルロックと無関係に接続テストだけを行う
    app.whenReady().then(() => runProbeDiscord().catch(e => { console.error("probe-discord error:", e); app.exit(1); }));
    return;
  }
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => globalShortcut.unregisterAll());
