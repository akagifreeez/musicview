// musicview renderer — 操作面のロジック。状態は 500ms ポーリングでメインから受ける
"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  search: $("search"), sleep: $("sleep"), sleepLeft: $("sleep-left"),
  login: $("login"), importBtn: $("import"), mode: $("mode"),
  art: $("art"), idle: $("idle"),
  title: $("title"), author: $("author"),
  tCur: $("t-cur"), tDur: $("t-dur"), seek: $("seek"),
  prev: $("prev"), next: $("next"), back30: $("back30"), fwd30: $("fwd30"),
  pp: $("pp"), icPlay: $("ic-play"), icPause: $("ic-pause"),
  vol: $("vol"), rate: $("rate"), xfade: $("xfade"), ambient: $("ambient"), viz: $("viz"),
  eqBtn: $("eq-btn"), eqPanel: $("eq-panel"), eqClose: $("eq-close"), eqSliders: $("eq-sliders"),
  dcBtn: $("dc-btn"), dcPanel: $("dc-panel"), dcClose: $("dc-close"), dcId: $("dc-id"),
  dcSave: $("dc-save"), dcStatus: $("dc-status"),
  diag: $("diag"),
  loop: $("loop"), shuffle: $("shuffle"), mix: $("mix"),
  tabQueue: $("tab-queue"), tabRecs: $("tab-recs"),
  recsKind: $("recs-kind"), recsBody: $("recs-body"),
  histBtn: $("hist-btn"), queueNote: $("queue-note"), queueHeadLabel: $("queue-head-label"),
};

let mode = "music";
let snap = null;          // 最新の poll 結果
let artId = null;         // 表示中アートの動画ID
let seekDragging = false;
let loopOn = localStorage.getItem("mv.loop") === "1";
let loopKickAt = 0;
let shuffleOn = localStorage.getItem("mv.shuffle") === "1";
let sleepEnd = 0;
let sleepFired = true;
let volTouched = false;
let durShowTotal = false; // 残り時間(-表記)と総時間の切り替え
let queueScrolledVid = null; // キューの自動スクロール用(曲替わりの一度だけ)
let mixPendingShown = null;
// EQはボタンでON/OFFする。スライダーの値はOFFでも覚えており、ONで復帰する。
// 適用値の真実はメイン側にあるが、押し忘れのないよう起動時にこちらから改めて申し伝える
let eqOn = localStorage.getItem("mv.eqOn") === "1";
let eqGainsLocal = (() => {
  try {
    const v = JSON.parse(localStorage.getItem("mv.eqGains") ?? "null");
    return Array.isArray(v) && v.length === 5 ? v.map(Number) : [0, 0, 0, 0, 0];
  } catch { return [0, 0, 0, 0, 0]; }
})();
const eqFlat = [0, 0, 0, 0, 0];
let eqSendTimer = null;
let vizTarget = null;    // メインから届いた解析値
let vizLevels = null;    // 描画中の値(補間用)

// renderer 側のEQメタ(lib/eq.mjs と同じ値)
const EQ_META = [
  { label: "CLEAR BASS", min: -12, max: 15 },
  { label: "LOW", min: -12, max: 12 },
  { label: "MID", min: -12, max: 12 },
  { label: "HIGH", min: -12, max: 12 },
  { label: "AIR", min: -12, max: 12 },
];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  bass: [8, 3, -1, 0, 1],
  clearbass: [14, 2, -2, 0, 2],
  vocal: [-2, -1, 3, 4, 1],
};

// ── 表示ユーティリティ ────────────────────────
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return h ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

function esc(t) {
  const d = document.createElement("div");
  d.textContent = t ?? "";
  return d.innerHTML;
}

// ── ポーリング ────────────────────────────────
async function poll() {
  try {
    const r = await window.musicview.poll();
    snap = r;
    render();
  } catch { /* メイン側遷移中は次回 */ }
}

