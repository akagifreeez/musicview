// 再生異常の判定器(純ロジック・副作用なし)。
// main 側は stepRecovery に実況(スナップ/URL/内部状態)を渡し、返ってきた
// アクション配列を順に実行するだけ。判定のしきい値はすべてここに集約される。
//
// 回復の強度序列(軽→重):
//   play-kick(再生キック)
//   < stall-reacquire(位置保持ストリーム再取得)
//   < nav-force-load / unstarted-load(loadVideoById 強制投入)
//   < nav-full-reload / stall-page-reload / self-heal-reload(ページ再読込)
//   < unstarted-mute-play(ミュート再生=最終手段。自動再生が必ず通る)
//
// 1 回の poll で発火する「重い回復」は 1 つだけ(nav > unstarted > stall > end-advance
// の優先順)。相互干渉で回復同士が打ち合う事故を構造的に防ぐ。軽いもの
// (recovery-unmute / unmute-main / play-kick / nav-play)は重い回復と併用できる。
//
// 構造上の約束: 状態(監視カウンタ)の更新はどのパスでも常に実行する。
// 発火を早抜けすると監視が1poll分欠落し、停滞誤検知などの種になる

export function createRecoveryState() {
  return {
    // poll 無応答(スナップが取れない)の監視
    pollFailSince: 0,
    // 再生位置の停滞監視(15 秒停滞でストリーム取り直し)
    stallSince: 0,
    stallCount: 0,
    stallLastTime: -1,
    lastVideoId: null,
    // 未開始(unstarted)の監視と段階的回復
    unstartedSince: 0,
    playKickAt: 0,
    recoveryKey: null,
    recoveryTries: 0,
    weMutedForRecovery: false,
    // 画面内遷移後の強制投入(post-nav kick)
    navAt: 0,
    navKickAt: 0,
    // 骨格ページ(ポリマー起動失敗)自動リロードの回数(ビュー id ごと)
    skeletonReloads: new Map(),
    // 回復履歴(診断レポートの材料・直近 200 件)
    events: [],
  };
}

// 回復イベントを記録する(リング 200 件)。診断レポートの唯一の供給源なので、
// すべての重い回復と解除系はここを通る
export function recordEvent(st, at, kind, level, detail) {
  st.events.push({ at, kind, level, detail: detail ?? "" });
  if (st.events.length > 200) st.events.shift();
}

// 診断レポート用の日本語ラベル(判定器とセットの知識)
export const RECOVERY_KIND_JA = {
  "self-heal-reload": "無応答→ページ再読込",
  "skeleton-reload": "骨格ページ→再読込",
  "recovery-unmute": "回復ミュートの解除",
  "unmute-main": "主役ミュート解除(安全網)",
  "nav-force-load": "遷移後の強制投入(単体)",
  "nav-force-loadlist": "遷移後の強制投入(list再接続)",
  "nav-full-reload": "遷移後の骨格→ページ再読込",
  "unstarted-load": "未開始→同曲再読込",
  "unstarted-load-next": "未開始→次曲読込",
  "unstarted-mute-play": "未開始→ミュート再生",
  "stall-reacquire": "停滞→ストリーム再取得",
  "stall-page-reload": "停滞→ページ再取得",
  "end-advance": "曲末→自動進行",
};

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

// main 側が骨格判定(executeJavaScript)を取りに行くべきかどうか。
// 遷移直後の 90 秒窓で URL の動画とプレイヤーが食い違い、キックのクールダウン
// (4 秒)が空いたときだけ判定コストを払う
export function needsPageCheck(st, input) {
  return st.navAt > 0 && input.now - st.navAt < 90000
    && !!input.urlVideoId && input.urlVideoId !== input.videoId
    && input.now - st.navKickAt > 4000;
}

// 遷移直後の強制投入でリスト再接続できる URL の list 引数
function isAttachableList(list) {
  return typeof list === "string" && /^(RD|PL|OL|UL|FL|LL)/.test(list);
}

