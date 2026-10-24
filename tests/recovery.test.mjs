import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryState, stepRecovery, recordEvent } from "../lib/recovery.mjs";

const VID = "dQw4w9WgXcQ";
const VID2 = "aaaaaaaaaaa";

// 実況の既定値(再生中の正常スナップ)
function okInput(over = {}) {
  return {
    now: 100000,
    isProbe: false,
    snapOk: true,
    snap: { videoId: VID, state: 1, time: 30, dur: 200, ad: false },
    url: `https://www.youtube.com/watch?v=${VID}`,
    urlLoading: false,
    mainMuted: false,
    urlVideoId: VID,
    urlList: null,
    pageOk: null,
    xfadeOff: true,
    loopOn: false,
    xfadeCooldownActive: false,
    nextId: null,
    ...over,
  };
}

const kinds = (r) => r.actions.map(a => a.kind);

test("snap 無し: 15 秒未満は何もしない、15 秒超で self-heal-reload", () => {
  const st = createRecoveryState();
  const r1 = stepRecovery(st, okInput({ snapOk: false, snap: null, now: 100000 }));
  assert.deepEqual(r1.actions, []);
  assert.equal(st.pollFailSince, 100000);
  // 未満は静か
  const r2 = stepRecovery(st, okInput({ snapOk: false, snap: null, now: 114000 }));
  assert.deepEqual(r2.actions, []);
  // 15 秒超で再読込
  const r3 = stepRecovery(st, okInput({ snapOk: false, snap: null, now: 116000 }));
  assert.deepEqual(kinds(r3), ["self-heal-reload"]);
  assert.equal(r3.actions[0].url.includes(VID), true);
  // 発火したらカウンタが戻る
  assert.equal(st.pollFailSince, 0);
  assert.equal(st.events.at(-1).kind, "self-heal-reload");
});

test("snap 無し: probe 実行では発火しない / about:blank・読込中でも発火しない", () => {
  const st = createRecoveryState();
  stepRecovery(st, okInput({ snapOk: false, snap: null, now: 100000, isProbe: true }));
  const r = stepRecovery(st, okInput({ snapOk: false, snap: null, now: 200000, isProbe: true }));
  assert.deepEqual(r.actions, []);
  const st2 = createRecoveryState();
  stepRecovery(st2, okInput({ snapOk: false, snap: null, now: 100000, url: "about:blank" }));
  const r2 = stepRecovery(st2, okInput({ snapOk: false, snap: null, now: 200000, url: "about:blank" }));
  assert.deepEqual(r2.actions, []);
  const st3 = createRecoveryState();
  stepRecovery(st3, okInput({ snapOk: false, snap: null, now: 100000, urlLoading: true }));
  const r3 = stepRecovery(st3, okInput({ snapOk: false, snap: null, now: 200000, urlLoading: true }));
  assert.deepEqual(r3.actions, []);
});

test("スナップ復帰で pollFailSince が戻る", () => {
  const st = createRecoveryState();
  stepRecovery(st, okInput({ snapOk: false, snap: null, now: 100000 }));
  stepRecovery(st, okInput({ snapOk: true, now: 101000 }));
  assert.equal(st.pollFailSince, 0);
});

test("回復ミュート再生の解除: 鳴り始めたら recovery-unmute", () => {
  const st = createRecoveryState();
  st.weMutedForRecovery = true;
  const r = stepRecovery(st, okInput());
  assert.deepEqual(kinds(r), ["recovery-unmute"]);
  assert.equal(st.weMutedForRecovery, false);
  // 広告中や未再生では解除しない
  st.weMutedForRecovery = true;
  const r2 = stepRecovery(st, okInput({ snap: { videoId: VID, state: 1, time: 10, dur: 200, ad: true } }));
  assert.deepEqual(kinds(r2), []);
  assert.equal(st.weMutedForRecovery, true);
});

test("主役ミュート漏れの安全網: unmute-main", () => {
  const st = createRecoveryState();
  const r = stepRecovery(st, okInput({ mainMuted: true }));
  assert.deepEqual(kinds(r), ["unmute-main"]);
});

