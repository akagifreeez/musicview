import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// inject.mjs のテンプレート内から vizBands(対数周波数バンド計算)を取り出して検証する
const src = fs.readFileSync(new URL("../electron/inject.mjs", import.meta.url), "utf8");
const m = src.match(/function vizBands\(buf, bins, nyquist, n\) \{[\s\S]*?\n  \}/);
if (!m) { console.error("vizBands not found"); process.exit(1); }
const vizBands = new Function("buf", "bins", "nyquist", "n", m[0] + "\nreturn vizBands(buf, bins, nyquist, n);");

test("vizBands: 高音域(15kHz付近)のエネルギーが右端バンドに現れる", () => {
  // 48kHz/fftSize256 = 128ビン・1ビン187.5Hz。15kHz ≈ ビン80
  const buf = new Uint8Array(128);
  for (let b = 78; b <= 84; b++) buf[b] = 200; // ≈14.6〜15.8kHz
  const out = vizBands(buf, 128, 24000, 28);
  // 右側4分の1のバンドの最大値が閾値を超える(旧線形割当では高域が分散して死んでいた)
  const rightMax = Math.max(...out.slice(21));
  assert.ok(rightMax > 40, `右端バンドの最大=${rightMax}`);
});

test("vizBands: 低音だけの入力では右半分はほぼ静か(対数割当の整合)", () => {
  const buf = new Uint8Array(128);
  for (let b = 0; b <= 3; b++) buf[b] = 240; // 〜750Hz
  const out = vizBands(buf, 128, 24000, 28);
  assert.ok(out[0] > 60, `左端=${out[0]}`);
  const rightAvg = out.slice(14).reduce((a, b) => a + b, 0) / 14;
  assert.ok(rightAvg < 25, `右半分平均=${rightAvg}`);
});

test("vizBands: ピーク集計(帯域内の最大値を採用)", () => {
  const buf = new Uint8Array(128);
  buf.fill(0);
  // 1kHz ≈ ビン5 に 200、同帯域内の別ビンに 40
  buf[5] = 200;
  buf[4] = 40;
  const out = vizBands(buf, 128, 24000, 28);
  // 1kHz を含むバンドはピーク 200 基準で高めに出る
  assert.ok(Math.max(...out) > 60, `最大=${Math.max(...out)}`);
});

test("vizBands: 全零入力は全バンド0", () => {
  const out = vizBands(new Uint8Array(128), 128, 24000, 28);
  assert.deepEqual(out, new Array(28).fill(0));
});

test("vizBands: 全帯域が0〜100に収まる", () => {
  const buf = new Uint8Array(128).fill(255); // フルスケール
  const out = vizBands(buf, 128, 24000, 28);
  for (const v of out) assert.ok(v >= 0 && v <= 100, `out of range: ${v}`);
});

test("vizBands: 対数割当(バンドの下端周波数が幾何的に増える)", () => {
  // ビン埋めで各バンドの存在を確認: 単一ビンずつの掃引で、左から右へ応答位置が進む
  const results = [];
  for (let probeBin = 1; probeBin < 85; probeBin += 8) {
    const buf = new Uint8Array(128);
    buf[probeBin] = 255;
    const out = vizBands(buf, 128, 24000, 28);
    const peakIdx = out.indexOf(Math.max(...out));
    results.push(peakIdx);
  }
  // 掃引ビンが上がると応答バンドも単調に右へずれる(対数割当の健全性)
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i] >= results[i - 1], `掃引${i}: ${results[i - 1]} -> ${results[i]} が逆転`);
  }
});
