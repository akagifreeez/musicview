// Firefox / Floorp の cookies.sqlite から YouTube のログインセッションを取り込む。
// Electron の Google ログインは「安全ではないブラウザ」で蹴られるため、
// 普段のブラウザで既に成立しているセッションを複製する(yt-dlp の --cookies-from-browser 相当)。
// Cookie の値をログに出してはいけない(名前と件数のみ扱う)
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

export async function findCookieDbs() {
  const roots = [
    path.join(process.env.APPDATA ?? "", "Mozilla", "Firefox", "Profiles"),
    path.join(process.env.APPDATA ?? "", "Floorp", "Profiles"),
  ];
  const out = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue; // ブラウザ未インストール
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const db = path.join(root, e.name, "cookies.sqlite");
      try {
        const st = await fs.stat(db);
        out.push({ db, profile: e.name, mtime: st.mtimeMs, browser: path.basename(path.dirname(root)) });
      } catch { /* このプロファイルに cookies.sqlite 無し */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// 実ブラウザが使用中でも読めるよう、DB を一時ディレクトリに複製してから開く。
// 新しいクッキーは WAL 側に乗ることがあるため -wal/-shm も一緒に複製する
async function snapshotDb(dbPath, tag) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `musicview-ck-${tag}-`));
  const dest = path.join(tmp, "cookies.sqlite");
  await fs.copyFile(dbPath, dest);
  for (const ext of ["-wal", "-shm"]) {
    try {
      await fs.copyFile(dbPath + ext, dest + ext);
    } catch { /* 無ければ良い */ }
  }
  return { tmp, dest };
}

