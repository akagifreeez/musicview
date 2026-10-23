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
  loop: $("loop"), shuffle: $("shuffle"), mix: $("mix"),
  tabQueue: $("tab-queue"), tabRecs: $("tab-recs"),
  recsKind: $("recs-kind"), recsBody: $("recs-body"),
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
let eqGainsLocal = [0, 0, 0, 0, 0];
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
      clearTimeout(eqSendTimer);
      eqSendTimer = setTimeout(() => window.musicview.setEq(eqGainsLocal.slice()), 150);
    });
  });
  document.querySelectorAll("#eq-panel [data-preset]").forEach(b => {
    b.addEventListener("click", () => {
      eqGainsLocal = EQ_PRESETS[b.dataset.preset].slice();
      syncEqUI(eqGainsLocal);
      window.musicview.setEq(eqGainsLocal.slice());
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

  // EQパネルが開いているときは値を同期(スライダー触っていないときだけ)
  if (!els.eqPanel.classList.contains("hidden") && document.activeElement?.classList?.contains("eq-range") !== true) {
    syncEqUI(s.eq ?? [0, 0, 0, 0, 0]);
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
      window.musicview.cmd("pause");
    }
  }

  document.title = p.title ? `${p.title} — musicview` : "musicview";
}

// ── キュー表示 ────────────────────────────────
function renderQueue(p) {
  const items = snap.queueItems ?? [];
  const box = els.tabQueue;
  if (!items.length || items.length === 1 && items[0].id === p.videoId && !p.queue) {
    box.innerHTML = `<div class="placeholder">単発再生中(キューなし)<br>「この曲からミックス」でラジオが続く</div>`;
    return;
  }
  const curIdx = Array.isArray(p.queue) ? p.queue.indexOf(p.videoId) : 0;
  let html = "";
  items.forEach((it, i) => {
    const cur = it.id === p.videoId ? " cur" : "";
    const t = it.title ? esc(it.title) : `<span class="row-id">${esc(it.id)}</span>`;
    const sub = esc(it.author || (i === curIdx ? "再生中" : ""));
    html += `<div class="row${cur}" data-id="${it.id}" data-i="${p.queue ? p.queue.indexOf(it.id) : i}">
      <img class="row-thumb" loading="lazy" src="https://i.ytimg.com/vi/${it.id}/default.jpg" alt="">
      <div class="row-main"><div class="row-title">${t}</div><div class="row-sub">${sub}</div></div>
      <button class="row-mix" data-mix="${it.id}" title="この曲からミックス">♫</button>
    </div>`;
  });
  box.innerHTML = html;
  // 曲が変わった時だけ再生中の行へスクロールする(毎renderやると手動スクロールを奪う)
  const curRow = box.querySelector(".row.cur");
  if (curRow && p.videoId !== queueScrolledVid) {
    queueScrolledVid = p.videoId;
    curRow.scrollIntoView({ block: "nearest" });
  }
}

els.tabQueue.addEventListener("click", (e) => {
  const mixBtn = e.target.closest(".row-mix");
  if (mixBtn) {
    window.musicview.openRec(mixBtn.dataset.mix, true);
    return;
  }
  const row = e.target.closest(".row");
  if (!row) return;
  // プレイヤー本体にキューがあるならインデックス指定、推定キューなら直接読み込み
  if (snap?.queueEstimated) window.musicview.cmd("load", row.dataset.id);
  else window.musicview.cmd("playAt", Number(row.dataset.i));
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
      <button class="row-mix" data-mix="${it.id}" title="この曲からミックス">♫</button>
    </div>`).join("");
});

els.tabRecs.addEventListener("click", (e) => {
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
els.prev.addEventListener("click", () => window.musicview.cmd("prev"));
els.next.addEventListener("click", () => {
  if (shuffleOn) window.musicview.shuffleNext();
  else window.musicview.cmd("next");
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
els.eqBtn.addEventListener("click", () => {
  els.eqPanel.classList.toggle("hidden");
  els.dcPanel.classList.add("hidden");
  if (!els.eqPanel.classList.contains("hidden")) syncEqUI(snap?.eq ?? [0, 0, 0, 0, 0]);
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
drawViz();
setInterval(poll, 500);
poll();
