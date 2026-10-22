// アイコン(SVG→PNG)を生成するツール。assets/icon.png に出力する
// 使い方: npx electron tools/make-icon.mjs
import { app, BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#26262a"/>
      <stop offset="1" stop-color="#121214"/>
    </linearGradient>
    <linearGradient id="red" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff5f6d"/>
      <stop offset="1" stop-color="#fa233b"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="100" fill="url(#bg)"/>
  <g fill="url(#red)">
    <rect x="100" y="200" width="54" height="150" rx="27"/>
    <rect x="182" y="136" width="54" height="278" rx="27"/>
    <rect x="264" y="170" width="54" height="210" rx="27"/>
    <rect x="346" y="106" width="54" height="336" rx="27"/>
  </g>
  <circle cx="256" cy="256" r="148" fill="rgba(14,14,16,0.60)"/>
  <path d="M224 184 L348 256 L224 328 Z" fill="#ffffff"/>
  <circle cx="256" cy="256" r="148" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: true,
    frame: false,
    resizable: false,
    useContentSize: true,
    webPreferences: { offscreen: false },
  });
  await win.loadURL("data:text/html," + encodeURIComponent(
    `<!DOCTYPE html><html><head><style>*{margin:0;padding:0}body{width:512px;height:512px;overflow:hidden}</style></head><body>${SVG}</body></html>`,
  ));
  await new Promise(r => setTimeout(r, 600));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = process.argv[2] ?? path.join(ROOT, "assets", "icon.png");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, img.toPNG());
  console.log("icon saved:", out);
  app.exit(0);
});

