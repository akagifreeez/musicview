// electron/adblock.cjs — EasyList 形式のフィルタエンジン
// EasyList / ABPJF(日本語フィルタ)をダウンロードし、URL パターンマッチでブロックする。
// 対応するルール構文(実データ分析 2026-10-12):
//   ||domain/path^      ドメインアンカー(全体の 67%)
//   |先頭アンカー        URL 先頭一致(稀)
//   * ワイルドカード / ^ セパレータ
//   $options            script,image,subdocument,third-party,~third-party,domain=… 等
//                       (未対応オプションのルールは無視する = 誤ブロックより取りこぼしを優先)
//   @@ 例外ルール(ホワイトリスト)
"use strict";

// ルールごとに RegExp を作ると数万件で重いため、単純な文字列パターンは
// Aho-Corasick 風の「部分文字列インデックス」で絞り込み、複雑なものだけ RegExp を使う。

const MAX_RULES = 120_000;

// YouTube 自社の再生計測は通す(視聴履歴がブロックされるとミックスが育たなくなるため)。
// 広告配信系(pagead / doubleclick)はブロックのまま。
// ptracking の実URLは「/ptracking?…」でスラッシュを挟まないため、
// 「/」終端のパターンでは例外が効かない(EasyList の
// ||youtube.com/ptracking?$domain=youtube.com に負けて履歴計測が死んだ)
const FILTER_ALLOW_PREFIX = [
  "@@||www.youtube.com/api/stats/$~third-party",
  "@@||www.youtube.com/ptracking$~third-party",
  "@@||www.youtube.com/youtubei/$~third-party",
  "", // 末尾に改行を保証(連結先の先頭行と繋がると最後の例外ルールが壊れる)
].join("\n");

// filter → RegExp 変換(Adblock 構文のサブセット)
function ruleToRegExp(pattern) {
  // || = ドメインアンカー: ホスト名の途中で始まらない( . を前に要求)。
  // 前置きはループの外で連結する(本体と一緒に文字変換すると二重エスケープで壊れる)
  let prefix = "";
  if (pattern.startsWith("||")) {
    prefix = "^[a-z]+://([^/?#]+\\.)?";
    pattern = pattern.slice(2);
  } else if (pattern.startsWith("|")) {
    prefix = "^";
    pattern = pattern.slice(1);
  }
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "^") re += "[^a-z0-9.%-]";
    else if (c === "|") re += "$"; // 末尾アンカー
    else re += c.replace(/[.+?${}()[\]\\]/g, "\\$&");
  }
  return new RegExp(prefix + re, "i");
}

// $options を解析。対応していない組み合わせは null(ルール採用せず)を返す
function parseOptions(optStr) {
  if (!optStr) return { types: null, thirdParty: null, domains: null, domainsInverse: null };
  const out = { types: null, thirdParty: null, domains: null, domainsInverse: null };
  for (const opt of optStr.split(",")) {
    if (!opt) continue;
    if (opt.startsWith("~")) {
      const o = opt.slice(1);
      if (o === "third-party") out.thirdParty = false;
      else if (o === "script" || o === "image" || o === "subdocument" || o === "stylesheet" || o === "xmlhttprequest" || o === "media" || o === "font" || o === "websocket" || o === "other" || o === "popup" || o === "document") {
        // 「この種類以外」のルールは複雑化するため無視(取りこぼし許容)
        if (out.types === undefined) out.types = undefined;
        return null;
      } else if (o.startsWith("domain=")) return null;
      else return null;
    } else if (opt === "third-party") out.thirdParty = true;
    else if (opt === "first-party") out.thirdParty = false;
    else if (opt.startsWith("domain=")) {
      const list = opt.slice(7).split("|");
      const pos = [], neg = [];
      for (const d of list) {
        if (!d) continue;
        if (d.startsWith("~")) neg.push(d.slice(1));
        else pos.push(d);
      }
      out.domains = pos.length ? pos : null;
      out.domainsInverse = neg.length ? neg : null;
    } else if (["script", "image", "subdocument", "stylesheet", "xmlhttprequest", "media", "font", "websocket", "other", "popup", "document", "object"].includes(opt)) {
      // リソース種別: Electron の webRequest resourceType と対応付ける
      out.types ??= [];
      out.types.push(opt);
    } else {
      // desconly, webrtc, ping など未対応
      return null;
    }
  }
  return out;
}

