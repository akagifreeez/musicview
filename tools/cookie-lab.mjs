// ses.cookies.set の挙動を最小構成で検証するラボ。
// youtube.com のクッキーがどの属性組み合わせで生存するかを確かめる(YouTube への接続はしない)
import { app, session } from "electron";
import path from "node:path";
import os from "node:os";

app.whenReady().then(async () => {
  const ses = session.fromPartition("persist:cookie-lab");
  const nowSec = Math.floor(Date.now() / 1000);
  const variants = [
    { tag: "domain-dot", params: { url: "https://youtube.com/", name: "LAB_A", value: "x", domain: ".youtube.com", path: "/", secure: true, expirationDate: nowSec + 86400 } },
    { tag: "host-only", params: { url: "https://www.youtube.com/", name: "LAB_B", value: "x", path: "/", secure: true, expirationDate: nowSec + 86400 } },
    { tag: "domain+sameSite", params: { url: "https://youtube.com/", name: "LAB_C", value: "x", domain: ".youtube.com", path: "/", secure: true, sameSite: "no_restriction", expirationDate: nowSec + 86400 } },
    { tag: "domain-no-secure", params: { url: "https://youtube.com/", name: "LAB_D", value: "x", domain: ".youtube.com", path: "/", secure: false, expirationDate: nowSec + 86400 } },
    { tag: "google-dot", params: { url: "https://google.com/", name: "LAB_E", value: "x", domain: ".google.com", path: "/", secure: true, expirationDate: nowSec + 86400 } },
  ];
  for (const v of variants) {
    try {
      await ses.cookies.set(v.params);
      console.log("set ok:", v.tag);
    } catch (e) {
      console.log("set FAIL:", v.tag, e.message);
    }
  }
  for (const wait of [0, 1500, 4000]) {
    await new Promise(r => setTimeout(r, wait));
    const cs = await ses.cookies.get({});
    console.log(`t+${wait}ms:`, cs.map(c => `${c.name}@${c.domain || "(host)"}`).join(" ") || "(none)");
  }
  app.exit(0);
});
