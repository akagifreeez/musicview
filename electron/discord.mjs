// Discord Rich Presence クライアント(依存ゼロ)。
// Discord デスクトップアプリのローカル名前付きパイプ(\\.\pipe\discord-ipc-N)に
// 直接接続して SET_ACTIVITY を送る。npm パッケージは使わない。
// クライアントIDは Discord Developer Portal で作成したアプリケーションIDを使用する。
import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function pipePath(index) {
  // 他クライアントが占有している場合は 0〜9 を順に試す
  return `\\\\.\\pipe\\discord-ipc-${index}`;
}

function encode(op, obj) {
  const payload = Buffer.from(JSON.stringify(obj ?? {}));
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32LE(op, 0);
  buf.writeUInt32LE(payload.length, 4);
  payload.copy(buf, 8);
  return buf;
}

export class DiscordPresence {
  constructor(clientId, log = () => {}) {
    this.clientId = clientId;
    this.log = log;
    this.sock = null;
    this.connected = false;
    this.lastActivity = null;
    this.ping = null;
    this.retry = null;
    this.closed = false;
  }

  start() {
    if (!this.clientId) {
      this.log("discord: client id not set (disabled)");
      return;
    }
    this.connect();
  }

  connect(pipeIndex = 0) {
    if (this.closed) return;
    if (pipeIndex > 9) {
      this.log("discord pipe not found (0-9)");
      this.scheduleRetry();
      return;
    }
    this.pipeIndex = pipeIndex;
    const sock = net.connect(pipePath(pipeIndex));
    this.sock = sock;
    sock.on("connect", () => {
      this.log(`discord pipe ${pipeIndex} connected`);
      sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
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
        this.onFrame(op, payload);
      }
    });
    sock.on("error", (e) => {
      // Discord 未起動/パイプ未作成(ENOENT)は静かに次の候補へ
      if (e.code === "ENOENT" && pipeIndex < 9) {
        this.drop();
        this.connect(pipeIndex + 1);
        return;
      }
      this.log(`discord pipe error: ${e.code ?? e.message}`);
      this.drop();
    });
    sock.on("close", () => {
      this.connected = false;
      this.scheduleRetry();
    });
  }

  onFrame(op, payload) {
    if (op === OP.CLOSE) {
      this.log(`discord closed: ${payload?.message ?? ""}`);
      try { this.sock?.destroy(); } catch { /* 無視 */ }
      return;
    }
    if (op === OP.PING) {
      try { this.sock?.write(encode(OP.PONG, payload?.data ?? {})); } catch { /* 無視 */ }
      return;
    }
    if (op === OP.HANDSHAKE || (op === OP.FRAME && payload?.evt === "READY")) {
      this.connected = true;
      this.log("discord ready");
      if (this.lastActivity) this.sendActivity(this.lastActivity);
      if (!this.ping) this.ping = setInterval(() => {
        try { this.sock?.write(encode(OP.PING, Date.now())); } catch { /* 無視 */ }
      }, 11000);
      return;
    }
    // コマンドへの応答(エラーはここに載ってくる)
    if (op === OP.FRAME && payload?.evt === "ERROR") {
      this.log(`discord reply ERROR: code=${payload?.data?.code} message=${payload?.data?.message}`);
    }
  }

  scheduleRetry() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.connected) this.connect();
    }, 15000);
  }

  sendActivity(a) {
    if (!this.connected || !this.sock) {
      this.log("discord: not connected, skip send");
      return;
    }
    const activity = { instance: true };
    if (a.details) activity.details = String(a.details).slice(0, 128);
    if (a.state) activity.state = String(a.state).slice(0, 128);
    if (a.startAt) activity.timestamps = { start: a.startAt };
    if (a.largeImage || a.largeText) {
      activity.assets = {};
      // 外部URLはそのまま渡す(mp:external は署名が必要なため個人アプリでは使えない)
      if (a.largeImage) activity.assets.large_image = a.largeImage;
      if (a.largeText) activity.assets.large_text = String(a.largeText).slice(0, 128);
    }
    if (a.type != null) activity.type = a.type; // 2 = LISTENING(〜を再生中)
    if (a.statusDisplayType != null) activity.status_display_type = a.statusDisplayType;
    if (Array.isArray(a.buttons) && a.buttons.length) {
      activity.buttons = a.buttons.slice(0, 2).map(b => ({
        label: String(b.label).slice(0, 32),
        url: String(b.url),
      }));
    }
    this.sock.write(encode(OP.FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity },
      nonce: crypto.randomUUID(),
    }));
    this.log(`discord: activity sent (${String(a.details ?? "").slice(0, 40)})`);
  }

  // 再生状態の反映。内容が変わっていなければ送らない(force で強制送信)
  update(a) {
    this.lastActivity = a;
    if (!this.connected) return;
    const key = `${a.details}|${a.state}|${a.startAt ?? ""}|${a.largeImage ?? ""}`;
    if (!a.force && key === this.lastKey) return;
    this.lastKey = key;
    this.sendActivity(this.lastActivity);
  }

  clear() {
    if (this.connected && this.sock) {
      this.sock.write(encode(OP.FRAME, {
        cmd: "SET_ACTIVITY",
        args: { pid: process.pid },
        nonce: crypto.randomUUID(),
      }));
    }
    this.lastActivity = null;
    this.lastKey = "";
  }

  drop() {
    try { this.sock?.destroy(); } catch { /* 無視 */ }
    this.sock = null;
    this.connected = false;
  }

  close() {
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    if (this.retry) clearTimeout(this.retry);
    this.drop();
  }
}
