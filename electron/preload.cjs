// UI(renderer/index.html)向けの安全なブリッジ。contextIsolation 下で window.musicview を生やす
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("musicview", {
  poll: () => ipcRenderer.invoke("mv:poll"),
  cmd: (name, arg) => ipcRenderer.invoke("mv:cmd", name, arg),
  navigate: (url) => ipcRenderer.invoke("mv:navigate", url),
  search: (q) => ipcRenderer.invoke("mv:search", q),
  login: () => ipcRenderer.invoke("mv:login"),
  importCookies: () => ipcRenderer.invoke("mv:import-cookies"),
  mix: () => ipcRenderer.invoke("mv:mix"),
  openRec: (id, mix) => ipcRenderer.invoke("mv:open-rec", { id, mix }),
  setMode: (m) => ipcRenderer.invoke("mv:set-mode", m),
  getMode: () => ipcRenderer.invoke("mv:get-mode"),
  shuffleNext: () => ipcRenderer.invoke("mv:shuffle-next"),
  setXfade: (sec) => ipcRenderer.invoke("mv:set-xfade", sec),
  setLoop: (on) => ipcRenderer.invoke("mv:set-loop", on),
  setEq: (gains) => ipcRenderer.invoke("mv:set-eq", gains),
  setViz: (on) => ipcRenderer.invoke("mv:set-viz", on),
  getDiscordId: () => ipcRenderer.invoke("mv:dc-id-get"),
  setDiscordId: (id) => ipcRenderer.invoke("mv:dc-id-set", id),
  onViz: (fn) => ipcRenderer.on("mv:viz", (_e, d) => fn(d)),
  onRecs: (fn) => ipcRenderer.on("mv:recs", (_e, d) => fn(d)),
  onMode: (fn) => ipcRenderer.on("mv:mode", (_e, m) => fn(m)),
});