// スライダーの左側をアクセントで塗る(Apple Music 風)
function paintRange(el, pct) {
  el.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--fill) ${pct}%)`;
}

// ── EQパネル ────────────────────────────────
function saveEqGains() {
  localStorage.setItem("mv.eqGains", JSON.stringify(eqGainsLocal));
}

// ON/OFFの状態と適用値をメインへ反映(ボタン色もここで揃える)
function setEqOn(v) {
  eqOn = v;
  localStorage.setItem("mv.eqOn", v ? "1" : "0");
  els.eqBtn.classList.toggle("on", v);
  window.musicview.setEq((v ? eqGainsLocal : eqFlat).slice());
}

function buildEqPanel() {
  els.eqSliders.innerHTML = EQ_META.map((b, i) => `
    <div class="eq-row">
      <span class="eq-label">${b.label}</span>
      <input type="range" class="eq-range" data-i="${i}" min="${b.min}" max="${b.max}" step="1" value="0">
      <span class="eq-val" data-v="${i}">0</span>
    </div>`).join("");
  els.eqSliders.querySelectorAll(".eq-range").forEach(r => {
    paintRange(r, ((Number(r.value) - Number(r.min)) / (Number(r.max) - Number(r.min))) * 100);
    r.addEventListener("input", () => {
      const i = Number(r.dataset.i);
      eqGainsLocal[i] = Number(r.value);
      els.eqSliders.querySelector(`[data-v="${i}"]`).textContent = r.value;
      paintRange(r, ((Number(r.value) - Number(r.min)) / (Number(r.max) - Number(r.min))) * 100);
      saveEqGains();
      if (!eqOn) setEqOn(true); // 触った=鳴らしたい
      clearTimeout(eqSendTimer);
      eqSendTimer = setTimeout(() => window.musicview.setEq(eqGainsLocal.slice()), 150);
    });
  });
  document.querySelectorAll("#eq-panel [data-preset]").forEach(b => {
    b.addEventListener("click", () => {
      eqGainsLocal = EQ_PRESETS[b.dataset.preset].slice();
      saveEqGains();
      syncEqUI(eqGainsLocal);
      if (!eqOn) setEqOn(true);
      else window.musicview.setEq(eqGainsLocal.slice());
    });
  });
}

function syncEqUI(gains) {
  eqGainsLocal = gains.slice();
  els.eqSliders.querySelectorAll(".eq-range").forEach(r => {
    const i = Number(r.dataset.i);
    r.value = gains[i];
    paintRange(r, ((Number(r.value) - Number(r.min)) / (Number(r.max) - Number(r.min))) * 100);
  });
  els.eqSliders.querySelectorAll("[data-v]").forEach(v => { v.textContent = String(gains[Number(v.dataset.v)]); });
}

// ── ビジュアライザー ────────────────────────
window.musicview.onViz(d => { vizTarget = d; });

const vizPeaks = new Array(28).fill(0);   // ピークマーカー(ゆっくり落下)
function drawViz() {
  requestAnimationFrame(drawViz);
  const on = snap?.ok && snap.viz && snap?.snap?.state === 1;
  els.viz.classList.toggle("hidden", !on);
  if (!on) return;
  const w = els.viz.clientWidth, h = 56, dpr = window.devicePixelRatio || 1;
  if (els.viz.width !== Math.round(w * dpr)) {
    els.viz.width = Math.round(w * dpr);
    els.viz.height = Math.round(h * dpr);
  }
  const ctx = els.viz.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!vizTarget) return;
  if (!vizLevels || vizLevels.length !== vizTarget.length) {
    vizLevels = vizTarget.slice();
    vizPeaks.fill(0);
  }
  const n = vizLevels.length, bw = w / n;
  for (let i = 0; i < n; i++) {
    // 立ち上がりは速く、落下はゆっくり(躍動感のある動き)
    const t = vizTarget[i];
    vizLevels[i] += (t - vizLevels[i]) * (t > vizLevels[i] ? 0.55 : 0.16);
    vizPeaks[i] = Math.max(vizPeaks[i] - 0.55, vizLevels[i]);
    const bh = Math.max(3, Math.pow(vizLevels[i] / 100, 1.15) * (h - 6));
    const ph = Math.max(3, Math.pow(vizPeaks[i] / 100, 1.15) * (h - 6));
    const g = ctx.createLinearGradient(0, h - bh, 0, h);
    g.addColorStop(0, "rgba(252,60,68,0.98)");
    g.addColorStop(1, "rgba(252,60,68,0.16)");
    ctx.fillStyle = g;
    ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
    // ピークマーカー
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.fillRect(i * bw + 1, h - ph - 2, bw - 2, 2);
  }
}

function render() {
  const s = snap;
  if (!s || !s.ok) {
    document.body.classList.remove("playing", "has-art");
    return;
  }
  const p = s.snap;
  document.body.classList.toggle("playing", p.state === 1);

  // 曲情報
  if (p.title) els.title.textContent = p.title;
  if (p.author) els.author.textContent = p.author;
  if (p.videoId !== artId) {
    artId = p.videoId;
    if (artId) {
      // アンビエント層(全面ぼかし背景)にも同じアートを敷く
      const setAmbient = (q) => { els.ambient.style.backgroundImage = `url("https://i.ytimg.com/vi/${artId}/${q}default.jpg")`; };
      els.art.onerror = () => {
        if (els.art.dataset.q === "maxres") {
          els.art.dataset.q = "hq";
          els.art.src = `https://i.ytimg.com/vi/${artId}/hqdefault.jpg`;
          setAmbient("hq");
        } else {
          document.body.classList.remove("has-art");
        }
      };
      els.art.dataset.q = "maxres";
      els.art.src = `https://i.ytimg.com/vi/${artId}/maxresdefault.jpg`;
      setAmbient("maxres");
      document.body.classList.add("has-art");
    }
  }

  // 進行(ドラッグ中は触らない)。右側の時間は Apple Music 風に残り表示。
  // 広告中は time/dur が広告側のタイムラインになるため表示を凍結し「広告」と出す
  if (p.ad) {
    els.tDur.textContent = "広告";
  } else if (!seekDragging) {
    const pct = p.dur > 0 ? (p.time / p.dur) * 100 : 0;
    els.seek.value = Math.round(pct * 10);
    paintRange(els.seek, pct);
    els.tCur.textContent = fmt(p.time);
    els.tDur.textContent = durShowTotal ? fmt(p.dur) : `-${fmt(Math.max(0, p.dur - p.time))}`;
  }

  // 再生/一時停止アイコン
  const playing = p.state === 1;
  els.icPlay.classList.toggle("hidden", playing);
  els.icPause.classList.toggle("hidden", !playing);

  // 音量・速度(未操作のときだけ実況に合わせる)
  if (!volTouched) {
    els.vol.value = p.vol;
    paintRange(els.vol, Number(els.vol.value));
  }
  if (document.activeElement !== els.rate) {
    const r = String(p.rate ?? 1);
    if ([...els.rate.options].some(o => o.value === r)) els.rate.value = r;
  }
  // クロスフェード秒数(メインが持つ保存値に合わせる)
  if (document.activeElement !== els.xfade) {
    const x = String(s.xfadeSec ?? 0);
    if ([...els.xfade.options].some(o => o.value === x)) els.xfade.value = x;
  }

  // 1曲ループ(終了したら頭出し)
  if (loopOn && p.state === 0 && Date.now() - loopKickAt > 2000) {
    loopKickAt = Date.now();
    window.musicview.cmd("seek", 0);
    window.musicview.cmd("play");
  }

  els.loop.classList.toggle("on", loopOn);
  els.shuffle.classList.toggle("on", shuffleOn);

  // クロスフェード切替中はボタンでフィードバックする(押したのに何も起きない見えを防ぐ)
  const pending = !!s.xfading;
  if (pending !== mixPendingShown) {
    mixPendingShown = pending;
    els.mix.textContent = pending ? "ミックス切替中…" : "この曲からミックス";
    els.mix.classList.toggle("on", pending);
  }

  // EQパネルが開いているときは値を同期(スライダー触っていないときだけ)。
  // OFF中は「ONにしたら効く値」=ローカル保持値を見せる
  if (!els.eqPanel.classList.contains("hidden") && document.activeElement?.classList?.contains("eq-range") !== true) {
    syncEqUI(eqOn && Array.isArray(s.eq) ? s.eq : eqGainsLocal);
  }

  // モードはイベントだけでなくポーリングでも同期する(push取りこぼしで
  // サイト表示中に「サイト表示」ラベルのまま残る事故の再発防止)
  if (s.mode && s.mode !== mode) setMode(s.mode);

  // キュー
  renderQueue(p);

  // ブロック数は brand のツールチップに載せる(目立たせない)
  document.querySelector(".brand").title = `広告 ${s.blocked} リクエストをブロック / モード: ${s.mode === "music" ? "音楽" : "サイト"}`;

  // スリープタイマー表示
  if (sleepEnd > 0) {
    const left = Math.max(0, sleepEnd - Date.now());
    els.sleepLeft.textContent = `スリープまで ${fmt(left / 1000)}`;
    if (left <= 0 && !sleepFired) {
      sleepFired = true;
      sleepEnd = 0;
      els.sleep.value = "0";
      els.sleepLeft.textContent = "";
      window.musicview.cmd("sleep-pause");
    }
  }

  document.title = p.title ? `${p.title} — musicview` : "musicview";
}