// クッキー行で生 fetch して YouTube に認識されるか確かめる。
// SAPISID はログアウト後も残り続けるため「有無」では生きたセッションと判別できない。
// ログアウト状態のホーム HTML には ServiceLogin へのリンクが入るので、それが無ければ生きている
async function testLoginWith(rows, ua) {
  const header = rows
    .map(r => `${r.name}=${r.value}`)
    .join("; ");
  try {
    const res = await fetch("https://www.youtube.com/", {
      headers: { Cookie: header, "User-Agent": ua },
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    return { live: !html.includes("/ServiceLogin"), marker: html.includes('"loggedIn":true') };
  } catch {
    return { live: false, marker: false };
  }
}

// 取り込むのはセッション成立に必要な最小セット。
// 全クッキーを入れると Cookie ヘッダが YouTube のサイズ上限を超え 413 になる(実走で確認済み)
export const SESSION_NAMES = [
  "SID", "HSID", "SSID", "APISID", "SAPISID",
  "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS", "__Secure-1PSIDCC", "__Secure-3PSIDCC",
  "LOGIN_INFO", "YSC", "VISITOR_INFO1_LIVE", "PREF", "SOCS", "__Secure-YEC",
];

export async function importYoutubeCookies(ses, ua, log = () => {}) {  const dbs = await findCookieDbs();
  if (!dbs.length) return { ok: false, reason: "no-browser-profiles" };

  const candidates = [];
  for (const cand of dbs) {
    const { tmp, dest } = await snapshotDb(cand.db, cand.profile.slice(0, 6));
    try {
      const db = new DatabaseSync(dest);
      const rows = db.prepare(
        `SELECT name, value, host, path, isSecure, isHttpOnly, expiry, sameSite FROM moz_cookies
         WHERE (host LIKE '%youtube.com' OR host LIKE '%google.com')
           AND name IN (${SESSION_NAMES.map(() => "?").join(",")})`,
      ).all(...SESSION_NAMES);
      db.close();
      const has = rows.some(r => r.name === "SAPISID" || r.name === "__Secure-1PSID" || r.name === "__Secure-3PSID");
      log(`cookie db ${cand.browser}/${cand.profile}: ${rows.length} rows, session=${has}, mtime=${new Date(cand.mtime).toISOString()}`);
      if (rows.length) candidates.push({ ...cand, rows, has });
    } catch (e) {
      log(`cookie db ${cand.browser}/${cand.profile}: read failed (${e.message})`);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (!candidates.length) return { ok: false, reason: "no-youtube-cookies" };

  // 「セッション付き」候補を生 fetch で実際に認証し、生きているプロファイルを探す。
  // 新しいものから試す(1つでも生きていれば十分)
  const withSession = candidates.filter(c => c.has).sort((a, b) => b.mtime - a.mtime);
  for (const c of withSession) {
    const t = await testLoginWith(c.rows, ua);
    c.live = t.live;
    log(`live-check ${c.browser}/${c.profile}: live=${t.live}`);
    if (t.live) break;
  }
  // 生きているセッション → 無ければセッション付き → 無ければ件数最大のもの
  const chosen = withSession.find(c => c.live)
    ?? withSession[0]
    ?? candidates.sort((a, b) => b.mtime - a.mtime)[0];
  if (withSession.length && !withSession.some(c => c.live)) {
    log("no live session in any profile (cookie remaining after logout is likely)");
  }

  // 再取り込みの前に既存の YouTube/Google クッキーを掃除する(古いセッションの混在を防ぐ)。
  // ただし Electron の cookies.remove() はネットワークサービス側への命令が遅れて処理される
  // ことがあり、直後の set() を上書きして消す観測があるため、切り分け用に停止できる
  if (process.env.MUSICVIEW_NO_CLEAR !== "1") {
    const old = await ses.cookies.get({});
    let removed = 0;
    for (const c of old) {
      const host = c.domain.replace(/^\./, "");
      if (!(host === "youtube.com" || host.endsWith(".youtube.com") || host === "google.com" || host.endsWith(".google.com"))) continue;
      try {
        await ses.cookies.remove(`https://${host}${c.path || "/"}`, c.name);
        removed++;
      } catch { /* 既に無いものは無視 */ }
    }
    log(`cleared ${removed} old cookies from partition`);
  }

  let set = 0;
  const failed = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const r of chosen.rows) {
    const hostOnly = !r.host.startsWith(".");
    const host = r.host.replace(/^\./, "");
    const params = {
      url: `https://${host}${r.path || "/"}`,
      name: r.name,
      value: r.value,
      path: r.path || "/",
      secure: !!r.isSecure || r.name.startsWith("__Secure-") || r.name.startsWith("__Host-"),
      httpOnly: !!r.isHttpOnly,
    };
    if (!hostOnly) params.domain = r.host;
    // Firefox の expiry は最近の DB ではミリ秒(1e12 超)、旧 DB では秒。
    // Electron の expirationDate は秒。ミリ秒を秒と誤って渡すと 1970 年期限切れになり
    // Chromium はそのクッキーを一切送らなくなる(ログインが反映されない原因になる)
    if (r.expiry > 0) {
      const sec = r.expiry > 1e11 ? Math.floor(r.expiry / 1000) : r.expiry;
      if (sec > nowSec) params.expirationDate = sec;
    }
    // sameSite: moz_cookies は 0=none / 1=lax / 2=strict
    if (r.sameSite === 0) params.sameSite = "no_restriction";
    else if (r.sameSite === 1) params.sameSite = "lax";
    else if (r.sameSite === 2) params.sameSite = "strict";
    try {
      await ses.cookies.set(params);
      set++;
    } catch {
      // sameSite 指定が拒否された場合は素の値で再試行
      try {
        delete params.sameSite;
        await ses.cookies.set(params);
        set++;
      } catch {
        failed.push(r.name); // 値は出さない(名前のみ)
      }
    }
  }

  const session = !!chosen.has;
  log(`imported ${set} cookies from ${chosen.browser}/${chosen.profile} session=${session} live=${!!chosen.live}${failed.length ? ` failed=${failed.join(",")}` : ""}`);
  return { ok: set > 0, imported: set, session, live: !!chosen.live, profile: `${chosen.browser}/${chosen.profile}`, failed };
}
