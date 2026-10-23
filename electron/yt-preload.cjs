"use strict";
// YouTube ビュー用 document-start プリロード(main world / contextIsolation:false)。
// 広告をネットワーク遮断ではなくデータ層で外す第0層:
//   1) watch ページに HTML 埋め込みの ytInitialPlayerResponse を代入時にフックして剥ぐ
//   2) JSON.parse をフックし、プレイヤーレスポンスのルートに広告キーが現れた時点で剥ぐ
//      (fetch/XHR の応答は一切書き換えない。応答オブジェクトの再構築は YouTube 側の
//       消費で失敗する事故(SPA遷移でプレイヤーが交換されない)を起こしたため廃止)
// 剥げなかった広告の後段は SITE_BOOTSTRAP の skipTick と adblock.cjs(CSS+遮断)が担う。
// 統計は window.__mvPrune に置き、probe から実走確認できるようにする。
// 配線は installHooks(差し込み先)に括り出してあり、Node のテストからも同じ経路を
// 回帰テストできる(実機でしか起きないバグをここで潰す)
const { prunePlayerResponse } = require("../lib/ytprune.cjs");

function installHooks(env) {
  const win = env.window;
  const XHR = env.XMLHttpRequest;
  const stats = { inline: 0, parse: 0, err: 0 };
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

  // 2) JSON.parse 経路。応答オブジェクトには触れず、パース結果のルートだけを見る。
  // fetch/XHR どちらで取得しても最終的に JSON.parse を通るため、応答の差し替えより
  // 透過的(失敗モードが存在しない)
  try {
    const op = win.JSON.parse;
    if (typeof op === "function") {
      const hooked = function (text, reviver) {
        const obj = op.call(win.JSON, text, reviver);
        try {
          if (obj && typeof obj === "object" && !Array.isArray(obj)
            && (obj.adPlacements !== undefined || obj.playerAds !== undefined || obj.adSlots !== undefined)) {
            stats.parse += prunePlayerResponse(obj);
          }
        } catch (e) { stats.err++; }
        return obj;
      };
      try { Object.defineProperty(hooked, "name", { value: "parse" }); } catch (e) {}
      win.JSON.parse = hooked;
    }
  } catch (e) { stats.err++; }

  // 3) XHR 経路はフックしない。テキスト応答ならページ側が JSON.parse で解くため 2) が
  // 賄い、responseType:"json" の内部パースは届かないがその場合は後段(skipTick)へ委ねる。
  // 応答オブジェクト/アクセサに触れるコードを持たないことが重要(過去に XHR の
  // 実インスタンスへ影を定義して使い回し時に応答を腐らせた事故がある)
  void XHR;

  return stats;
}

if (typeof module !== "undefined" && module.exports && !(process.versions && process.versions.electron)) {
  // Node(テスト): 実配線は行わず、差し込み口だけ公開する
  module.exports = { installHooks: installHooks };
} else {
  // Electron preload: 実環境へ差し込む
  installHooks({ window: window, XMLHttpRequest: XMLHttpRequest });
}