// ── キュー表示 ────────────────────────────────
let showHistory = false;   // キュー領域を再生履歴(新しい順)に切り替える
let queueDragging = false; // ドラッグ中は 500ms の再構築を止める(止めないとドラッグが壊れる)

function renderQueue(p) {
  const box = els.tabQueue;
  if (showHistory) return renderHistory(box);
  if (queueDragging) return; // ドラッグ中は触らない
  const items = snap.queueItems ?? [];
  const isOverride = !!snap.queueOverride;
  if (!items.length || items.length === 1 && items[0].id === p.videoId && !p.queue && !isOverride) {
    box.innerHTML = `<div class="placeholder">単発再生中(キューなし)<br>「この曲からミックス」でラジオが続く</div>`;
    return;
  }
  let html = "";
  items.forEach((it, i) => {
    const cur = it.id === p.videoId ? " cur" : "";
    const t = it.title ? esc(it.title) : `<span class="row-id">${esc(it.id)}</span>`;
    const sub = esc(it.author || (it.id === p.videoId ? "再生中" : ""));
    // プレイヤー本体にキューがあるなら playAt のインデックス、それ以外(override/推定)は
    // 直接 load で飛ぶ(クリック処理も同じ分岐)
    const idx = (isOverride || snap.queueEstimated || !Array.isArray(p.queue)) ? i : p.queue.indexOf(it.id);
    html += `<div class="row${cur}" data-id="${it.id}" data-i="${idx}" draggable="true">
      <span class="row-drag" title="ドラッグで並べ替え">≡</span>
      <img class="row-thumb" loading="lazy" src="https://i.ytimg.com/vi/${it.id}/default.jpg" alt="">
      <div class="row-main"><div class="row-title">${t}</div><div class="row-sub">${sub}</div></div>
      <button class="row-del" data-del="${it.id}" title="キューから削除">×</button>
      <button class="row-mix" data-mix="${it.id}" title="この曲からミックス">♫</button>
    </div>`;
  });
  box.innerHTML = html;
  els.queueNote.textContent = isOverride ? " — 並べ替え済み" : "";
  els.queueNote.title = isOverride ? "クリックで元のキュー順に戻す" : "";
  els.queueNote.classList.toggle("undoable", isOverride);
  // 曲が変わった時だけ再生中の行へスクロールする(毎renderやると手動スクロールを奪う)
  const curRow = box.querySelector(".row.cur");
  if (curRow && p.videoId !== queueScrolledVid) {
    queueScrolledVid = p.videoId;
    curRow.scrollIntoView({ block: "nearest" });
  }
}

