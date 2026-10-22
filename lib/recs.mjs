// ytInitialData のおすすめ欄・検索結果を UI 表示用の平坦な配列へ落とす。
// YouTube の JSON 形は compactVideoRenderer(旧)と lockupViewModel(新)が混在するので両方を受ける

function textOf(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node.content === "string") return node.content;
  if (Array.isArray(node.runs)) return node.runs.map(r => r.text ?? "").join("");
  if (typeof node.simpleText === "string") return node.simpleText;
  return "";
}

// "3:04" / "1:02:03" → 秒。ライブ配信(「配信中」等)は長さ不明として null
export function parseLen(text) {
  if (!text) return null;
  const m = String(text).match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function fromCompact(c) {
  if (!c?.videoId) return null;
  return {
    id: c.videoId,
    title: textOf(c.title) || textOf(c.headline),
    author: textOf(c.longBylineText ?? c.ownerText ?? c.shortBylineText),
    len: parseLen(textOf(c.lengthText)),
  };
}

// 既知のラッパー形状に当てはまらないノード(videoId を直接持つもの)からの救出。
// YouTube の renderer 名の改修に一番強い最後の砦。タイトルが取れるものだけ採用する
export function parseGenericItems(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const n of list) {
    const id = n?.videoId;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(id) || seen.has(id)) continue;
    const title = textOf(n.title) || textOf(n.headline);
    if (!title) continue;
    seen.add(id);
    out.push({
      id,
      title,
      author: textOf(n.ownerText ?? n.longBylineText ?? n.shortBylineText ?? n.bylineText),
      len: parseLen(textOf(n.lengthText)),
    });
  }
  return out;
}

// lockupViewModel 形。長さはサムネイル側のバッジ(thumbnail overlays)から時刻風の文字列を拾う
function fromLockup(l) {
  if (!l?.contentId) return null;
  const meta = l.metadata?.lockupMetadataViewModel ?? {};
  const parts = meta.metadata?.contentMetadataViewModel?.metadataRows
    ?.flatMap(r => r.metadataParts ?? [])
    .map(p => textOf(p.text)) ?? [];
  const lenText = parts.find(t => /^\d+(?::\d+)+$/.test(t)) ?? null;
  let len = parseLen(lenText);
  if (len === null) {
    // バッジは metadata rows には現れないため、サムネ木構造から時刻風文字列を探す
    const badge = JSON.stringify(l.contentImage ?? {}).match(/"text":"(\d{1,2}(?::\d{2}){1,2})"/);
    len = parseLen(badge?.[1]);
  }
  return {
    id: l.contentId,
    title: textOf(meta.title),
    author: parts.find(t => /^\d+(?::\d+)+$/.test(t) === false && t) ?? "",
    len,
  };
}

// おすすめ欄(secondaryResults)の results 配列を解析する
export function parseRecResults(results) {
  if (!Array.isArray(results)) return [];
  const out = [];
  const seen = new Set();
  for (const it of results) {
    const r = fromCompact(it?.compactVideoRenderer) ?? fromLockup(it?.lockupViewModel);
    if (r && r.id && !seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

// 検索結果ページ(twoColumnSearchResultsRenderer)の解析
export function parseSearchResults(data) {
  const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
    ?.sectionListRenderer?.contents;
  if (!Array.isArray(sections)) return [];
  const out = [];
  const seen = new Set();
  for (const sec of sections) {
    for (const item of sec?.itemSectionRenderer?.contents ?? []) {
      const v = item?.videoRenderer;
      if (!v?.videoId || seen.has(v.videoId)) continue;
      seen.add(v.videoId);
      out.push({
        id: v.videoId,
        title: textOf(v.title),
        author: textOf(v.ownerText ?? v.longBylineText),
        len: parseLen(textOf(v.lengthText)),
      });
    }
  }
  return out;
}

// ページ内 DOM 抽出(executeJavaScript 側で集めた {id,title,author,lenText})の解析。
// ytInitialData が取れないときのフォールバック
export function parseDomItems(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const d of list) {
    if (!d || typeof d.id !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(d.id) || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push({
      id: d.id,
      title: String(d.title ?? ""),
      author: String(d.author ?? ""),
      len: parseLen(d.lenText),
    });
  }
  return out;
}

// プレイリストパネル(playlistPanelVideoRenderer)からキューのID列と曲名を作る。
// 曲名はサイトのデータから直接取れるので、oEmbed が失敗する動画(埋め込み無効等)でも
// キュー表示に ID が出ない。順序が重要なので取得順を保つ
export function parseQueueItems(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const it of list) {
    const id = it?.videoId;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: textOf(it.title) || textOf(it.headline),
      author: textOf(it.shortBylineText ?? it.longBylineText),
      len: parseLen(textOf(it.lengthText)),
    });
  }
  return out;
}

// プレイリストパネル(playlistPanelVideoRenderer)からキューのID列を作る。
// プレイヤー API の getPlaylist() が null を返す構成(ミックス後半等)のときの代役
export function parseQueueIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const it of list) {
    const id = it?.videoId;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
