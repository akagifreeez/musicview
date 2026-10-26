// 次曲(loadVideoById)が効かない退行の切り分け装置。
// 単独の Electron ウィンドウで watch ページを開き、再生開始後に loadVideoById を
// 打ち、プレイヤー状態・コンソールエラー・失敗リクエストを記録する。
//   node tools/diag-load.mjs [mode]
// mode: plain(素のまま) / prune(yt-preload付き) — 既定 plain
import { app, session, BrowserWindow, net } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "plain";
const A = "dQw4w9WgXcQ";           // 起点曲
const B = "1-xwxyHOyVw";           // 次曲候補(ミックス内の実在曲)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log("diag:", ...a);

app.whenReady().then(async () => {
  setTimeout(() => { log("WATCHDOG-TIMEOUT(100s)"); app.exit(2); }, 100_000).unref?.();
  const ses = session.fromPartition("diag-load");
  ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (d, cb) => {
    if (/youtubei\/v1\/player|videoplayback/.test(d.url)) log("req", d.resourceType, d.url.slice(0, 110));
    cb({});
  });
  const win = new BrowserWindow({
    width: 900, height: 700, show: true,
    webPreferences: {
      sandbox: false, contextIsolation: false, backgroundThrottling: false,
      partition: "diag-load",
      preload: mode === "prune" ? path.join(ROOT, "electron", "yt-preload.cjs") : undefined,
    },
  });
  const wc = win.webContents;
  wc.on("console-message", (_e, _l, m) => { if (/error|warn/i.test(m)) log("console:", String(m).slice(0, 160)); });

  log("mode:", mode, "loading watch", A);
  await wc.loadURL(`https://www.youtube.com/watch?v=${A}&list=RD${A}&start_radio=1`);
  await wc.executeJavaScript(`
    try {
      Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
      Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    } catch (e) {}
  `).catch(() => {});

  const snap = () => wc.executeJavaScript(`(() => {
    var el = document.getElementById("movie_player");
    var v = document.querySelector("video.html5-main-video");
    if (!el) return { err: "no-player" };
    try { return { vid: el.getVideoData && el.getVideoData().video_id, state: el.getPlayerState(), t: el.getCurrentTime(), paused: v ? v.paused : null, src: v ? (v.currentSrc || "").slice(0, 80) : null }; } catch (e) { return { err: String(e) }; }
  })()`).catch(e => ({ err: String(e).slice(0, 100) }));

  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    if (i === 2) { await wc.executeJavaScript(`try { document.getElementById("movie_player").playVideo(); } catch (e) {}`).catch(() => {}); }
    const s = await snap();
    log(`t=${i + 1}s`, JSON.stringify(s));
    if (s.vid === A && s.state === 1 && s.t > 0.5) break;
  }
  const pre = await snap();
  if (pre.vid !== A) { log("ABORT: 起点曲が鳴っていない", JSON.stringify(pre)); app.exit(1); return; }

  log(">>> loadVideoById", B);
  const r = await wc.executeJavaScript(`(() => {
    var el = document.getElementById("movie_player");
    try { el.loadVideoById("${B}"); return "called"; } catch (e) { return "throw:" + String(e).slice(0, 120); }
  })()`).catch(e => "exec-err:" + String(e).slice(0, 120));
  log("loadVideoById ->", r);

  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    const s = await snap();
    log(`t=${i + 1}s`, JSON.stringify(s));
    if (s.vid === B && s.state === 1) { log("RESULT: SWAPPED-OK"); break; }
    if (i === 11) log("RESULT: NOT-SWAPPED");
  }
  await sleep(1500);
  app.exit(0);
});