// 再生履歴(新しい順)。行クリックでその曲へ戻る
function renderHistory(box) {
  const items = snap.historyItems ?? [];
  if (!items.length) {
    box.innerHTML = `<div class="placeholder">履歴はまだ無い<br>曲を聴くとここに積まれます</div>`;
    return;
  }
  box.innerHTML = items.map(it => `<div class="row" data-id="${it.id}">
      <img class="row-thumb" loading="lazy" src="https://i.ytimg.com/vi/${it.id}/default.jpg" alt="">
      <div class="row-main"><div class="row-title">${it.title ? esc(it.title) : `<span class="row-id">${esc(it.id)}</span>`}</div><div class="row-sub">${esc(it.author ?? "")}</div></div>
      <button class="row-mix" data-mix="${it.id}" title="この曲からミックス">♫</button>
    </div>`).join("");
  els.queueNote.textContent = " — 履歴";
}

// キューのドラッグ並べ替え(HTML5 DnD)。決定した順序をメインへ送り、
// 次曲選択がその順序に従う(override はここで初めて生える)
let dragRowEl = null;
els.tabQueue.addEventListener("dragstart", (e) => {
  const row = e.target.closest(".row");
  if (!row || !row.draggable) return;
  queueDragging = true;
  dragRowEl = row;
  row.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", row.dataset.id);
});
els.tabQueue.addEventListener("dragover", (e) => {
  if (!queueDragging) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
});
els.tabQueue.addEventListener("drop", (e) => {
  if (!queueDragging || !dragRowEl) return;
  e.preventDefault();
  const target = e.target.closest(".row");
  if (target && target !== dragRowEl) {
    const ids = [...els.tabQueue.querySelectorAll(".row")].map(r => r.dataset.id);
    const from = ids.indexOf(dragRowEl.dataset.id);
    let to = ids.indexOf(target.dataset.id);
    if (from >= 0 && to >= 0) {
      ids.splice(from, 1);
      if (to > from) to -= 1; // 除去で前詰めになった分を詰める
      ids.splice(to, 0, dragRowEl.dataset.id);
      window.musicview.queueReorder(ids);
    }
  }
});
els.tabQueue.addEventListener("dragend", () => {
  queueDragging = false;
  dragRowEl?.classList.remove("dragging");
  dragRowEl = null;
  render(); // 確定した順序をすぐ反映
});

