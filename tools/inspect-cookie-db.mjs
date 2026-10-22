// cookies.sqlite のスキーマと期限列の単位を確認する一度きりの診断スクリプト
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";

const dbPath = path.join(os.tmpdir(), "ckprobe", "cookies.sqlite");
const db = new DatabaseSync(dbPath);
const cols = db.prepare("PRAGMA table_info(moz_cookies)").all();
console.log("columns:", cols.map(c => c.name).join(","));
const rows = db.prepare(
  "SELECT name, expiry, creationTime, lastAccessed FROM moz_cookies WHERE name IN ('SID','SAPISID','__Secure-1PSID') LIMIT 4",
).all();
const now = Math.floor(Date.now() / 1000);
for (const r of rows) {
  console.log(r.name, "expiry=" + r.expiry, "creation=" + r.creationTime, "last=" + r.lastAccessed, "now=" + now);
}