test("post-nav: URL とプレイヤー不一致で list 再接続(loadlist)", () => {
  const st = createRecoveryState();
  st.navAt = 99000; // 遷移直後(90 秒窓内)
  const r = stepRecovery(st, okInput({
    url: `https://www.youtube.com/watch?v=${VID2}&list=RDeCaag`,
    urlVideoId: VID2, urlList: "RDeCaag", pageOk: true,
  }));
  assert.deepEqual(kinds(r), ["nav-force-loadlist"]);
  assert.deepEqual(r.actions[0], { kind: "nav-force-loadlist", videoId: VID2, list: "RDeCaag" });
  // クールダウン(4 秒)が効いている
  const r2 = stepRecovery(st, okInput({
    url: `https://www.youtube.com/watch?v=${VID2}&list=RDeCaag`,
    urlVideoId: VID2, urlList: "RDeCaag", pageOk: true, now: 101000,
  }));
  assert.deepEqual(r2.actions, []);
});

test("post-nav: list 無しは単体 load / 一時停止中なら nav-play が続く", () => {
  const st = createRecoveryState();
  st.navAt = 99000;
  const r = stepRecovery(st, okInput({ urlVideoId: VID2, pageOk: true }));
  assert.deepEqual(kinds(r), ["nav-force-load"]);
  assert.equal(r.actions[0].videoId, VID2);

  const st2 = createRecoveryState();
  st2.navAt = 99000;
  const r2 = stepRecovery(st2, okInput({
    urlVideoId: VID2, pageOk: true,
    snap: { videoId: VID, state: 2, time: 50, dur: 200, ad: false },
  }));
  assert.deepEqual(kinds(r2), ["nav-force-load", "nav-play"]);
});

test("post-nav: 骨格ページはページごと再読込", () => {
  const st = createRecoveryState();
  st.navAt = 99000;
  const r = stepRecovery(st, okInput({
    url: `https://www.youtube.com/watch?v=${VID2}`,
    urlVideoId: VID2, pageOk: false,
  }));
  assert.deepEqual(kinds(r), ["nav-full-reload"]);
  assert.equal(r.actions[0].url.includes(VID2), true);
});

test("post-nav: pageOk 未判定(null)では発火しない", () => {
  const st = createRecoveryState();
  st.navAt = 99000;
  const r = stepRecovery(st, okInput({ urlVideoId: VID2, pageOk: null }));
  assert.deepEqual(r.actions, []);
  // navKickAt は動いていない
  assert.equal(st.navKickAt, 0);
});

test("post-nav: 90 秒窓の外は発火しない", () => {
  const st = createRecoveryState();
  st.navAt = 9000; // now 100000 より 91 秒前
  const r = stepRecovery(st, okInput({ urlVideoId: VID2, pageOk: true }));
  assert.deepEqual(r.actions, []);
});

test("未開始: 8 秒未満は再生キックのみ", () => {
  const st = createRecoveryState();
  const r = stepRecovery(st, okInput({
    snap: { videoId: VID, state: -1, time: 0, dur: 0, ad: false },
    now: 100000,
  }));
  assert.deepEqual(kinds(r), ["play-kick"]);
  // キック間隔(2.5 秒)内は連発しない
  const r2 = stepRecovery(st, okInput({
    snap: { videoId: VID, state: -1, time: 0, dur: 0, ad: false },
    now: 101000,
  }));
  assert.deepEqual(r2.actions, []);
});

