// Port Launcher para Windows (Electron).
//
// - La interfaz es la misma que en Android (ui/), servida en launcher://app/.
// - Juegos web (PokéIsaac, PokéDive, DB Survivors, PokéSurvivor): la primera vez se baja la APK de Android, que ya
//   trae el juego completo, y se saca de ella la carpeta del juego. Después, con el manifiesto de cada versión
//   (contenido.json), solo se bajan los archivos que cambiaron. Cada juego se abre en su ventana (juego://id/),
//   con sus partidas aparte y sin enlaces que saquen del juego.
// - Juegos con su propio .exe (PokéBonk): se baja su ZIP de Windows, se descomprime y se abre el .exe;
//   se actualizan solos.
"use strict";
const { app, BrowserWindow, ipcMain, protocol, net, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const D = require("./descargas");

// Rendimiento de los juegos: la tarjeta gráfica potente en portátiles con dos GPU y aceleración aunque el driver
// esté en la lista negra de Chromium (si no, el lienzo se dibuja con el procesador y los juegos van a tirones)
app.commandLine.appendSwitch("force_high_performance_gpu");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

protocol.registerSchemesAsPrivileged([
  { scheme: "launcher", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: "juego", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const UI = path.join(__dirname, "ui");
const DATOS = () => path.join(app.getPath("userData"), "juegos");
const dirJuego = (id) => D.dentroDe(DATOS(), id);
const trabajos = new Map();     // id -> AbortController
const ventanas = new Map();     // id -> BrowserWindow
let principal = null;

const TIPOS = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".m4a": "audio/mp4", ".mp4": "video/mp4", ".webm": "video/webm", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml", ".pack": "application/octet-stream", ".bin": "application/octet-stream",
};

async function servir(base, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!rel || rel.endsWith("/")) rel += "index.html";
  let f;
  try { f = D.dentroDe(base, rel); } catch (e) { return new Response("", { status: 403 }); }
  try {
    const st = await fsp.stat(f);
    if (st.isDirectory()) f = path.join(f, "index.html");
  } catch (e) {
    return new Response("", { status: 404 });
  }
  const r = await net.fetch(pathToFileURL(f).toString());
  const h = new Headers(r.headers);
  h.set("Content-Type", TIPOS[path.extname(f).toLowerCase()] || "application/octet-stream");
  h.set("Cache-Control", "no-cache");
  return new Response(r.body, { status: 200, headers: h });
}

function enviar(ev) {
  if (principal && !principal.isDestroyed()) principal.webContents.send("evento", ev);
}

async function leerJson(f) {
  try { return JSON.parse(await fsp.readFile(f, "utf8")); } catch (e) { return null; }
}

function soloLocal(wc) {   // nada de abrir páginas de fuera desde el launcher ni desde los juegos
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e, url) => {
    if (!/^(launcher|juego):/.test(url)) e.preventDefault();
  });
}

