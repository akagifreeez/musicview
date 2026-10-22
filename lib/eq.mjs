// EQ のバンド定義とゲインのクランプ。UI(main/preload経由)とメインプロセスの両方で使う
export const BANDS = [
  { key: "bass", label: "CLEAR BASS", freq: 60, type: "lowshelf", min: -12, max: 15 },
  { key: "low", label: "LOW", freq: 250, type: "peaking", min: -12, max: 12 },
  { key: "mid", label: "MID", freq: 1000, type: "peaking", min: -12, max: 12 },
  { key: "high", label: "HIGH", freq: 3500, type: "peaking", min: -12, max: 12 },
  { key: "air", label: "AIR", freq: 10000, type: "highshelf", min: -12, max: 12 },
];

export const PRESETS = {
  flat: { label: "フラット", gains: [0, 0, 0, 0, 0] },
  bass: { label: "バスアップ", gains: [8, 3, -1, 0, 1] },
  clearbass: { label: "クリアバス", gains: [14, 2, -2, 0, 2] },
  vocal: { label: "ボーカル", gains: [-2, -1, 3, 4, 1] },
};

// 任意入力を「5バンドの整数ゲイン配列」に正規化する。壊れた入力は既定値に落とす
export function clampGains(input) {
  const base = BANDS.map(() => 0);
  if (!Array.isArray(input)) return base;
  return BANDS.map((b, i) => {
    const v = Math.round(Number(input[i]));
    if (!Number.isFinite(v)) return 0;
    return Math.min(b.max, Math.max(b.min, v));
  });
}

export function isFlat(gains) {
  return clampGains(gains).every(g => g === 0);
}
