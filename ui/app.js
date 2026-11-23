/* Port Launcher — interfaz común de Android y Windows.
 *
 * Lee el catálogo (catalogo.json del repo del launcher; si no hay internet, el que trae la app), mira la última
 * versión publicada de cada juego en GitHub y deja instalar, abrir, actualizar y desinstalar.
 * El trabajo de verdad lo hace la plataforma:
 *   - Android: window.LauncherAndroid (Java) baja la APK y la instala; cada port se actualiza solo después.
 *   - Windows: window.launcherHost (Electron) baja el juego y lo abre en su propia ventana.
 */
"use strict";

const LAUNCHER_REPO = "moportor6-art/Port-Launcher";
const CATALOGO_URL = `https://raw.githubusercontent.com/${LAUNCHER_REPO}/main/catalogo.json`;
const CACHE_MIN = 10;

// ---------- Plataforma ----------
const Host = (() => {
  if (window.launcherHost) {
    const h = window.launcherHost;
    return {
      plataforma: "windows",
      version: () => h.version(),
      estado: (juegos) => h.estado(juegos),
      instalar: (j, rel) => h.instalar(j, rel),
      abrir: (j) => h.abrir(j),
      desinstalar: (j) => h.desinstalar(j),
      cancelar: (id) => h.cancelar(id),
      carpeta: (j) => h.carpeta(j),
      actualizarLauncher: (rel) => h.actualizarLauncher(rel),
      puedeInstalar: () => true,
      onEvento: (cb) => h.onEvento(cb),
    };
  }
  if (window.LauncherAndroid) {
    const a = window.LauncherAndroid;
    const cbs = [];
    window.Launcher = {
      progreso: (id, hecho, total, texto) => cbs.forEach((cb) => cb({ tipo: "progreso", id, hecho, total, texto })),
      fin: (id, ok, msg) => cbs.forEach((cb) => cb({ tipo: "fin", id, ok, msg })),
      refrescar: () => cbs.forEach((cb) => cb({ tipo: "refrescar" })),
    };
    return {
      plataforma: "android",
      version: async () => a.version(),
      estado: async (juegos) => {
        const paquetes = juegos.filter((j) => j.android).map((j) => j.android.paquete);
        const r = JSON.parse(a.estado(JSON.stringify(paquetes)) || "{}");
        const out = {};
        for (const j of juegos) {
          const p = j.android && r[j.android.paquete];
          out[j.id] = p ? { instalado: true, version: p.version } : { instalado: false };
        }
        return out;
      },
      instalar: async (j, rel) => {
        const asset = buscarAsset(rel, j.android.apk);
        if (!asset) throw new Error("La versión publicada no trae APK");
        a.instalar(j.id, asset.browser_download_url, asset.size, j.nombre);
      },
      abrir: async (j) => { if (!a.abrir(j.android.paquete)) throw new Error("No se pudo abrir"); },
      desinstalar: async (j) => a.desinstalar(j.android.paquete),
      cancelar: async (id) => a.cancelar(id),
      actualizarLauncher: async (rel) => {
        const asset = buscarAsset(rel, "\\.apk$");
        if (asset) a.instalar("_launcher", asset.browser_download_url, asset.size, "Port Launcher");
      },
      puedeInstalar: () => a.puedeInstalar(),
      pedirPermiso: () => a.pedirPermiso(),
      onEvento: (cb) => cbs.push(cb),
    };
  }
  // Vista previa en un navegador: enseña el catálogo sin instalar nada
  return {
    plataforma: "web",
    version: async () => "vista previa",
    estado: async () => ({}),
    instalar: async () => { throw new Error("Abre el launcher en Android o Windows para instalar"); },
    abrir: async () => {}, desinstalar: async () => {}, cancelar: async () => {},
    puedeInstalar: () => true, onEvento: () => {},
  };
})();

// ---------- Datos ----------
let catalogo = [];
let releases = {};      // repo -> release (o null si no hay)
let estado = {};        // id -> { instalado, version, ... }
const trabajos = {};    // id -> { hecho, total, texto }
let sinRed = false;

function buscarAsset(rel, patron) {
  if (!rel || !rel.assets) return null;
  const re = new RegExp(patron, "i");
  return rel.assets.find((a) => re.test(a.name)) || null;
}

function mb(n) {
  if (!n && n !== 0) return "";
  return n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.max(1, Math.round(n / 1e6)) + " MB";
}

function guardado(clave) {
  try { return JSON.parse(localStorage.getItem(clave) || "null"); } catch (e) { return null; }
}
function guardar(clave, valor) {
  try { localStorage.setItem(clave, JSON.stringify(valor)); } catch (e) {}
}

