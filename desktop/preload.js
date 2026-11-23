// Puente entre la interfaz (ui/app.js) y el launcher de Windows: window.launcherHost
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcherHost", {
  version: () => ipcRenderer.invoke("version"),
  estado: (juegos) => ipcRenderer.invoke("estado", juegos),
  instalar: (juego, rel) => ipcRenderer.invoke("instalar", juego, rel),
  abrir: (juego) => ipcRenderer.invoke("abrir", juego),
  desinstalar: (juego) => ipcRenderer.invoke("desinstalar", juego),
  cancelar: (id) => ipcRenderer.invoke("cancelar", id),
  carpeta: (juego) => ipcRenderer.invoke("carpeta", juego),
  actualizarLauncher: (rel) => ipcRenderer.invoke("actualizarLauncher", rel),
  onEvento: (cb) => ipcRenderer.on("evento", (e, ev) => cb(ev)),
});