els.tabQueue.addEventListener("click", (e) => {
  const delBtn = e.target.closest(".row-del");
  if (delBtn) {
    window.musicview.queueRemove(delBtn.dataset.del);
    return;
  }
  const mixBtn = e.target.closest(".row-mix");
  if (mixBtn) {
    window.musicview.openRec(mixBtn.dataset.mix, true);
    return;
  }
  const row = e.target.closest(".row");
  if (!row) return;
  // 履歴・override・推定キューは直接 load、プレイヤー本体のキューはインデックス指定
  if (showHistory || snap?.queueEstimated || snap?.queueOverride) window.musicview.cmd("load", row.dataset.id);
  else window.musicview.cmd("playAt", Number(row.dataset.i));
});

// 履歴切替(キュー領域を履歴リストに差し替える)
els.histBtn.addEventListener("click", () => {
  showHistory = !showHistory;
  els.histBtn.textContent = showHistory ? "キューへ" : "履歴";
  if (!showHistory) {
    els.queueNote.textContent = snap?.queueOverride ? " — 並べ替え済み" : "";
    els.queueNote.title = snap?.queueOverride ? "クリックで元のキュー順に戻す" : "";
    els.queueNote.classList.toggle("undoable", !!snap?.queueOverride);
  }
  render();
});

// 「並べ替え済み」ラベルを押すとオーバーライドを解除して元のキュー順に戻す
els.queueNote.addEventListener("click", async () => {
  if (!snap?.queueOverride) return;
  await window.musicview.queueClear();
  els.queueNote.textContent = "";
  els.queueNote.title = "";
  els.queueNote.classList.remove("undoable");
  render();
});

// ── おすすめ表示 ───────────────────────────────
window.musicview.onRecs(({ kind, query, items }) => {
  els.recsKind.textContent = kind === "search" ? ` — 検索: ${query ?? ""}` : "";
  if (!items || !items.length) {
    els.recsBody.innerHTML = `<div class="placeholder">取れたのは 0 件(次の曲に進むと自動で更新)</div>`;
    return;
  }
  els.recsBody.innerHTML = items.map(it => `<div class="row" data-open="${it.id}">
      <img class="row-thumb" loading="lazy" src="https://i.ytimg.com/vi/${it.id}/default.jpg" alt="">
      <div class="row-main"><div class="row-title">${esc(it.title)}</div><div class="row-sub">${esc(it.author)}</div></div>
      ${it.len ? `<span class="row-len">${fmt(it.len)}</span>` : ""}
      <button class="row-next" data-next="${it.id}" title="次に再生(今の曲の直後に割り込む)">⤵</button>
      <button class="row-mix" data-mix="${it.id}" title="この曲からミックス">♫</button>
    </div>`).join("");
});