async function cargarCatalogo() {
  try {
    const r = await fetch(CATALOGO_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const c = await r.json();
    guardar("catalogo", c);
    return c.juegos;
  } catch (e) {
    const g = guardado("catalogo");
    if (g) return g.juegos;
    const r = await fetch("catalogo.json");
    return (await r.json()).juegos;
  }
}

async function ultimaVersion(repo, forzar) {
  const clave = "rel:" + repo;
  const g = guardado(clave);
  if (!forzar && g && Date.now() - g.t < CACHE_MIN * 60e3) return g.rel;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error("GitHub " + r.status);
    const j = await r.json();
    const rel = { tag: j.tag_name, fecha: j.published_at, notas: j.body || "",
      assets: (j.assets || []).map((a) => ({ name: a.name, size: a.size, browser_download_url: a.browser_download_url })) };
    guardar(clave, { t: Date.now(), rel });
    sinRed = false;
    return rel;
  } catch (e) {
    sinRed = true;
    return g ? g.rel : null;
  }
}

async function refrescar(forzar) {
  const btn = document.getElementById("refrescar");
  btn.classList.add("girando");
  try {
    catalogo = await cargarCatalogo();
    const repos = [...new Set(catalogo.map((j) => j.repo))];
    const res = await Promise.all(repos.map((r) => ultimaVersion(r, forzar)));
    repos.forEach((r, i) => (releases[r] = res[i]));
    estado = await Host.estado(catalogo);
    pintar();
    revisarLauncher(forzar);
  } finally {
    btn.classList.remove("girando");
    document.getElementById("aviso-red").hidden = !sinRed;
    revisarPermiso();
  }
}

// ---------- Pantalla ----------
function soporta(j) {
  return Host.plataforma === "windows" ? !!j.windows : Host.plataforma === "android" ? !!j.android : true;
}

function tamano(j, rel) {
  if (Host.plataforma === "windows" && j.windows) {
    const a = buscarAsset(rel, j.windows.tipo === "zip" ? j.windows.zip : j.windows.apk);
    return a ? a.size : 0;
  }
  const a = j.android && buscarAsset(rel, j.android.apk);
  return a ? a.size : 0;
}

function pintar() {
  const cont = document.getElementById("juegos");
  const tpl = document.getElementById("tpl-juego");
  cont.textContent = "";
  for (const j of catalogo) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = j.id;
    const img = el.querySelector(".icono");
    img.src = "iconos/" + (j.icono || j.id) + ".png";
    img.onerror = () => { img.onerror = null; img.src = `https://raw.githubusercontent.com/${LAUNCHER_REPO}/main/ui/iconos/${j.icono || j.id}.png`; };
    el.querySelector(".nombre").textContent = j.nombre;
    el.querySelector(".desc").textContent = j.desc || "";
    pintarEstado(el, j);
    cont.appendChild(el);
  }
}

