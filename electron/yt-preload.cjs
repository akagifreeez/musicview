"use strict";
// YouTube ビュー用 document-start プリロード(main world / contextIsolation:false)。
// 広告をネットワーク遮断ではなくデータ層で外す第0層:
//   1) watch ページに HTML 埋め込みの ytInitialPlayerResponse を代入時にフックして剥ぐ
//   2) SPA 遷移が取得する /youtubei/v1/player の応答を fetch / XHR の両経路で剥ぐ
// 剥げなかった広告の後段は SITE_BOOTSTRAP の skipTick と adblock.cjs(CSS+遮断)が担う。
// 統計は window.__mvPrune に置き、probe から実走確認できるようにする。
// 配線は installHooks(差し込み先)に括り出してあり、Node のテストからも同じ経路を
// 回帰テストできる(実機でしか起きないバグをここで潰す)
const { prunePlayerResponse } = require("../lib/ytprune.cjs");

function installHooks(env) {
  const win = env.window;
  const XHR = env.XMLHttpRequest;
  const ResCtor = env.Response;
  const stats = { inline: 0, fetch: 0, xhr: 0, err: 0 };
  try { win.__mvPrune = stats; } catch (e) {}

  // contextIsolation:false のとき Electron の Node 由来グローバルがページに漏れる。
  // サイト側の環境判定(typeof process 等)を曲げて読み込みが止まる事故の種になるため、
  // 元のページと同じ「無い」状態へ戻す
  try { delete win.process; } catch (e) {}
  try { delete win.Buffer; } catch (e) {}
  try { delete win.global; } catch (e) {}
  try { delete win.setImmediate; } catch (e) {}
  try { delete win.clearImmediate; } catch (e) {}

  // 1) HTML 埋め込みのプレイヤーレスポンス(ページスクリプトの代入より先に罠を張る)
  try {
    let yipr;
    Object.defineProperty(win, "ytInitialPlayerResponse", {
      configurable: true,
      get: function () { return yipr; },
      set: function (v) {
        try {
          if (prunePlayerResponse(v) > 0) stats.inline++;
        } catch (e) { stats.err++; }
        yipr = v;
      },
    });
  } catch (e) { stats.err++; }

  // 2a) fetch 経路。プレイヤーへの応答だけ差し替え、それ以外は素通し
  try {
    const of = win.fetch;
    if (typeof of === "function") {
      win.fetch = function () {
        let url = "";
        try {
          url = typeof arguments[0] === "string" ? arguments[0] : (arguments[0] && arguments[0].url) || "";
        } catch (e) {}
        const p = of.apply(this, arguments);
        if (String(url).indexOf("/youtubei/v1/player") === -1) return p;
        return p.then(function (res) {
          try {
            return res.clone().json().then(function (j) {
              try { stats.fetch += prunePlayerResponse(j); } catch (e) { stats.err++; }
              // ヘッダは元の応答のものをそのまま引き継ぐ(欠落がサイト側の判定を曲げないように)
              return new ResCtor(JSON.stringify(j), {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
              });
            }).catch(function () { return res; });
          } catch (e) { stats.err++; return res; }
        });
      };
    }
  } catch (e) { stats.err++; }

  // 2b) XHR 経路。polymer はこちらを使うことがある。
  // 応答は読み取り専用アクセサなので、剥げた内容で実インスタンスに影(シャドウ)を
  // 定義して差し替える。**影は次の open() で必ず落とす**——残したままだと使い回した
  // XHR が古い応答を読み続け、クリック後のプレイヤー情報取得が腐って止まる
  try {
    const OO = XHR.prototype.open;
    const OS = XHR.prototype.send;
    XHR.prototype.open = function (m, u) {
      try {
        this.__mvUrl = String(u || "");
        delete this.responseText;
        delete this.response;
      } catch (e) {}
      return OO.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      const xhr = this;
      try {
        if (!xhr.__mvHooked && xhr.__mvUrl && xhr.__mvUrl.indexOf("/youtubei/v1/player") !== -1) {
          xhr.__mvHooked = true; // リスナの二重登録を防ぐ(再利用時も1本)
          xhr.addEventListener("readystatechange", function () {
            try {
              if (xhr.readyState !== 4) return;
              if (!xhr.__mvUrl || xhr.__mvUrl.indexOf("/youtubei/v1/player") === -1) return;
              let j = null;
              if (xhr.responseType === "json") j = xhr.response;
              else if (!xhr.responseType || xhr.responseType === "text") j = JSON.parse(xhr.responseText);
              else return;
              if (!j) return;
              if (prunePlayerResponse(j) > 0) {
                stats.xhr++;
                const text = JSON.stringify(j);
                Object.defineProperty(xhr, "responseText", { value: text, configurable: true });
                Object.defineProperty(xhr, "response", {
                  value: xhr.responseType === "json" ? j : text,
                  configurable: true,
                });
              }
            } catch (e) { stats.err++; }
          });
        }
      } catch (e) {}
      return OS.apply(this, arguments);
    };
  } catch (e) { stats.err++; }

  return stats;
}

if (typeof module !== "undefined" && module.exports && !(process.versions && process.versions.electron)) {
  // Node(テスト): 実配線は行わず、差し込み口だけ公開する
  module.exports = { installHooks: installHooks };
} else {
  // Electron preload: 実環境へ差し込む
  installHooks({ window: window, XMLHttpRequest: XMLHttpRequest, Response: Response });
}