els.tabRecs.addEventListener("click", (e) => {
  const nextBtn = e.target.closest(".row-next");
  if (nextBtn) {
    window.musicview.queuePlayNext(nextBtn.dataset.next).then(ok => {
      nextBtn.textContent = ok ? "✓" : "⤵";
      setTimeout(() => { nextBtn.textContent = "⤵"; }, 1200);
    });
    return;
  }
  const mixBtn = e.target.closest(".row-mix");
  if (mixBtn) {
    window.musicview.openRec(mixBtn.dataset.mix, true);
    return;
  }
  const row = e.target.closest(".row");
  if (row?.dataset.open) window.musicview.openRec(row.dataset.open, false);
});

// ── 操作 ──────────────────────────────────────
els.pp.addEventListener("click", () => {
  window.musicview.cmd(snap?.snap?.state === 1 ? "pause" : "play");
});
els.prev.addEventListener("click", () => window.musicview.prev());
els.next.addEventListener("click", () => {
  if (shuffleOn) window.musicview.shuffleNext();
  else window.musicview.next();
});
els.back30.addEventListener("click", () => seekBy(-30));
els.fwd30.addEventListener("click", () => seekBy(30));

function seekBy(delta) {
  const p = snap?.snap;
  if (!p || p.ad) return; // 広告中のシークは広告側を掴むので無視
  const to = Math.min(Math.max(0, (p.time ?? 0) + delta), p.dur || 0);
  window.musicview.cmd("seek", to);
}

els.seek.addEventListener("input", () => {
  seekDragging = true;
  const p = snap?.snap;
  if (p?.ad) return;
  paintRange(els.seek, Number(els.seek.value) / 10);
  if (p?.dur) els.tCur.textContent = fmt((Number(els.seek.value) / 1000) * p.dur);
});
els.seek.addEventListener("change", () => {
  const p = snap?.snap;
  if (p?.dur && !p.ad) window.musicview.cmd("seek", (Number(els.seek.value) / 1000) * p.dur);
  seekDragging = false;
});

els.vol.addEventListener("input", () => {
  volTouched = true;
  paintRange(els.vol, Number(els.vol.value));
  window.musicview.cmd("vol", Number(els.vol.value));
});
els.tDur.addEventListener("click", () => {
  durShowTotal = !durShowTotal; // 残り時間(-表記)⇔総時間
  render();
});
els.rate.addEventListener("change", () => window.musicview.cmd("rate", Number(els.rate.value)));
els.xfade.addEventListener("change", () => window.musicview.setXfade(Number(els.xfade.value)));

els.loop.addEventListener("click", () => {
  loopOn = !loopOn;
  localStorage.setItem("mv.loop", loopOn ? "1" : "0");
  els.loop.classList.toggle("on", loopOn);
  window.musicview.setLoop(loopOn); // 1曲ループ中はクロスフェードしない
});
els.shuffle.addEventListener("click", () => {
  shuffleOn = !shuffleOn;
  localStorage.setItem("mv.shuffle", shuffleOn ? "1" : "0");
  els.shuffle.classList.toggle("on", shuffleOn);
});
els.mix.addEventListener("click", () => window.musicview.mix());

els.search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const q = els.search.value.trim();
    if (!q) return;
    window.musicview.search(q);
    els.recsKind.textContent = ` — 検索: ${q}`;
    els.recsBody.innerHTML = `<div class="placeholder">検索中…</div>`;
  }
});

els.sleep.addEventListener("change", () => {
  const m = Number(els.sleep.value);
  if (m > 0) {
    sleepEnd = Date.now() + m * 60000;
    sleepFired = false;
  } else {
    sleepEnd = 0;
    els.sleepLeft.textContent = "";
  }
});