// Electron resourceType → filter 種別名
const RESOURCE_TYPE_MAP = {
  script: "script",
  image: "image",
  subFrame: "subdocument",
  stylesheet: "stylesheet",
  xhr: "xmlhttprequest",
  media: "media",
  font: "font",
  websocket: "websocket",
  other: "other",
  mainFrame: "document",
  cspReport: null,
  ping: null,
  webTransport: null,
};

class AdblockEngine {
  constructor() {
    this.blockRules = [];   // { re, options }
    this.allowRules = [];   // @@ ルール
    this.ruleCount = 0;
    this.listVersion = "";
    // 高速化: パターン中の 4 文字以上のリテラル列を鍵にしたインデックス。
    // 正規表現が URL にマッチするなら鍵も必ず URL に含まれるため、鍵が無いルールは
    // 評価を丸ごとスキップできる(78k ルールの線形走査がメインプロセスを詰まらせていた)
    this.allowIndex = new Map();
    this.blockIndex = new Map();
    this.allowAny = [];
    this.blockAny = [];
  }

  // パターンからインデックス鍵(小文字リテラルの先頭6字)とリテラル全体を取り出す。
  // 鍵が URL に含まれなければ正規表現は絶対にマッチしないので評価をスキップできる
  literalKey(pattern) {
    let p = pattern;
    if (p.startsWith("||")) p = p.slice(2);
    else if (p.startsWith("|")) p = p.slice(1);
    let best = "", cur = "";
    for (const c of p.toLowerCase()) {
      if (c === "*" || c === "^" || c === "|") {
        if (cur.length > best.length) best = cur;
        cur = "";
      } else cur += c;
    }
    if (cur.length > best.length) best = cur;
    // 6 文字以上のリテラル列を持つルールだけインデックス化する(短いものは常に全走査)
    return best.length >= 6 ? { key: best.slice(0, 6), run: best } : null;
  }

  indexRule(map, anyList, key, rule) {
    if (key) {
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(rule);
    } else {
      anyList.push(rule);
    }
  }

  // 1 行をルール化。採用しない行は null
  parseLine(line) {
    if (!line || line.startsWith("!") || line.startsWith("[") || line.length > 2000) return null;
    if (line.startsWith("#")) return null; // element hiding(cosmetic)は webRequest では扱えない
    let isAllow = false;
    if (line.startsWith("@@")) { isAllow = true; line = line.slice(2); }
    const dollar = line.lastIndexOf("$");
    let options = null;
    if (dollar > 0 && dollar < line.length - 1) {
      options = parseOptions(line.slice(dollar + 1));
      if (options === null) return null;
      line = line.slice(0, dollar);
    }
    if (!line) return null;
    try {
      const re = ruleToRegExp(line);
      const keyInfo = this.literalKey(line);
      return { isAllow, re, options, key: keyInfo?.key ?? null, run: keyInfo?.run ?? null };
    } catch {
      return null;
    }
  }

