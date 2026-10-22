// YouTube URL 周りの純関数群。Electron に依存しないので node --test で直接検証する

// 入力(URL / 動画ID / youtu.be / shorts / live / embed)から動画IDを取り出す
export function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const q = s.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (q) return q[1];
  const short = s.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (short) return short[1];
  const path = s.match(/\/(?:shorts|embed|live|v)\/([a-zA-Z0-9_-]{11})/);
  if (path) return path[1];
  return null;
}

// URL から list= の値を取り出す
export function extractListId(input) {
  if (!input) return null;
  const m = String(input).match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ミックス(RD系)の再生リストか。RD + 動画ID の他 RDMM 等の派生があるため前方一致
export function isMixListId(listId) {
  return typeof listId === "string" && /^RD[a-zA-Z0-9_-]+$/.test(listId);
}

// 「この曲からミックス再生」のURL。start_radio=1 で即ラジオ開始
export function mixUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}&start_radio=1`;
}

// 単発再生のURL
export function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// 検索結果ページのURL。動画のみフィルタ(sp)は付けない(付けると結果が空になる構成がある。
// チャンネル等の混入は parse 側で videoId+タイトルのあるものだけ採って落とす)
export function searchUrl(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

// 保存済みURLに再生位置(t=)を反映する。既存の t は置き換え、list 等の他パラメータは温存
export function withTime(url, sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  try {
    const u = new URL(url);
    if (!u.searchParams.has("v")) return url;
    u.searchParams.set("t", `${s}s`);
    return u.toString();
  } catch {
    return url;
  }
}

// サムネイルURL。maxres は存在しない動画があるので UI 側で onerror フォールバックする前提
export function thumbUrl(videoId, quality = "hq") {
  const q = ["maxres", "sd", "hq", "mq"].includes(quality) ? quality : "hq";
  return `https://i.ytimg.com/vi/${videoId}/${q}default.jpg`;
}