// 実況 1 回分を評価し、実行すべきアクション配列を返す。
// input = {
//   now, isProbe,
//   snapOk, snap: { videoId, state, time, dur, ad } | null,
//   url, urlLoading, mainMuted,
//   urlVideoId, urlList, pageOk,   // pageOk は骨格判定(null=未判定・遷移不一致時のみ main が取る)
//   xfadeOff, loopOn, xfadeCooldownActive,
//   nextId,                        // queueNextId の結果(main 側で計算)
// }
// 戻り値 = { actions: [...], state(同一オブジェクトを更新) }
export function stepRecovery(st, input) {
  const out = { actions: [] };
  const now = input.now;

  // スナップが取れない=レンダラー無応答。15 秒続いたら同じ URL を作り直す
  if (!input.snapOk) {
    if (!st.pollFailSince) {
      st.pollFailSince = now;
      return out;
    }
    if (now - st.pollFailSince > 15000 && !input.isProbe
      && input.url && input.url !== "about:blank" && !input.urlLoading) {
      st.pollFailSince = 0;
      recordEvent(st, now, "self-heal-reload", 2, String(input.url).slice(0, 80));
      out.actions.push({ kind: "self-heal-reload", url: input.url });
    }
    return out;
  }
  st.pollFailSince = 0;

  const snap = input.snap;

  // 回復のミュート再生で始動したあとの解除(コンテンツが鳴り始めた時点)
  if (st.weMutedForRecovery && snap.state === 1 && !snap.ad) {
    st.weMutedForRecovery = false;
    recordEvent(st, now, "recovery-unmute", 1, snap.videoId);
    out.actions.push({ kind: "recovery-unmute" });
  }

  // 主役ビューが Electron レベルでミュートのままの保険(交代パスの漏れ潰し)
  if (input.mainMuted) out.actions.push({ kind: "unmute-main" });

  let heavy = null;
  let navPlay = null;

  const navWindow = st.navAt > 0 && now - st.navAt < 90000;
  const navMismatch = navWindow && !!input.urlVideoId && input.urlVideoId !== snap.videoId;
  const navKickReady = now - st.navKickAt > 4000;
  const endReady = input.xfadeOff && !input.loopOn && snap.state === 0 && !input.xfadeCooldownActive;

  // 1. 遷移直後で URL の動画とプレイヤーが食い違い=SPA 交換が発火していない。
  //    骨格ページならページごと作り直し、健全ならメディアだけ交換(list 再接続)
  if (navMismatch && navKickReady && input.pageOk !== undefined && input.pageOk !== null) {
    st.navKickAt = now;
    if (input.pageOk !== true) {
      recordEvent(st, now, "nav-full-reload", 2, input.urlVideoId);
      heavy = { kind: "nav-full-reload", url: input.url };
    } else if (isAttachableList(input.urlList)) {
      recordEvent(st, now, "nav-force-loadlist", 1, `${input.urlVideoId} list=${String(input.urlList).slice(0, 24)}`);
      heavy = { kind: "nav-force-loadlist", videoId: input.urlVideoId, list: input.urlList };
    } else {
      recordEvent(st, now, "nav-force-load", 1, `${input.urlVideoId} (stuck on ${snap.videoId})`);
      heavy = { kind: "nav-force-load", videoId: input.urlVideoId };
    }
    // 遷移直後に旧曲の一時停止位置にいるケースは、投入後に再生も蹴る
    if (snap.state === 2) navPlay = { kind: "nav-play" };
  }

  // 2. 未開始(-1/5)のまま: まず 2.5 秒間隔の再生キック。8 秒立つなら段階的回復。
  //    動画あたり最大 4 回(同曲再読込→ミュート再生→次曲→同曲再読込)
  if (snap.state === -1 || snap.state === 5) {
    if (!st.unstartedSince) st.unstartedSince = now;
    if (now - st.playKickAt > 2500) {
      st.playKickAt = now;
      out.actions.push({ kind: "play-kick" });
    }
    if (!heavy && now - st.unstartedSince > 8000 && st.recoveryTries < 4
      && input.urlVideoId && ID_RE.test(input.urlVideoId)) {
      if (st.recoveryKey !== input.urlVideoId) {
        st.recoveryKey = input.urlVideoId;
        st.recoveryTries = 0;
      }
      st.recoveryTries++;
      st.unstartedSince = now;
      if (st.recoveryTries === 2) {
        st.weMutedForRecovery = true;
        recordEvent(st, now, "unstarted-mute-play", 2, input.urlVideoId);
        heavy = { kind: "unstarted-mute-play", videoId: input.urlVideoId };
      } else if (st.recoveryTries === 3) {
        const nid = input.nextId;
        const target = nid && nid !== input.urlVideoId ? nid : input.urlVideoId;
        recordEvent(st, now, "unstarted-load-next", 1, target);
        heavy = { kind: "unstarted-load", videoId: target };
      } else {
        recordEvent(st, now, "unstarted-load", 1, `${input.urlVideoId} try${st.recoveryTries}`);
        heavy = { kind: "unstarted-load", videoId: input.urlVideoId };
      }
    }
  } else {
    st.unstartedSince = 0;
    if (snap.videoId !== st.recoveryKey) st.recoveryTries = 0;
  }

  // 3. 再生/バッファ中に位置が 15 秒停滞=SABR 初手の空振り等。
  //    位置を保持してストリームを取り直し、2 回だめならページを作り直す。
  //    一時停止(2)は停滞が正常なので対象外。
  //    停滞カウンタは曲が変わるまで保持する(1 回でも位置が動くとゼロに戻すと
  //    ページ再取得への格上げが到達不能になるため)
  if (snap.videoId !== st.lastVideoId) {
    st.lastVideoId = snap.videoId;
    st.stallSince = 0;
    st.stallCount = 0;
    st.stallLastTime = -1;
  }
  if (snap.state === 1 || snap.state === 3) {
    const t = Number(snap.time) || 0;
    if (Math.abs(t - st.stallLastTime) < 0.5) {
      if (!st.stallSince) {
        st.stallSince = now;
      } else if (now - st.stallSince > 15000 && !heavy) {
        st.stallSince = now;
        if (st.stallCount < 2) {
          st.stallCount++;
          st.stallLastTime = -1;
          recordEvent(st, now, "stall-reacquire", 1, `${snap.videoId} @${Math.round(t)} try${st.stallCount}`);
          heavy = { kind: "stall-reacquire", videoId: snap.videoId, seekTo: t, tryN: st.stallCount };
        } else {
          st.stallCount = 0;
          recordEvent(st, now, "stall-page-reload", 2, snap.videoId);
          heavy = { kind: "stall-page-reload", url: input.url };
        }
      }
    } else {
      st.stallSince = 0;
      st.stallLastTime = t;
    }
  } else {
    st.stallSince = 0;
    st.stallLastTime = -1;
  }

  // 4. 曲末の自動進行(クロスフェード OFF 時の安全網)。loadVideoById はプレイリストを
  //    切り離すため、ネイティブ自動進行が働かないケースを拾う。キューの全ソースが
  //    空でもラジオ継続で停止させない
  if (endReady && !heavy) {
    const nextId = input.nextId;
    const queued = !!(nextId && nextId !== snap.videoId);
    const target = queued ? nextId : snap.videoId;
    if (target) {
      recordEvent(st, now, "end-advance", 1, `${target}${queued ? "" : " (radio fallback)"}`);
      heavy = { kind: "end-advance", videoId: target, queued };
    }
  }

  if (heavy) out.actions.push(heavy);
  // 投入(nav-force-load 系)のあとに続けて実行する追従キック
  if (navPlay) out.actions.push(navPlay);
  return out;
}
