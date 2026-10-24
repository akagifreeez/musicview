// キュー状態の正規化と自前シャッフル。サイト側(movie_player)の状態スナップショットを入力にする

// スナップショットの queue(getPlaylist() の返り値)を文字列ID配列に正規化する。
// プレイリストに載っていない単発再生のときは現在曲だけの1件配列に落とす
export function normalizeQueue(snapshot) {
  const ids = Array.isArray(snapshot?.queue)
    ? snapshot.queue.filter(id => typeof id === "string" && id)
    : [];
  if (ids.length === 0 && typeof snapshot?.videoId === "string" && snapshot.videoId) {
    return [snapshot.videoId];
  }
  return [...new Set(ids)];
}

// キューを「現在曲を先頭に固定し、残りをシャッフル」した順序に並べ替える。
// qIdx はスナップショット上の現在位置。自前シャッフルの次曲はミックス継続を切る代わりに
// この順序に沿って loadVideoById で飛ぶ(README に挙動を記載)
export function shuffledOrder(queue, qIdx) {
  if (!Array.isArray(queue) || queue.length === 0) return [];
  const cur = queue[Math.min(Math.max(Number(qIdx) || 0, 0), queue.length - 1)];
  const rest = queue.filter(id => id !== cur);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [cur, ...rest];
}

// シャッフル順序の中で currentId の次の曲。末尾なら null(そのまま終了、次のラウンドは新規シャッフル)
export function nextShuffled(order, currentId) {
  if (!Array.isArray(order) || !currentId) return null;
  const i = order.indexOf(currentId);
  if (i === -1 || i + 1 >= order.length) return null;
  return order[i + 1];
}

// ── アプリ側オーバーライドキュー(ユーザーが並べ替える用)──────────────
// YouTube プレイヤー自身のキューは外から並べ替えられないため、ユーザーがキューを
// 触った時点でアプリ側の配列(override)へ引き取り、次曲選択はそちらを優先する

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

// 任意の配列を「11文字の動画IDのみ・重複除去」に清める。UI から来る値の唯一の入口
export function sanitizeQueue(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter(id => typeof id === "string" && ID_RE.test(id)))];
}

// 最初の 1 個だけ除去した新配列(見つからなければ元と同内容)
export function removeOne(list, id) {
  const out = Array.isArray(list) ? [...list] : [];
  const i = out.indexOf(id);
  if (i >= 0) out.splice(i, 1);
  return out;
}

// refId の直後に id を挿入した新配列。現在曲が無い(見つからない)場合は先頭に置く
// (「次に再生」の意図=直後へ割り込み、の最も近い代替)
export function insertAfterOne(list, refId, id) {
  const out = removeOne(list, id);
  const i = out.indexOf(refId);
  out.splice(i >= 0 ? i + 1 : 0, 0, id);
  return out;
}