test("未開始: 段階的回復 8 秒後から 同曲 load → mute-play → 次曲 → 同曲 load、4 回で停止", () => {
  const st = createRecoveryState();
  const unstarted = (now) => stepRecovery(st, okInput({
    snap: { videoId: VID, state: -1, time: 0, dur: 0, ad: false },
    now,
  }));
  // 基準作り(unstartedSince を立てる)+ 10 秒ごとに 1 段階進む(8 秒超が発火条件)。
  // play-kick は 2.5 秒間隔で付くので、段階の判定は除外して行う
  unstarted(100000);
  const r1 = unstarted(110000);
  assert.deepEqual(kinds(r1).filter(k => k !== "play-kick"), ["unstarted-load"]);
  assert.equal(r1.actions.find(a => a.kind === "unstarted-load").videoId, VID);
  const r2 = unstarted(120000);
  assert.deepEqual(kinds(r2).filter(k => k !== "play-kick"), ["unstarted-mute-play"]);
  assert.equal(st.weMutedForRecovery, true);
  const r3 = unstarted(130000);
  assert.deepEqual(kinds(r3).filter(k => k !== "play-kick"), ["unstarted-load"]);
  assert.equal(r3.actions.find(a => a.kind === "unstarted-load").videoId, VID); // nextId が無いので同曲
  const r4 = unstarted(140000);
  assert.deepEqual(kinds(r4).filter(k => k !== "play-kick"), ["unstarted-load"]);
  const r5 = unstarted(150000);
  assert.deepEqual(kinds(r5).filter(k => k !== "play-kick"), []); // 4 回使い切った
});

test("未開始: 3 段階目は次曲へ飛ぶ(nextId が有効なとき)", () => {
  const st = createRecoveryState();
  const unstarted = (now) => stepRecovery(st, okInput({
    snap: { videoId: VID, state: -1, time: 0, dur: 0, ad: false },
    now, nextId: VID2,
  }));
  unstarted(100000);
  unstarted(110000);
  unstarted(120000);
  const r3 = unstarted(130000);
  assert.deepEqual(kinds(r3).filter(k => k !== "play-kick"), ["unstarted-load"]);
  assert.equal(r3.actions.find(a => a.kind === "unstarted-load").videoId, VID2);
});

test("未開始: 別の動画に変わったら回復カウンタが戻る", () => {
  const st = createRecoveryState();
  const unstarted = (now, vid = VID) => stepRecovery(st, okInput({
    snap: { videoId: vid, state: -1, time: 0, dur: 0, ad: false },
    now, urlVideoId: vid, url: `https://www.youtube.com/watch?v=${vid}`,
  }));
  unstarted(100000); // 基準作り
  unstarted(110000); // try1
  assert.equal(st.recoveryTries, 1);
  const r = unstarted(150000, VID2); // 別動画(40 秒後・key 不一致で tries リセット後に try1)
  assert.deepEqual(kinds(r).filter(k => k !== "play-kick"), ["unstarted-load"]);
  assert.equal(r.actions.find(a => a.kind === "unstarted-load").videoId, VID2);
  assert.equal(st.recoveryTries, 1);
});

test("未開始: 回復が済めば unstartedSince と recoveryTries が戻る", () => {
  const st = createRecoveryState();
  stepRecovery(st, okInput({
    snap: { videoId: VID, state: -1, time: 0, dur: 0, ad: false }, now: 100000,
  }));
  assert.equal(st.unstartedSince, 100000);
  stepRecovery(st, okInput({ now: 101000 })); // state 1 に復帰
  assert.equal(st.unstartedSince, 0);
});

test("停滞: 15 秒動かなければ位置保持でストリーム再取得(seek 位置を保持)", () => {
  const st = createRecoveryState();
  const frozen = (now) => stepRecovery(st, okInput({
    snap: { videoId: VID, state: 1, time: 120, dur: 200, ad: false }, now,
  }));
  const r1 = frozen(100000); // 初回は位置の基準を作るだけ
  assert.deepEqual(r1.actions, []);
  assert.equal(st.stallSince, 0);
  assert.equal(st.stallLastTime, 120);
  const r2 = frozen(102000); // 同位置で停滞検知が立つ
  assert.deepEqual(r2.actions, []);
  assert.equal(st.stallSince, 102000);
  const r3 = frozen(118000); // 16 秒停滞で発火
  assert.deepEqual(kinds(r3), ["stall-reacquire"]);
  assert.deepEqual(r3.actions[0], { kind: "stall-reacquire", videoId: VID, seekTo: 120, tryN: 1 });
  assert.equal(st.stallCount, 1);
  assert.equal(st.stallLastTime, -1);
  // 連続 2 回でページ再取得に格上げ
  const r4 = frozen(120000); // stallLastTime=-1 → 基準作り
  assert.deepEqual(r4.actions, []);
  frozen(122000); // 停滞検知
  const r5 = frozen(138000);
  assert.deepEqual(kinds(r5), ["stall-reacquire"]); // try2
  frozen(140000);
  frozen(142000);
  const r6 = frozen(158000);
  assert.deepEqual(kinds(r6), ["stall-page-reload"]);
  assert.equal(st.stallCount, 0);
});