function pintarEstado(el, j) {
  const rel = releases[j.repo];
  const st = estado[j.id] || {};
  const meta = el.querySelector(".meta");
  const acc = el.querySelector(".acciones");
  const barra = el.querySelector(".barra");
  const fase = el.querySelector(".fase");
  acc.textContent = "";
  meta.textContent = "";

  const t = trabajos[j.id];
  barra.hidden = !t;
  fase.hidden = !t;
  if (t) {
    el.querySelector(".relleno").style.width = (t.total ? Math.min(100, (100 * t.hecho) / t.total) : 0) + "%";
    fase.textContent = t.texto + (t.total ? ` · ${mb(t.hecho)} de ${mb(t.total)}` : "");
    boton(acc, "Cancelar", "sec", () => Host.cancelar(j.id));
    return;
  }

  if (!soporta(j)) {
    meta.textContent = Host.plataforma === "windows" ? "Por ahora solo en Android." : "No disponible aquí.";
    return;
  }

  const partes = [];
  if (st.instalado) partes.push(`<span class="instalado">Instalado</span>${st.version ? " · " + esc(st.version) : ""}`);
  if (rel) partes.push("Última: " + esc(rel.tag) + (tamano(j, rel) ? " · " + mb(tamano(j, rel)) : ""));
  else partes.push(sinRed ? "Sin conexión" : "Aún no hay versión publicada");
  const hayNueva = st.instalado && st.actualizable && rel && st.version !== rel.tag;
  if (hayNueva) partes.push('<span class="nueva">Hay versión nueva</span>');
  meta.innerHTML = partes.join(" · ");

  if (st.instalado) {
    boton(acc, "Jugar", "", () => accion(j, () => Host.abrir(j)));
    if (hayNueva) boton(acc, "Actualizar", "sec", () => instalar(j, rel));
    else if (Host.plataforma === "android") nota(acc, "Se actualiza sola al abrirla");
    if (Host.carpeta && Host.plataforma === "windows") boton(acc, "Carpeta", "sec", () => Host.carpeta(j));
    boton(acc, "Desinstalar", "peligro", () => {
      if (confirm(`¿Desinstalar ${j.nombre}?` + (Host.plataforma === "windows" ? " Tus partidas se conservan." : ""))) accion(j, () => Host.desinstalar(j));
    });
  } else {
    const b = boton(acc, "Instalar", "", () => instalar(j, rel));
    if (!rel) b.disabled = true;
  }
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function boton(cont, txt, clase, fn) {
  const b = document.createElement("button");
  b.className = "btn" + (clase ? " " + clase : "");
  b.textContent = txt;
  b.onclick = fn;
  cont.appendChild(b);
  return b;
}
function nota(cont, txt) {
  const s = document.createElement("span");
  s.className = "nota";
  s.textContent = txt;
  cont.appendChild(s);
}

function repintar(id) {
  const el = document.querySelector(`.juego[data-id="${CSS.escape(id)}"]`);
  const j = catalogo.find((x) => x.id === id);
  if (el && j) pintarEstado(el, j);
}

async function accion(j, fn) {
  try { await fn(); } catch (e) { alert(e.message || String(e)); }
  estado = await Host.estado(catalogo);
  repintar(j.id);
}

async function instalar(j, rel) {
  if (Host.plataforma === "android" && !Host.puedeInstalar()) { revisarPermiso(); return; }
  const tam = tamano(j, rel);
  if (tam > 150e6 && navigator.connection && navigator.connection.type === "cellular" &&
      !confirm(`${j.nombre} ocupa ${mb(tam)}. Estás con datos móviles: ¿seguir?`)) return;
  trabajos[j.id] = { hecho: 0, total: tam, texto: "Empezando" };
  repintar(j.id);
  try {
    await Host.instalar(j, rel);
  } catch (e) {
    delete trabajos[j.id];
    repintar(j.id);
    alert(e.message || String(e));
  }
}

Host.onEvento(async (ev) => {
  if (ev.tipo === "progreso") {
    trabajos[ev.id] = { hecho: ev.hecho, total: ev.total, texto: ev.texto || "Descargando" };
    if (ev.id === "_launcher") return avisoLauncher(`Bajando la nueva versión del launcher… ${mb(ev.hecho)} de ${mb(ev.total)}`);
    repintar(ev.id);
  } else if (ev.tipo === "fin") {
    delete trabajos[ev.id];
    if (!ev.ok && ev.msg) alert(ev.msg);
    estado = await Host.estado(catalogo);
    if (ev.id !== "_launcher") repintar(ev.id);
  } else if (ev.tipo === "refrescar") {
    estado = await Host.estado(catalogo);
    pintar();
    revisarPermiso();
  }
});

// ---------- Launcher ----------
function avisoLauncher(txt, boton1) {
  const a = document.getElementById("aviso-launcher");
  a.hidden = false;
  a.textContent = "";
  const s = document.createElement("span");
  s.textContent = txt;
  a.appendChild(s);
  if (boton1) a.appendChild(boton1);
}

function nuevaQue(a, b) {   // ¿la etiqueta a (v0.3) es más nueva que la versión b (0.2)?
  const n = (s) => String(s).replace(/^v/i, "").split(/[^0-9]+/).filter(Boolean).map(Number);
  const x = n(a), y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

async function revisarLauncher(forzar) {
  const mia = await Host.version();
  document.getElementById("ver-launcher").textContent = "Launcher " + mia;
  if (Host.plataforma === "web" || !Host.actualizarLauncher) return;
  const rel = await ultimaVersion(LAUNCHER_REPO, forzar);
  if (!rel || !nuevaQue(rel.tag, mia)) return;
  const b = document.createElement("button");
  b.className = "btn";
  b.textContent = "Actualizar";
  b.onclick = () => { b.disabled = true; Host.actualizarLauncher(rel); };
  avisoLauncher(`Hay una versión nueva del launcher (${rel.tag}).`, b);
}

function revisarPermiso() {
  const a = document.getElementById("aviso-permiso");
  a.hidden = !(Host.plataforma === "android" && !Host.puedeInstalar());
}

document.getElementById("refrescar").onclick = () => refrescar(true);
document.getElementById("dar-permiso").onclick = () => Host.pedirPermiso && Host.pedirPermiso();
refrescar(false);