  loadFromText(text) {
    const block = [], allow = [];
    // 前回ロード分の ruleCount を引きずると再ロード(定期リフレッシュ)で
    // 上限到達と誤判定され、8万件超のリストが3分の1に刈り込まれた。毎回0から数える
    this.ruleCount = 0;
    for (const raw of text.split("\n")) {
      if (block.length + allow.length > MAX_RULES) break;
      const line = raw.trim();
      if (line.startsWith("! Version:")) this.listVersion = line.slice(10).trim();
      const parsed = this.parseLine(line);
      if (!parsed) continue;
      (parsed.isAllow ? allow : block).push({ re: parsed.re, options: parsed.options, key: parsed.key, run: parsed.run });
    }
    this.blockRules = block;
    this.allowRules = allow;
    this.ruleCount = block.length + allow.length;
    // インデックスを再構築
    this.allowIndex = new Map();
    this.blockIndex = new Map();
    this.allowAny = [];
    this.blockAny = [];
    for (const r of allow) this.indexRule(this.allowIndex, this.allowAny, r.key, r);
    for (const r of block) this.indexRule(this.blockIndex, this.blockAny, r.key, r);
    return this.ruleCount;
  }

  // URL がブロック対象か判定
  shouldBlock(url, sourceDomain, resourceType) {
    const lower = url.toLowerCase();
    const mapped = RESOURCE_TYPE_MAP[resourceType] ?? resourceType;
    const isThird = sourceDomain ? !this.isSubdomainOf(this.hostOf(lower), sourceDomain) : null;

    // 先に例外(@@)を評価
    if (this.hasMatch(this.allowIndex, this.allowAny, lower)) {
      for (const r of this.candidates(this.allowIndex, this.allowAny, lower)) {
        if (!r.re.test(lower)) continue;
        if (!this.optionsMatch(r.options, lower, mapped, isThird, sourceDomain, true)) continue;
        return false;
      }
    }
    for (const r of this.candidates(this.blockIndex, this.blockAny, lower)) {
      if (!r.re.test(lower)) continue;
      if (!this.optionsMatch(r.options, lower, mapped, isThird, sourceDomain, false)) continue;
      return true;
    }
    return false;
  }

  candidates(index, anyList, lower) {
    // 鍵(6文字)の窓で候補を集め、リテラル全体が含まれるものだけ残す
    const seen = anyList.slice();
    for (let i = 0; i + 6 <= lower.length; i++) {
      const arr = index.get(lower.slice(i, i + 6));
      if (arr) {
        for (const r of arr) {
          if (seen.includes(r)) continue;
          if (lower.includes(r.run)) seen.push(r);
        }
      }
    }
    return seen;
  }

  hasMatch(index, anyList, lower) {
    if (anyList.length) return true;
    // 鍵は 6 文字(candidates と同じ窓幅に揃える。4 文字だと絶対に一致しない)
    for (let i = 0; i + 6 <= lower.length; i++) {
      if (index.has(lower.slice(i, i + 6))) return true;
    }
    return false;
  }

  optionsMatch(opt, url, resourceType, isThird, sourceDomain, isAllow) {
    if (!opt) return true;
    if (opt.types && !opt.types.includes(resourceType)) return false;
    if (opt.thirdParty !== null) {
      if (isThird === null) {
        // 参照元が取れない要求は第三者判定が不明。ブロック側は誤ブロックを
        // 避けて見送る(取りこぼし優先)。例外側は緩く適用する(偽免除≪偽ブロック)
        if (!isAllow) return false;
      } else if (opt.thirdParty !== isThird) {
        return false;
      }
    }
    if (opt.domains || opt.domainsInverse) {
      if (!sourceDomain) return false; // 参照先が不明なら domain 条件付きは適用しない
      // Adblock 規格の domain= は「このルールが適用されるページ(参照元)」の指定。
      // リクエスト先ホスト(url)ではなく参照元ドメインと比較する
      if (opt.domains && !opt.domains.some(d => this.isSubdomainOf(sourceDomain, d))) return false;
      if (opt.domainsInverse && opt.domainsInverse.some(d => this.isSubdomainOf(sourceDomain, d))) return false;
    }
    return true;
  }

  hostOf(url) {
    const m = url.match(/^https?:\/\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : "";
  }

  isSubdomainOf(host, domain) {
    return host === domain || host.endsWith("." + domain);
  }
}

module.exports = { AdblockEngine, FILTER_ALLOW_PREFIX };