function crearPrincipal() {
  principal = new BrowserWindow({
    width: 1100, height: 760, minWidth: 420, minHeight: 500, backgroundColor: "#12101c", title: "Port Launcher",
    icon: path.join(__dirname, "build", "icon.png"), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  soloLocal(principal.webContents);
  principal.loadURL("launcher://app/index.html");
}

// ---------- Estado ----------
async function estado(juegos) {
  // Copia del catálogo para los accesos directos (abren un juego sin pasar por la lista)
  fsp.mkdir(DATOS(), { recursive: true }).then(() => fsp.writeFile(path.join(DATOS(), "catalogo.json"), JSON.stringify(juegos))).catch(() => {});
  const out = {};
  for (const j of juegos) {
    if (!j.windows) continue;
    const v = await leerJson(path.join(dirJuego(j.id), "version.json"));
    out[j.id] = v ? { instalado: true, version: v.tag, actualizable: j.windows.tipo === "web" || !!j.windows.actualizable } : { instalado: false };
  }
  return out;
}

function buscar(rel, patron) {
  const re = new RegExp(patron, "i");
  return (rel.assets || []).find((a) => re.test(a.name));
}

// ---------- Instalar / actualizar ----------
async function instalar(j, rel) {
  if (trabajos.has(j.id)) return;
  const ac = new AbortController();
  trabajos.set(j.id, ac);
  const progreso = (hecho, total, texto) => enviar({ tipo: "progreso", id: j.id, hecho, total, texto });
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "port-launcher-"));
  try {
    if (j.windows.tipo === "web") await instalarWeb(j, rel, ac.signal, progreso, tmp);
    else await instalarZip(j, rel, ac.signal, progreso, tmp);
    enviar({ tipo: "fin", id: j.id, ok: true });
  } catch (e) {
    enviar({ tipo: "fin", id: j.id, ok: false, msg: e.cancelado || ac.signal.aborted ? "" : `${j.nombre}: ${e.message}` });
  } finally {
    trabajos.delete(j.id);
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function instalarWeb(j, rel, signal, progreso, tmp) {
  const w = j.windows;
  const dir = dirJuego(j.id);
  const files = path.join(dir, "files");
  const manAsset = buscar(rel, "^contenido\\.json$");
  if (!manAsset) throw new Error("la versión publicada no trae su manifiesto");
  progreso(0, 0, "Leyendo la versión " + rel.tag);
  const nuevo = await D.json(manAsset.browser_download_url, signal);
  let instalado = await leerJson(path.join(dir, "manifiesto.json"));
  if (instalado && !fs.existsSync(files)) instalado = null;

  if (!instalado) {
    // Primera vez: el juego entero sale de la APK (un solo archivo grande en vez de miles de descargas)
    const apk = buscar(rel, w.apk);
    if (!apk) throw new Error("la versión publicada no trae APK");
    const apkPath = path.join(tmp, "juego.apk");
    let hecho = 0;
    await D.bajar(apk.browser_download_url, apkPath, signal, (n) => { hecho += n; progreso(hecho, apk.size, "Descargando"); });
    const nuevaCarpeta = path.join(dir, "files.nuevo");
    await fsp.rm(nuevaCarpeta, { recursive: true, force: true });
    await fsp.mkdir(nuevaCarpeta, { recursive: true });
    const basePath = path.join(tmp, "contenido-base.json");
    let n = 0;
    progreso(0, 0, "Preparando el juego");
    await D.descomprimir(apkPath, nuevaCarpeta, {
      prefijo: w.dentro, signal, extra: { "assets/contenido-base.json": basePath },
      onEntrada: () => { if (++n % 200 === 0) progreso(0, 0, `Preparando el juego (${n} archivos)`); },
    });
    await fsp.rm(files, { recursive: true, force: true });
    await fsp.rename(nuevaCarpeta, files);
    instalado = (await leerJson(basePath)) || { files: {} };
    await fsp.writeFile(path.join(dir, "manifiesto.json"), JSON.stringify(instalado));
  }
  // Al día con la versión publicada: solo lo que cambió
  await D.sincronizar({ repo: j.repo, raiz: w.raw, dir: files, instalado, nuevo, signal, progreso });
  await fsp.writeFile(path.join(dir, "manifiesto.json"), JSON.stringify(nuevo));
  await fsp.writeFile(path.join(dir, "version.json"), JSON.stringify({ tag: rel.tag, fecha: rel.fecha }));
}

async function instalarZip(j, rel, signal, progreso, tmp) {
  const w = j.windows;
  const dir = dirJuego(j.id);
  const zip = buscar(rel, w.zip);
  if (!zip) throw new Error("la versión publicada no trae la versión de Windows");
  const zipPath = path.join(tmp, "juego.zip");
  let hecho = 0;
  await D.bajar(zip.browser_download_url, zipPath, signal, (n) => { hecho += n; progreso(hecho, zip.size, "Descargando"); });
  const nueva = path.join(dir, "app.nueva");
  await fsp.rm(nueva, { recursive: true, force: true });
  let n = 0;
  progreso(0, 0, "Descomprimiendo");
  await D.descomprimir(zipPath, nueva, { signal, onEntrada: () => { if (++n % 100 === 0) progreso(0, 0, `Descomprimiendo (${n} archivos)`); } });
  // Algunos ZIP traen todo dentro de una carpeta: se usa esa
  let raizApp = nueva;
  const dentro = await fsp.readdir(nueva);
  if (dentro.length === 1 && (await fsp.stat(path.join(nueva, dentro[0]))).isDirectory()) raizApp = path.join(nueva, dentro[0]);
  if (!fs.existsSync(path.join(raizApp, w.exe))) throw new Error(`el ZIP no trae ${w.exe}`);
  await fsp.rm(path.join(dir, "app"), { recursive: true, force: true });
  await fsp.rename(raizApp, path.join(dir, "app"));
  await fsp.rm(nueva, { recursive: true, force: true });
  await fsp.writeFile(path.join(dir, "version.json"), JSON.stringify({ tag: rel.tag, fecha: rel.fecha }));
}

// ---------- Abrir / desinstalar ----------
async function abrir(j) {
  const dir = dirJuego(j.id);
  if (j.windows.tipo === "zip") {
    const exe = path.join(dir, "app", j.windows.exe);
    if (!fs.existsSync(exe)) throw new Error("No está instalado");
    spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: "ignore" }).unref();
    return;
  }
  const v = ventanas.get(j.id);
  if (v && !v.isDestroyed()) { v.show(); v.focus(); return; }
  const win = new BrowserWindow({
    width: 1280, height: 760, backgroundColor: "#000000", title: j.nombre, autoHideMenuBar: true,
    icon: path.join(__dirname, "ui", "iconos", (j.icono || j.id) + ".png"),
    webPreferences: {
      preload: path.join(__dirname, "juego-preload.js"), contextIsolation: true, sandbox: true,
      autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false,
    },
  });
  soloLocal(win.webContents);
  // Pantalla completa de la ventana (Escape no la quita; F11 sí) y el juego se entera de los cambios
  const avisar = () => { if (!win.isDestroyed()) win.webContents.send("pantalla-completa", win.isFullScreen()); };
  win.on("enter-full-screen", avisar);
  win.on("leave-full-screen", avisar);
  win.webContents.on("did-finish-load", avisar);
  win.webContents.on("before-input-event", (e, inp) => {
    if (inp.type === "keyDown" && inp.key === "F11") { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  win.on("page-title-updated", (e) => e.preventDefault());
  ventanas.set(j.id, win);
  win.on("closed", () => ventanas.delete(j.id));
  win.loadURL(`juego://${j.id}/${j.windows.inicio || "index.html"}`);
}

async function desinstalar(j) {
  const v = ventanas.get(j.id);
  if (v && !v.isDestroyed()) v.close();
  // Las partidas de los juegos web se guardan aparte (en el perfil del launcher) y no se borran
  await fsp.rm(dirJuego(j.id), { recursive: true, force: true });
}

/** Acceso directo en el escritorio que abre el juego directamente (Port Launcher.exe --juego=id). */
async function acceso(j) {
  if (process.platform !== "win32") throw new Error("Los accesos directos son solo para Windows");
  const lnk = path.join(app.getPath("desktop"), j.nombre.replace(/[\\/:*?"<>|]/g, "") + ".lnk");
  const zipExe = j.windows.tipo === "zip" ? path.join(dirJuego(j.id), "app", j.windows.exe) : null;
  const ok = shell.writeShortcutLink(lnk, "create", {
    target: process.execPath, args: `--juego=${j.id}`, description: j.nombre,
    icon: zipExe && fs.existsSync(zipExe) ? zipExe : process.execPath, iconIndex: 0,
  });
  if (!ok) throw new Error("No se pudo crear el acceso directo");
}

/** --juego=id (de un acceso directo): abre ese juego. */
async function abrirDesdeArgs(argv) {
  const a = (argv || []).find((x) => x.startsWith("--juego="));
  if (!a) return false;
  const id = a.slice(8);
  const lista = (await leerJson(path.join(DATOS(), "catalogo.json"))) || [];
  const j = lista.find((x) => x.id === id);
  if (!j || !j.windows) return false;
  try { await abrir(j); } catch (e) { return false; }
  return true;
}

async function actualizarLauncher(rel) {
  const a = buscar(rel, "Instalador\\.exe$");
  if (!a) return;
  const ac = new AbortController();
  const f = path.join(os.tmpdir(), "Port-Launcher-Instalador.exe");
  let hecho = 0;
  try {
    await D.bajar(a.browser_download_url, f, ac.signal, (n) => {
      hecho += n;
      enviar({ tipo: "progreso", id: "_launcher", hecho, total: a.size, texto: "Descargando" });
    });
    spawn(f, [], { detached: true, stdio: "ignore" }).unref();
    app.quit();
  } catch (e) {
    enviar({ tipo: "fin", id: "_launcher", ok: false, msg: "No se pudo bajar el launcher nuevo: " + e.message });
  }
}

// ---------- Arranque ----------
const unico = app.requestSingleInstanceLock();
if (!unico) app.quit();
app.on("second-instance", async (e, argv) => {
  if (await abrirDesdeArgs(argv)) return;
  if (!principal || principal.isDestroyed()) return crearPrincipal();
  if (principal.isMinimized()) principal.restore();
  principal.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle("launcher", (req) => servir(UI, new URL(req.url).pathname));
  protocol.handle("juego", (req) => {
    const u = new URL(req.url);
    let base;
    try { base = path.join(dirJuego(u.hostname), "files"); } catch (e) { return new Response("", { status: 403 }); }
    return servir(base, u.pathname);
  });

  ipcMain.handle("version", () => app.getVersion());
  ipcMain.on("pantalla-completa", (e, si) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && w !== principal && w.isFullScreen() !== si) w.setFullScreen(si);
  });
  ipcMain.handle("estado", (e, juegos) => estado(juegos));
  ipcMain.handle("instalar", (e, j, rel) => { instalar(j, rel); });
  ipcMain.handle("abrir", (e, j) => abrir(j));
  ipcMain.handle("desinstalar", (e, j) => desinstalar(j));
  ipcMain.handle("cancelar", (e, id) => { const t = trabajos.get(id); if (t) t.abort(); });
  ipcMain.handle("carpeta", (e, j) => shell.openPath(dirJuego(j.id)));
  ipcMain.handle("actualizarLauncher", (e, rel) => { actualizarLauncher(rel); });
  ipcMain.handle("acceso", (e, j) => acceso(j));

  // Desde un acceso directo se abre solo el juego (los de .exe se lanzan y el launcher se cierra)
  abrirDesdeArgs(process.argv).then((ok) => {
    if (!ok) return crearPrincipal();
    if (BrowserWindow.getAllWindows().length === 0) app.quit();
  });
});

app.on("window-all-closed", () => app.quit());
