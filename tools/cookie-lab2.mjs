// importYoutubeCookies を窓なしの裸アプリで回し、クッキーが自然消滅するかを見る
import { app, session } from "electron";
import { importYoutubeCookies } from "../electron/browser-import.mjs";

app.userAgentFallback = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

app.whenReady().then(async () => {
  const log = (...a) => console.log("lab2:", ...a);
  const ses = session.fromPartition("persist:cookie-lab2");
  await importYoutubeCookies(ses, app.userAgentFallback, log);
  const count = async (tag) => {
    const cs = await ses.cookies.get({});
    let yt = 0, g = 0;
    for (const c of cs) {
      const h = c.domain.replace(/^\./, "");
      if (h.endsWith("youtube.com")) yt++;
      else if (h.endsWith("google.com")) g++;
    }
    log(`count[${tag}]: total=${cs.length} youtube=${yt} google=${g}`);
  };
  await count("t+0");
  await new Promise(r => setTimeout(r, 2000));
  await count("t+2s");
  await new Promise(r => setTimeout(r, 4000));
  await count("t+6s");
  // 生 fetch でサーバ判定も見る
  const cs = await ses.cookies.get({});
  const header = cs.filter(c => c.domain.replace(/^\./, "").endsWith("youtube.com") || c.domain.replace(/^\./, "").endsWith("google.com"))
    .map(c => `${c.name}=${c.value}`).join("; ");
  try {
    const res = await fetch("https://www.youtube.com/", { headers: { Cookie: header, "User-Agent": app.userAgentFallback } });
    const html = await res.text();
    log("live-fetch:", !html.includes("/ServiceLogin") ? "LOGGED-IN" : "logged-out");
  } catch (e) {
    log("live-fetch err:", e.message);
  }
  app.exit(0);
});
