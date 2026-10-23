// 対照実験: パッチ無し(プリロード無し・広告遮断無し)の素のElectronで
// youtube.com ホームを開き、コンソールエラーとDOM成否を見る。
// TT(Trusted Types)違反が musicview の注入なしでも出るかを確かめるのが目的
"use strict";
const { app, BrowserWindow, WebContentsView } = require("electron");
const path = require("node:path");
const os = require("node:os");

if (process.env.MUSICVIEW_USER_DATA) {
  app.setPath("userData", path.join(os.tmpdir(), process.env.MUSICVIEW_USER_DATA));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 700, show: false });
  const v = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.contentView.addChildView(v);
  v.setBounds({ x: 0, y: 0, width: 1100, height: 700 });
  const wc = v.webContents;
  const log = (...a) => console.log("vanilla:", ...a);
  wc.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 3) log("console-err:", String(message).slice(0, 160), "@", String(sourceId || "").split("/").pop() + ":" + line);
  });
  wc.on("render-process-gone", (_e, d) => log("RENDERER-GONE:", JSON.stringify(d)));
  wc.loadURL("https://www.youtube.com/");
  await new Promise(r => setTimeout(r, 15000));
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
    return JSON.stringify({
      rich: deepAll("ytd-rich-item-renderer").length,
      lockup: deepAll("yt-lockup-view-model").length,
      video: !!document.querySelector("video.html5-main-video"),
      title: (document.title || "").slice(0, 40),
      href: location.href.slice(0, 80)
    });
  })()`);
  log("census:", census);
  app.exit(0);
});
