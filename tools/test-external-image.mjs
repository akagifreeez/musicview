// 外部画像URL(YouTubeサムネ)がDiscordのプレゼンスで表示されるかの
// クリーンテスト。musicview本体を終了してから実行すること。
// 使い方: node tools/test-external-image.mjs [ytimg URL]
import net from "node:net";
import crypto from "node:crypto";

const CLIENT_ID = process.argv[2] ?? "";
const IMAGE_URL = process.argv[3] ?? "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";

if (!CLIENT_ID) {
  console.error("usage: node tools/test-external-image.mjs <client_id> [image_url]");
  process.exit(1);
}

const OP = { HANDSHAKE: 0, FRAME: 1, PING: 3 };
function encode(op, obj) {
  const p = Buffer.from(JSON.stringify(obj ?? {}));
  const b = Buffer.alloc(8 + p.length);
  b.writeUInt32LE(op, 0);
  b.writeUInt32LE(p.length, 4);
  p.copy(b, 8);
  return b;
}

const sock = net.createConnection("\\\\.\\pipe\\discord-ipc-0");
sock.on("connect", () => {
  console.log("connected");
  sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: CLIENT_ID }));
});
let acc = Buffer.alloc(0);
sock.on("data", (chunk) => {
  acc = Buffer.concat([acc, chunk]);
  while (acc.length >= 8) {
    const op = acc.readUInt32LE(0);
    const len = acc.readUInt32LE(4);
    if (acc.length < 8 + len) break;
    const payload = JSON.parse(acc.subarray(8, 8 + len).toString("utf8") || "{}");
    acc = acc.subarray(8 + len);
    if (op === OP.FRAME && payload.evt === "READY") {
      console.log("ready — sending presence with external image");
      sock.write(encode(OP.FRAME, {
        cmd: "SET_ACTIVITY",
        args: {
          pid: process.pid,
          activity: {
            details: "外部画像テスト: サムネが出ればOK",
            state: "60秒間表示されます",
            assets: { large_image: IMAGE_URL, large_text: "テスト画像" },
            timestamps: { start: Date.now() },
          },
        },
        nonce: crypto.randomUUID(),
      }));
    } else if (payload.evt === "ERROR") {
      console.log("ERROR:", JSON.stringify(payload.data ?? payload));
    }
  }
});
sock.on("error", (e) => {
  console.log("pipe error:", e.code ?? e.message);
  process.exit(1);
});
setTimeout(() => { console.log("done (60s elapsed)"); sock.destroy(); process.exit(0); }, 60000);
console.log(`image: ${IMAGE_URL}`);
console.log("waiting for pipe connect...");
