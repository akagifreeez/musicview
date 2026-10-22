// youtube.com 行の expiry の桁分布を見る(値自体は出さない)
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const src = process.argv[2];
const tmp = path.join(os.tmpdir(), "ckprobe2");
await fs.mkdir(tmp, { recursive: true });
await fs.copyFile(src, path.join(tmp, "cookies.sqlite"));
for (const ext of ["-wal", "-shm"]) {
  await fs.copyFile(src + ext, path.join(tmp, "cookies.sqlite" + ext)).catch(() => {});
}
const db = new DatabaseSync(path.join(tmp, "cookies.sqlite"));
const rows = db.prepare("SELECT name, expiry FROM moz_cookies WHERE host LIKE '%youtube.com'").all();
const nowSec = Math.floor(Date.now() / 1000);
const bucket = { past: 0, sec: 0, ms: 0, us: 0, zero: 0 };
const samples = [];
for (const r of rows) {
  if (r.expiry === 0) { bucket.zero++; continue; }
  if (r.expiry > 1e14) bucket.us++;
  else if (r.expiry > 1e11) bucket.ms++;
  else if (r.expiry > 1e8) bucket.sec++;
  else bucket.past++;
  if (samples.length < 8 && r.name.match(/^(SID|SAPISID|__Secure-1PSID|__Secure-1PSIDTS|LOGIN_INFO|YSC|PREF)$/)) {
    const sec = r.expiry > 1e11 ? Math.floor(r.expiry / 1000) : r.expiry;
    samples.push(`${r.name} raw=${r.expiry} -> sec=${sec} (${sec > nowSec ? Math.round((sec - nowSec) / 86400) + "d先" : "過去"})`);
  }
}
console.log("rows:", rows.length, "buckets:", JSON.stringify(bucket));
for (const s of samples) console.log(s);
