"use strict";
// YouTube ビュー用 document-start プリロード(main world / contextIsolation:false)。
// 広告をネットワーク遮断ではなくデータ層で外す第0層:
//   1) watch ページに HTML 埋め込みの ytInitialPlayerResponse を代入時にフックして剥ぐ
//   2) SPA 遷移が取得する /youtubei/v1/player の応答を fetch / XHR の両経路で剥ぐ
// 剥げなかった広告の後段は SITE_BOOTSTRAP の skipTick と adblock.cjs(CSS+遮断)が担う。
// 統計は window.__mvPrune に置き、probe から実走確認できるようにする
const { prunePlayerResponse } = require("../lib/ytprune.cjs");

const stats = { inline: 0, fetch: 0, xhr: 0 };
try { window.__mvPrune = stats; } catch (e) {}

// 1) HTML 埋め込みのプレイヤーレスポンス(ページスクリプトの代入より先に罠を張る)
try {
  let yipr;
  Object.defineProperty(window, "ytInitialPlayerResponse", {
    configurable: true,
    get: function () { return yipr; },
    set: function (v) {
      try {
        if (prunePlayerResponse(v) > 0) stats.inline++;
      } catch (e) {}
      yipr = v;
    },
  });
} catch (e) {}

// 2a) fetch 経路。プレイヤーへの応答だけ差し替え、それ以外は素通し
try {
  const of = window.fetch;
  if (typeof of === "function") {
    window.fetch = function () {
      const args = arguments;
      let url = "";
      try {
        url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      } catch (e) {}
      const p = of.apply(this, args);
      if (String(url).indexOf("/youtubei/v1/player") === -1) return p;
      return p.then(function (res) {
        try {
          return res.clone().json().then(function (j) {
            try { stats.fetch += prunePlayerResponse(j); } catch (e) {}
            return new Response(JSON.stringify(j), {
              status: res.status,
              statusText: res.statusText,
              headers: { "content-type": "application/json" },
            });
          }).catch(function () { return res; });
        } catch (e) { return res; }
      });
    };
  }
} catch (e) {}

// 2b) XHR 経路。polymer はこちらを使うことがある。応答テキストを剥ぎ結果で差し替える
try {
  const OO = XMLHttpRequest.prototype.open;
  const OS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { this.__mvUrl = String(u || ""); } catch (e) {}
    return OO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    try {
      if (xhr.__mvUrl && xhr.__mvUrl.indexOf("/youtubei/v1/player") !== -1) {
        xhr.addEventListener("readystatechange", function () {
          try {
            if (xhr.readyState !== 4) return;
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
          } catch (e) {}
        });
      }
    } catch (e) {}
    return OS.apply(this, arguments);
  };
} catch (e) {}
