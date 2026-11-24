// Ventanas de los juegos web: la pantalla completa del juego (requestFullscreen) pasa a ser la de la ventana.
// La de HTML se quita sola con Escape, y los juegos usan Escape para el menú; la de la ventana solo con F11 o el botón.
"use strict";
const { ipcRenderer, webFrame } = require("electron");

ipcRenderer.on("pantalla-completa", (e, si) => {
  webFrame.executeJavaScript(`window.__pcVentana && window.__pcVentana(${si ? "true" : "false"})`);
});
// Desde la página no se puede llamar a ipcRenderer: avisa con un mensaje que lee este preload
window.addEventListener("message", (e) => {
  if (e.source === window && e.data && e.data.__pantallaCompleta !== undefined) ipcRenderer.send("pantalla-completa", !!e.data.__pantallaCompleta);
});

webFrame.executeJavaScript(`(() => {
  let si = false;
  const D = Document.prototype, E = Element.prototype;
  const el = () => (si ? document.documentElement : null);
  for (const k of ["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement"])
    Object.defineProperty(D, k, { configurable: true, get: el });
  Object.defineProperty(D, "webkitIsFullScreen", { configurable: true, get: () => si });
  const cambiar = (v) => {
    if (v === si) return;
    si = v;
    document.dispatchEvent(new Event("fullscreenchange"));
    document.dispatchEvent(new Event("webkitfullscreenchange"));
  };
  const pedir = (v) => { cambiar(v); postMessage({ __pantallaCompleta: v }, "*"); return Promise.resolve(); };
  E.requestFullscreen = E.webkitRequestFullscreen = E.webkitRequestFullScreen = function () { return pedir(true); };
  D.exitFullscreen = D.webkitExitFullscreen = D.webkitCancelFullScreen = function () { return pedir(false); };
  window.__pcVentana = cambiar;   // F11 o el sistema: la ventana avisa
})();`);
