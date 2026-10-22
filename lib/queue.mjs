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
