// セッション Cookie が「生のfetchでは有効」なのに「ブラウザのナビゲーションでは無効化される」
// 原因を切り分ける: Sec-CH-UA 等のクライアントヒントの有無で応答が変わるかを見る
import { app, session } from "electron";

app.userAgentFallback = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

app.whenReady().then(async () => {
  const log = (...a) => console.log("lab3:", ...a);
  const ses = session.fromPartition("persist:cookie-lab2"); // cookie-lab2 で取り込んだクッキーが残っている
  const cs = await ses.cookies.get({});
  const header = cs
    .filter(c => {
      const h = c.domain.replace(/^\./, "");
      return h.endsWith("youtube.com") || h.endsWith("google.com");
    })
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
  log("cookies:", cs.length, "headerParts:", header.split("; ").length);
  if (!header) { log("no cookies in persist:cookie-lab2 — run cookie-lab2 first"); app.exit(1); return; }

  const v = process.versions.chrome.split(".")[0];
  const tests = [
    { tag: "A: UA only", headers: { Cookie: header, "User-Agent": app.userAgentFallback } },
    { tag: "B: +sec-ch-ua Chromium", headers: {
      Cookie: header, "User-Agent": app.userAgentFallback,
      "sec-ch-ua": `"Chromium";v="${v}"`, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
    } },
    { tag: "C: +sec-ch-ua Chrome", headers: {
      Cookie: header, "User-Agent": app.userAgentFallback,
      "sec-ch-ua": `"Google Chrome";v="${v}", "Chromium";v="${v}", "Not-A.Brand";v="99"`, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
    } },
  ];
  for (const t of tests) {
    try {
      const res = await fetch("https://www.youtube.com/", { headers: t.headers });
      const html = await res.text();
      log(t.tag, "→", !html.includes("/ServiceLogin") ? "LOGGED-IN" : "logged-out",
        `(set-cookie-clear=${/SID=;\s*Expires=1970|Max-Age=0/i.test(html) ? "n/a-body" : "-"})`);
    } catch (e) {
      log(t.tag, "err:", e.message);
    }
  }
  app.exit(0);
});