test("停滞: 位置が進めば監視がリセットされる", () => {
  const st = createRecoveryState();
  stepRecovery(st, okInput({ now: 100000 }));
  const r = stepRecovery(st, okInput({ snap: { videoId: VID, state: 1, time: 130, dur: 200, ad: false }, now: 116000 }));
  assert.deepEqual(r.actions, []);
  assert.equal(st.stallSince, 0);
  assert.equal(st.stallLastTime, 130);
});

test("停滞: 一時停止中は停滞判定の対象外", () => {
  const st = createRecoveryState();
  stepRecovery(st, okInput({
    snap: { videoId: VID, state: 2, time: 120, dur: 200, ad: false }, now: 100000,
  }));
  const r = stepRecovery(st, okInput({
    snap: { videoId: VID, state: 2, time: 120, dur: 200, ad: false }, now: 200000,
  }));
  assert.deepEqual(r.actions, []);
  assert.equal(st.stallSince, 0);
});

test("曲末自動進行: キューの次の曲へ(queue 経由)", () => {
  const st = createRecoveryState();
  const r = stepRecovery(st, okInput({
    snap: { videoId: VID, state: 0, time: 200, dur: 200, ad: false },
    nextId: VID2,
  }));
  assert.deepEqual(kinds(r), ["end-advance"]);
  assert.deepEqual(r.actions[0], { kind: "end-advance", videoId: VID2, queued: true });
  assert.equal(st.events.at(-1).kind, "end-advance");
});

test("曲末自動進行: キュー空ならラジオ継続フォールバック", () => {
  const st = createRecoveryState();
  const r = stepRecovery(st, okInput({
    snap: { videoId: VID, state: 0, time: 200, dur: 200, ad: false },
    nextId: null,
  }));
  assert.deepEqual(r.actions[0], { kind: "end-advance", videoId: VID, queued: false });
});

test("曲末自動進行: クロスフェード ON・1 曲ループ・クールダウン中は出ない", () => {
  const st = createRecoveryState();
  const ended = (over) => stepRecovery(st, okInput({
    snap: { videoId: VID, state: 0, time: 200, dur: 200, ad: false }, nextId: VID2, ...over,
  }));
  assert.deepEqual(kinds(ended({ xfadeOff: false })), []);
  assert.deepEqual(kinds(ended({ loopOn: true })), []);
  assert.deepEqual(kinds(ended({ xfadeCooldownActive: true })), []);
});

test("重い回復は 1 poll に 1 つ: 曲末と遷移不一致が同時なら nav を優先", () => {
  const st = createRecoveryState();
  st.navAt = 99000;
  const r = stepRecovery(st, okInput({
    snap: { videoId: VID, state: 0, time: 200, dur: 200, ad: false },
    urlVideoId: VID2, pageOk: true, nextId: VID2,
  }));
  assert.deepEqual(kinds(r), ["nav-force-load"]);
});

test("重い回復は 1 poll に 1 つ: 未開始回復と遷移不一致が同時なら nav を優先", () => {
  const st = createRecoveryState();
  st.navAt = 99000;
  st.unstartedSince = 90000;
  const r = stepRecovery(st, okInput({
    snap: { videoId: VID, state: -1, time: 0, dur: 0, ad: false },
    urlVideoId: VID2, pageOk: true,
  }));
  assert.deepEqual(kinds(r), ["play-kick", "nav-force-load"]);
});

test("recordEvent: リング 200 件で古いものから落ちる", () => {
  const st = createRecoveryState();
  for (let i = 0; i < 210; i++) recordEvent(st, i, "end-advance", 1, String(i));
  assert.equal(st.events.length, 200);
  assert.equal(st.events[0].detail, "10");
  assert.equal(st.events.at(-1).detail, "209");
});