els.login.addEventListener("click", () => window.musicview.login());

els.importBtn.addEventListener("click", async () => {
  const btn = els.importBtn;
  btn.disabled = true;
  btn.textContent = "取り込み中…";
  try {
    const r = await window.musicview.importCookies();
    btn.textContent = r.ok
      ? (r.session ? "取り込み✓" : "取得0件")
      : "見つからず";
  } catch {
    btn.textContent = "失敗";
  }
  setTimeout(() => { btn.textContent = "取り込み"; btn.disabled = false; }, 4000);
});

// ── EQ / Discord パネル ──────────────────────
// EQボタン=ON/OFFスイッチ(使用中は赤)。調整パネルは右クリックで開く
els.eqBtn.addEventListener("click", () => {
  setEqOn(!eqOn);
});
els.eqBtn.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  els.eqPanel.classList.toggle("hidden");
  els.dcPanel.classList.add("hidden");
  if (!els.eqPanel.classList.contains("hidden")) syncEqUI(eqGainsLocal);
});
els.eqClose.addEventListener("click", () => els.eqPanel.classList.add("hidden"));
els.dcBtn.addEventListener("click", () => {
  els.dcPanel.classList.toggle("hidden");
  els.eqPanel.classList.add("hidden");
  if (!els.dcPanel.classList.contains("hidden")) {
    window.musicview.getDiscordId().then(id => { els.dcId.value = id ?? ""; });
  }
});
els.dcClose.addEventListener("click", () => els.dcPanel.classList.add("hidden"));
els.dcSave.addEventListener("click", async () => {
  const r = await window.musicview.setDiscordId(els.dcId.value.trim());
  els.dcStatus.textContent = r.saved
    ? "保存しました(Discord起動中なら数秒で反映)"
    : "IDを消去しました";
});

// 診断レポートの書き出し(不具合報告の材料。保存先を選んでテキスト保存)
els.diag.addEventListener("click", async () => {
  const btn = els.diag;
  btn.disabled = true;
  btn.textContent = "生成中…";
  try {
    const r = await window.musicview.saveDiagReport();
    btn.textContent = r?.ok ? "書き出し✓" : (r?.canceled ? "キャンセル" : "失敗");
  } catch {
    btn.textContent = "失敗";
  }
  setTimeout(() => { btn.textContent = "診断"; btn.disabled = false; }, 4000);
});

// ── モード ────────────────────────────────────
function setMode(m) {
  mode = m;
  document.body.dataset.mode = m;
  els.mode.textContent = m === "music" ? "サイト表示" : "音楽モードへ";
}

els.mode.addEventListener("click", () => {
  window.musicview.setMode(mode === "music" ? "site" : "music");
});
window.musicview.onMode((m) => setMode(m));
window.musicview.getMode().then(setMode);

// サイト表示中はキーボードが YouTube 側に取られるため、メイン側の
// before-input-event(Ctrl+M)とセットで使う。プレイヤー表示中は m でも切替可能

// ── キーボード ────────────────────────────────
window.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return;
  if (e.code === "Space") {
    e.preventDefault();
    window.musicview.cmd(snap?.snap?.state === 1 ? "pause" : "play");
  } else if (e.key === "ArrowLeft") {
    seekBy(e.shiftKey ? -30 : -5);
  } else if (e.key === "ArrowRight") {
    seekBy(e.shiftKey ? 30 : 5);
  } else if (e.key === "n") {
    els.next.click();
  } else if (e.key === "b") {
    els.prev.click();
  } else if (e.key === "m") {
    els.mode.click(); // プレイヤー⇔サイト表示
  }
});

// 起動
els.loop.classList.toggle("on", loopOn);
els.shuffle.classList.toggle("on", shuffleOn);
window.musicview.setLoop(loopOn);
buildEqPanel();
els.eqBtn.classList.toggle("on", eqOn);
if (eqOn) window.musicview.setEq(eqGainsLocal.slice()); // セッション復元値より保存状態を優先
drawViz();
setInterval(poll, 500);
poll();
