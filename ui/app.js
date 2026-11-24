/* Port Launcher — interfaz común de Android y Windows.
 *
 * Lee el catálogo (catalogo.json del repo del launcher; si no hay internet, la última copia o el que trae la app),
 * mira las versiones publicadas de cada juego en GitHub y deja instalar, abrir, actualizar (con sus novedades)
 * y desinstalar. El trabajo de verdad lo hace la plataforma:
 *   - Android: window.LauncherAndroid (Java) baja la APK y la instala.
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
      acceso: (j) => h.acceso(j),
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
          out[j.id] = p ? { instalado: true, version: p.version, codigo: p.codigo } : { instalado: false };
        }
        return out;
      },
      instalar: async (j, rel) => {
        const asset = buscarAsset(rel, j.android.apk);
        if (!asset) throw new Error("La versión publicada no trae APK");
        if (a.instalarVersion) a.instalarVersion(j.id, asset.browser_download_url, asset.size, j.nombre, rel.tag);
        else a.instalar(j.id, asset.browser_download_url, asset.size, j.nombre);
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
      avisosPermitidos: () => (a.avisosPermitidos ? a.avisosPermitidos() : true),
      pedirAvisos: () => a.pedirAvisos && a.pedirAvisos(),
      sinPreguntar: (j) => (a.sinPreguntar ? a.sinPreguntar(j.android.paquete) : false),
      conWifi: () => (a.conWifi ? a.conWifi() : true),
      ajustes: (o) => a.ajustes && a.ajustes(JSON.stringify(o)),
      guardarCatalogo: (juegos) => a.guardarCatalogo && a.guardarCatalogo(JSON.stringify(juegos)),
      dispositivo: () => { try { return JSON.parse(a.dispositivo()); } catch (e) { return null; } },
      pantallaEncendida: (si) => a.pantallaEncendida && a.pantallaEncendida(si),
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
let releases = {};      // repo -> { tag, fecha, notas, assets, historial: [{tag, fecha, notas}] } o null
let estado = {};        // id -> { instalado, version, codigo, actualizable }
const trabajos = {};    // id -> { hecho, total, texto }
const esperas = {};
const saltar = new Set();   // quitados de la cola de «Actualizar todo»     // id -> resolver de la promesa de instalar (para «Actualizar todo»)
let sinRed = false;

const AJUSTES = Object.assign({ auto: true, soloWifi: true }, guardado("ajustes") || {});
function guardarAjustes() {
  guardar("ajustes", AJUSTES);
  if (Host.ajustes) Host.ajustes(AJUSTES);
}

function buscarAsset(rel, patron) {
  if (!rel || !rel.assets) return null;
  const re = new RegExp(patron, "i");
  return rel.assets.find((a) => re.test(a.name)) || null;
}

function mb(n) {
  if (!n && n !== 0) return "";
  return n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.max(1, Math.round(n / 1e6)) + " MB";
}

function fecha(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return iso.slice(0, 10); }
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

async function gh(ruta) {
  const r = await fetch("https://api.github.com/repos/" + ruta, { headers: { Accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error("GitHub " + r.status);
  return r.json();
}

function limpiaRel(j) {
  return { tag: j.tag_name, fecha: j.published_at, notas: j.body || "",
    assets: (j.assets || []).map((a) => ({ name: a.name, size: a.size, browser_download_url: a.browser_download_url })) };
}

/** Última versión publicada de un repo y sus anteriores (para las novedades). */
async function versiones(repo, forzar) {
  const clave = "rel2:" + repo;
  const g = guardado(clave);
  if (!forzar && g && Date.now() - g.t < CACHE_MIN * 60e3) return g.rel;
  try {
    const [ultima, lista] = await Promise.all([gh(repo + "/releases/latest"), gh(repo + "/releases?per_page=15").catch(() => [])]);
    const rel = limpiaRel(ultima);
    rel.historial = (lista || []).filter((x) => !x.draft && !x.prerelease)
      .map((x) => ({ tag: x.tag_name, fecha: x.published_at, notas: x.body || "" }));
    guardar(clave, { t: Date.now(), rel });
    sinRed = false;
    return rel;
  } catch (e) {
    sinRed = true;
    return g ? g.rel : null;
  }
}

// ---------- Versiones ----------
const numeros = (s) => String(s || "").split(/[^0-9]+/).filter(Boolean).map(Number);
function compara(x, y) {   // >0 si x es más nueva
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}
/** Cómo se compara una etiqueta publicada (v0.7, build-49…) con lo instalado. */
function claveTag(j, tag) {
  if (Host.plataforma === "android" && j.android && j.android.version === "codigo") {
    const n = numeros(tag);
    return n.length ? [n[n.length - 1]] : [0];
  }
  return numeros(String(tag).replace(/^v/i, ""));
}
function claveInstalada(j, st) {
  if (Host.plataforma === "android" && j.android) return j.android.version === "codigo" ? [st.codigo || 0] : numeros(st.version);
  return claveTag(j, st.version);
}
function versionVisible(j, st) {
  if (Host.plataforma === "android" && j.android && j.android.version === "codigo") return `${st.version} (build ${st.codigo})`;
  return st.version || "?";
}
function hayNueva(j) {
  const st = estado[j.id], rel = releases[j.repo];
  if (!st || !st.instalado || !rel) return false;
  if (Host.plataforma === "windows" && !st.actualizable) return false;
  return compara(claveTag(j, rel.tag), claveInstalada(j, st)) > 0;
}
/** Novedades que te faltan (o las de la última versión si estás al día / no lo tienes). */
function novedades(j) {
  const rel = releases[j.repo];
  if (!rel) return [];
  const hist = rel.historial && rel.historial.length ? rel.historial : [{ tag: rel.tag, fecha: rel.fecha, notas: rel.notas }];
  const st = estado[j.id];
  if (st && st.instalado && hayNueva(j)) {
    const inst = claveInstalada(j, st);
    const nuevas = hist.filter((h) => compara(claveTag(j, h.tag), inst) > 0);
    if (nuevas.length) return nuevas;
  }
  return hist.slice(0, 1);
}

async function refrescar(forzar) {
  const btn = document.getElementById("refrescar");
  btn.classList.add("girando");
  try {
    catalogo = await cargarCatalogo();
    const repos = [...new Set(catalogo.map((j) => j.repo))];
    const res = await Promise.all(repos.map((r) => versiones(r, forzar)));
    repos.forEach((r, i) => (releases[r] = res[i]));
    estado = await Host.estado(catalogo);
    if (Host.guardarCatalogo) Host.guardarCatalogo(catalogo);
    pintar();
    revisarLauncher(forzar, false);
    mostrarActualizados();
    autoActualizar();
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
    const st = estado[j.id];
    // Juego web ya instalado: solo baja lo que cambió (no se sabe cuánto hasta empezar)
    if (j.windows.tipo === "web" && st && st.instalado) return 0;
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
  pintarCabecera();
}

let cola = null;   // { i, n } mientras «Actualizar todo» trabaja
function pintarCabecera() {
  const b0 = document.getElementById("todo");
  if (cola) { b0.hidden = false; b0.disabled = true; b0.textContent = `Actualizando ${cola.i} de ${cola.n}…`; return; }
  b0.disabled = false;
  const pend = catalogo.filter((j) => soporta(j) && hayNueva(j) && !trabajos[j.id]);
  const b = document.getElementById("todo");
  b.hidden = pend.length === 0;
  b.textContent = pend.length === 1 ? "Actualizar 1 juego" : `Actualizar ${pend.length} juegos`;
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
  el.classList.toggle("con-nueva", false);

  const t = trabajos[j.id];
  barra.hidden = !t;
  fase.hidden = !t;
  if (t) {
    el.querySelector(".relleno").style.width = (t.total ? Math.min(100, (100 * t.hecho) / t.total) : 0) + "%";
    el.querySelector(".barra").classList.toggle("indeterminada", !t.total);
    fase.textContent = t.texto + (t.total ? ` · ${mb(t.hecho)} de ${mb(t.total)}` : "");
    if (t.texto === "En cola") boton(acc, "Quitar de la cola", "sec", () => { saltar.add(j.id); delete trabajos[j.id]; repintar(j.id); });
    else boton(acc, "Cancelar", "sec", () => Host.cancelar(j.id));
    return;
  }

  if (!soporta(j)) {
    meta.textContent = Host.plataforma === "windows" ? "Por ahora solo en Android." : "No disponible aquí.";
    return;
  }

  const nueva = hayNueva(j);
  const tam = tamano(j, rel);
  const partes = [];
  if (st.instalado) {
    partes.push(`<span class="instalado">Tienes ${esc(versionVisible(j, st))}</span>`);
    if (nueva) partes.push(`<span class="nueva">Nueva: ${esc(rel.tag)}</span>` + (tam ? " · " + mb(tam) : ""));
    else if (rel) partes.push("Al día");
  } else if (rel) {
    partes.push("Versión " + esc(rel.tag) + (rel.fecha ? " · " + fecha(rel.fecha) : "") + (tam ? " · " + mb(tam) : ""));
  } else {
    partes.push(sinRed ? "Sin conexión" : "Aún no hay versión publicada");
  }
  meta.innerHTML = partes.join(" · ");
  el.classList.toggle("con-nueva", nueva);

  if (st.instalado) {
    boton(acc, "Jugar", "", () => accion(j, () => Host.abrir(j)));
    if (nueva) boton(acc, "Actualizar", "nueva", () => instalar(j, rel));
    if (rel) boton(acc, "Novedades", "sec", () => verNovedades(j, false));
    if (Host.plataforma === "windows") {
      boton(acc, "Acceso directo", "sec", () => accion(j, async () => { await Host.acceso(j); avisoCorto(`Acceso directo de ${j.nombre} en el escritorio.`); }));
      boton(acc, "Carpeta", "sec", () => Host.carpeta(j));
    }
    boton(acc, "Desinstalar", "peligro", async () => {
      if (await preguntar("Desinstalar", `¿Desinstalar ${j.nombre}?` + (Host.plataforma === "windows" ? " Tus partidas se conservan." : ""), "Desinstalar", "Cancelar", true))
        accion(j, () => Host.desinstalar(j));
    });
  } else {
    const b = boton(acc, "Instalar", "", () => instalar(j, rel));
    if (!rel) b.disabled = true;
    if (rel) boton(acc, "Novedades", "sec", () => verNovedades(j, false));
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

function repintar(id) {
  const el = document.querySelector(`.juego[data-id="${CSS.escape(id)}"]`);
  const j = catalogo.find((x) => x.id === id);
  if (el && j) pintarEstado(el, j);
  pintarCabecera();
}

async function accion(j, fn) {
  try { await fn(); } catch (e) { avisar(e.message || String(e)); }
  estado = await Host.estado(catalogo);
  repintar(j.id);
}

let avisoT = 0;
function avisoCorto(txt) {
  const a = document.getElementById("toast");
  a.textContent = txt;
  a.hidden = false;
  clearTimeout(avisoT);
  avisoT = setTimeout(() => (a.hidden = true), 3500);
}

/** Instala o actualiza; la promesa termina cuando acaba (o falla). */
async function instalar(j, rel, sinPreguntar) {
  if (Host.plataforma === "android" && !Host.puedeInstalar()) {
    revisarPermiso();
    avisar("Antes, pulsa «Permitir» arriba para que el launcher pueda instalar apps.");
    return false;
  }
  if (trabajos[j.id]) return false;
  const tam = tamano(j, rel);
  if (!sinPreguntar && tam > 150e6 && navigator.connection && navigator.connection.type === "cellular" &&
      !(await preguntar(j.nombre, `Ocupa ${mb(tam)} y estás con datos móviles. ¿Seguir?`, "Descargar"))) return false;
  trabajos[j.id] = { hecho: 0, total: tam, texto: "Empezando" };
  repintar(j.id);
  return new Promise(async (ok) => {
    esperas[j.id] = ok;
    try {
      await Host.instalar(j, rel);
    } catch (e) {
      delete trabajos[j.id];
      delete esperas[j.id];
      repintar(j.id);
      avisar(e.message || String(e));
      ok(false);
    }
  });
}

async function actualizarTodo() {
  if (cola) return;
  const pend = catalogo.filter((j) => soporta(j) && hayNueva(j) && !trabajos[j.id]);
  if (!pend.length) return;
  const btn = document.getElementById("todo");
  btn.disabled = true;
  // Todos «en cola» desde el principio, para que se vea el avance
  for (const j of pend) { trabajos[j.id] = { hecho: 0, total: 0, texto: "En cola" }; repintar(j.id); }
  try {
    saltar.clear();
    cola = { i: 0, n: pend.length };
    for (const j of pend) {
      cola.i++;
      if (saltar.has(j.id)) continue;
      delete trabajos[j.id];
      pintarCabecera();
      await instalar(j, releases[j.repo], true);
    }
  } finally {
    cola = null;
    btn.disabled = false;
    pintarCabecera();
    mostrarActualizados();
  }
}

Host.onEvento(async (ev) => {
  if (ev.tipo === "progreso") {
    trabajos[ev.id] = { hecho: ev.hecho, total: ev.total, texto: ev.texto || "Descargando" };
    if (ev.id === "_launcher") return progresoLauncher(ev);
    repintar(ev.id);
  } else if (ev.tipo === "fin") {
    delete trabajos[ev.id];
    if (!ev.ok && ev.msg) avisar(ev.msg);
    if (esperas[ev.id]) { esperas[ev.id](ev.ok); delete esperas[ev.id]; }
    estado = await Host.estado(catalogo);
    if (ev.id === "_launcher") return finLauncher(ev);
    repintar(ev.id);
    if (ev.ok && !cola) mostrarActualizados();
  } else if (ev.tipo === "refrescar") {
    estado = await Host.estado(catalogo);
    pintar();
    revisarPermiso();
    if (!cola) mostrarActualizados();
  }
});

// ---------- Novedades ----------
/** Texto de las notas de GitHub (markdown sencillo) a HTML seguro. */
function notasHtml(txt) {
  const lineas = String(txt || "").replace(/\r/g, "").split("\n");
  let html = "", lista = false;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  let ultimo = "";   // última línea añadida, para unir las que vienen partidas
  for (const l of lineas) {
    if (/^(Co-Authored-By|Claude-Session|Signed-off-by):/i.test(l.trim())) continue;
    const m = l.match(/^\s*[-*•]\s+(.*)$/);
    if (m) {
      if (!lista) { html += "<ul>"; lista = true; }
      html += "<li>" + inline(m[1]) + "</li>";
      ultimo = "li";
      continue;
    }
    if (!l.trim()) { if (lista) { html += "</ul>"; lista = false; } ultimo = ""; continue; }
    if (/^\s*[a-záéíóúüñ(0-9~≈+−-]/.test(l) && (ultimo === "li" || ultimo === "p")) {   // sigue la línea anterior
      html = html.replace(ultimo === "li" ? /<\/li>$/ : /<\/p>$/, " " + inline(l.trim()) + (ultimo === "li" ? "</li>" : "</p>"));
      continue;
    }
    if (lista) { html += "</ul>"; lista = false; }
    ultimo = "p";
    const h = l.match(/^#+\s*(.*)$/);
    html += h ? "<h4>" + inline(h[1]) + "</h4>" : "<p>" + inline(l) + "</p>";
  }
  if (lista) html += "</ul>";
  return html || "<p class='tenue'>Esta versión no trae notas.</p>";
}

const modal = document.getElementById("modal");

/** Pregunta con la ventana del launcher (las ventanas de confirmar del navegador no salen en el WebView de Android). */
function preguntar(titulo, texto, si, no = "Cancelar", peligro = false) {
  return new Promise((ok) => {
    let respondido = false;
    const fin = (v) => { if (!respondido) { respondido = true; ok(v); } };
    abrirModal({ titulo, sub: "", cuerpo: `<p>${esc(texto).replace(/\n/g, "<br>")}</p>`, cerrar: no,
      botones: [{ txt: si, clase: peligro ? "peligro" : "", fn: () => fin(true) }], alCerrar: () => fin(false) });
  });
}
function avisar(texto, titulo = "Port Launcher") {
  if (!texto) return;
  abrirModal({ titulo, sub: "", cuerpo: `<p>${esc(texto).replace(/\n/g, "<br>")}</p>`, cerrar: "Vale", botones: [] });
}
let alCerrarModal = null;
modal.addEventListener("close", () => { const f = alCerrarModal; alCerrarModal = null; if (f) f(); });
function abrirModal({ titulo, sub, cuerpo, botones, cerrar = "Cerrar", alCerrar = null }) {
  if (modal.open) { const f = alCerrarModal; alCerrarModal = null; modal.close(); if (f) f(); }
  modal.querySelector(".m-titulo").textContent = titulo;
  modal.querySelector(".m-sub").innerHTML = sub || "";
  modal.querySelector(".m-cuerpo").innerHTML = cuerpo;
  const acc = modal.querySelector(".m-acciones");
  acc.textContent = "";
  for (const b of botones) boton(acc, b.txt, b.clase || "", () => { alCerrarModal = null; modal.close(); b.fn && b.fn(); });
  boton(acc, cerrar, "sec", () => modal.close());
  alCerrarModal = alCerrar;
  modal.showModal();
  modal.querySelector(".m-cuerpo").scrollTop = 0;
}

function verNovedades(j, paraActualizar) {
  const rel = releases[j.repo];
  const st = estado[j.id] || {};
  const lista = novedades(j);
  const nueva = hayNueva(j);
  const tam = tamano(j, rel);
  let sub = "";
  if (st.instalado) {
    sub = `Tienes <b>${esc(versionVisible(j, st))}</b>` + (nueva ? ` · Nueva <b class="nueva">${esc(rel.tag)}</b>` : " · Estás al día");
  } else if (rel) sub = `Última versión <b>${esc(rel.tag)}</b>`;
  if (nueva && lista.length > 1) sub += ` · ${lista.length} versiones nuevas`;
  const cuerpo = lista.map((h) => `<section class="nota-ver"><h3>${esc(h.tag)} <span>${fecha(h.fecha)}</span></h3>${notasHtml(h.notas)}</section>`).join("");
  const botones = [];
  if (nueva) {
    botones.push({ txt: "Actualizar" + (tam ? ` (${mb(tam)})` : ""), fn: () => instalar(j, rel) });
    if (Host.plataforma === "android") {
      botones.push({ txt: "Abrir el juego", clase: "sec", fn: () => accion(j, () => Host.abrir(j)) });
    }
  } else if (!st.instalado && rel) {
    botones.push({ txt: "Instalar" + (tam ? ` (${mb(tam)})` : ""), fn: () => instalar(j, rel) });
  }
  const pie = nueva && Host.plataforma === "android"
    ? "<p class='tenue pie-nota'>Consejo: si abres el juego, su propio actualizador baja solo lo que cambió (gasta menos datos que la APK completa).</p>"
    : "";
  abrirModal({ titulo: j.nombre + (paraActualizar ? " · actualizar" : " · novedades"), sub, cuerpo: cuerpo + pie, botones });
}

// ---------- Actualizaciones automáticas ----------
/** Como la Play Store: al abrir, pone al día lo que tenga versión nueva (con wifi si así está ajustado). */
let autoHecho = false;
function autoActualizar() {
  if (autoHecho || !AJUSTES.auto || Host.plataforma === "web" || cola) return;
  if (Host.plataforma === "android" && AJUSTES.soloWifi && Host.conWifi && !Host.conWifi()) return;
  if (Host.plataforma === "android" && !Host.puedeInstalar()) return;
  const pend = catalogo.filter((j) => soporta(j) && hayNueva(j) && !trabajos[j.id]);
  if (!pend.length) return;
  autoHecho = true;
  actualizarTodo();
}

/** Tras actualizar (aquí o en segundo plano): ventana con lo que cambió en cada juego. */
function mostrarActualizados() {
  if (cola || (modal.open && !modal.dataset.actualizados)) return;
  const partes = [];
  for (const j of catalogo) {
    const st = estado[j.id];
    if (!st || !st.instalado || !soporta(j)) continue;
    const clave = "visto:" + Host.plataforma + ":" + j.id;
    const ahora = claveInstalada(j, st);
    const antes = guardado(clave);
    guardar(clave, { k: ahora, v: versionVisible(j, st) });
    if (!antes || compara(ahora, antes.k) <= 0) continue;
    const rel = releases[j.repo];
    const hist = (rel && rel.historial) || [];
    const cambios = hist.filter((h) => compara(claveTag(j, h.tag), antes.k) > 0 && compara(claveTag(j, h.tag), ahora) <= 0);
    partes.push(`<section class="nota-ver"><h3>${esc(j.nombre)} <span>${esc(antes.v)} → ${esc(versionVisible(j, st))}</span></h3>` +
      (cambios.length
        ? cambios.map((h) => `<h4>${esc(h.tag)} · ${fecha(h.fecha)}</h4>${notasHtml(h.notas)}`).join("")
        : "<p class='tenue'>Sin notas para esta versión.</p>") + "</section>");
  }
  if (!partes.length) return;
  abrirModal({ titulo: partes.length === 1 ? "Juego actualizado" : `${partes.length} juegos actualizados`,
    sub: "Esto es lo nuevo:", cuerpo: partes.join(""), botones: [], cerrar: "Genial" });
  modal.dataset.actualizados = "1";
  const quitar = () => { delete modal.dataset.actualizados; modal.removeEventListener("close", quitar); };
  modal.addEventListener("close", quitar);
}

// ---------- Ajustes ----------
function panelAjustes() {
  const fila = (id, titulo, texto, marcado) =>
    `<label class="aj-fila"><input type="checkbox" id="${id}"${marcado ? " checked" : ""}><span><b>${titulo}</b><br><span class="tenue">${texto}</span></span></label>`;
  let html = fila("aj-auto", "Actualizar automáticamente",
    Host.plataforma === "android"
      ? "Al abrir el launcher y cada pocas horas en segundo plano, como la Play Store."
      : "Al abrir el launcher.", AJUSTES.auto);
  if (Host.plataforma === "android") {
    html += fila("aj-wifi", "Solo con wifi", "Las actualizaciones automáticas esperan a tener wifi (los juegos pesan cientos de MB).", AJUSTES.soloWifi);
    const inst = Host.puedeInstalar(), av = Host.avisosPermitidos();
    const juegosSin = catalogo.filter((j) => estado[j.id] && estado[j.id].instalado && Host.sinPreguntar && !Host.sinPreguntar(j));
    html += `<h4>Permisos</h4>
      <div class="aj-perm"><span>${inst ? "✅" : "⚠️"} Instalar apps</span>${inst ? "" : '<button class="btn" id="aj-pinst">Permitir</button>'}</div>
      <div class="aj-perm"><span>${av ? "✅" : "⚠️"} Avisos (te dice qué se actualizó)</span>${av ? "" : '<button class="btn" id="aj-pav">Permitir</button>'}</div>
      <p class="tenue">Android 12 o más nuevo actualiza sin preguntar los juegos que instaló el launcher.` +
      (juegosSin.length ? ` Estos los instalaste de otra forma, así que Android preguntará una sola vez al actualizarlos: ${juegosSin.map((j) => esc(j.nombre)).join(", ")}.` : "") + "</p>";
  }
  abrirModal({ titulo: "Ajustes", sub: "", cuerpo: html, botones: [], cerrar: "Listo" });
  const c = modal.querySelector(".m-cuerpo");
  c.querySelector("#aj-auto").onchange = (e) => { AJUSTES.auto = e.target.checked; guardarAjustes(); };
  const w = c.querySelector("#aj-wifi");
  if (w) w.onchange = (e) => { AJUSTES.soloWifi = e.target.checked; guardarAjustes(); };
  const pi = c.querySelector("#aj-pinst");
  if (pi) pi.onclick = () => { modal.close(); Host.pedirPermiso(); };
  const pa = c.querySelector("#aj-pav");
  if (pa) pa.onclick = () => { modal.close(); Host.pedirAvisos(); };
}

// ---------- Benchmark ----------
function dispositivo() {
  const d = (Host.dispositivo && Host.dispositivo()) || {};
  if (!d.nucleos) d.nucleos = navigator.hardwareConcurrency || 0;
  if (!d.ram && navigator.deviceMemory) d.ram = navigator.deviceMemory * 1e9;
  if (!d.modelo) d.modelo = Host.plataforma === "windows" ? "PC con Windows" : "Este dispositivo";
  return d;
}

async function lanzarBench() {
  const pant = document.getElementById("pantalla-bench");
  const fase = document.getElementById("bench-fase"), fps = document.getElementById("bench-fps"), barra = document.getElementById("bench-barra");
  pant.hidden = false;
  if (Host.pantallaEncendida) Host.pantallaEncendida(true);
  let avance = 0;
  const ui = (txt, f, p) => {
    fase.textContent = txt;
    fps.textContent = f ? Math.round(f) + " FPS" : "";
    if (p != null) avance = p; else avance = Math.min(0.97, avance + 0.01);
    barra.style.width = Math.round(avance * 100) + "%";
  };
  document.getElementById("bench-cancelar").onclick = () => Bench.cancelar();
  let r = null;
  try {
    await new Promise((ok) => setTimeout(ok, 300));
    r = await Bench.correr(document.getElementById("lienzo-bench"), ui);
  } catch (e) {
    avisar("El benchmark falló: " + (e.message || e));
  } finally {
    pant.hidden = true;
    if (Host.pantallaEncendida) Host.pantallaEncendida(false);
  }
  if (!r) return;
  r.disp = dispositivo();
  const hist = guardado("bench") || [];
  hist.unshift(r);
  guardar("bench", hist.slice(0, 10));
  verBench(r);
}

function gb(n) { return n ? (n / 1073741824).toFixed(n > 4e9 ? 0 : 1) + " GB" : "?"; }

function verBench(r) {
  if (!r) {
    abrirModal({
      titulo: "Benchmark",
      sub: "¿Cómo irán los juegos en este " + (Host.plataforma === "windows" ? "PC" : "teléfono") + "?",
      cuerpo: `<p>Una prueba de unos 30 segundos: gráficos 2D (como los survivors), 3D (como PokéBonk) y procesador.
        Después te dice a cuántos FPS irá cada juego y qué ajustes poner.</p>
        <p class="tenue">Consejo: hazlo con el teléfono cargado de batería y sin el modo ahorro activado, que limita la velocidad.</p>`,
      botones: [{ txt: "Empezar", fn: lanzarBench }],
    });
    return;
  }
  const d = r.disp || {};
  const filaD = (k, v) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : "");
  const ficha = `<dl class="ficha">${filaD("Equipo", d.modelo)}${filaD("Procesador", [d.soc, d.nucleos ? d.nucleos + " núcleos" : ""].filter(Boolean).join(" · "))}` +
    filaD("Gráficos", r.gpu) + filaD("RAM", d.ram ? gb(d.ram) + (d.ramLibre ? ` (${gb(d.ramLibre)} libres)` : "") : "") +
    filaD("Pantalla", `${r.hz} Hz` + (d.hzMax && d.hzMax > r.hz + 2 ? ` (admite hasta ${Math.round(d.hzMax)} Hz)` : "")) +
    filaD("Sistema", d.android ? "Android " + d.android : "") + filaD("Espacio libre", d.libre ? gb(d.libre) : "") + "</dl>";
  const max = { d2: 6000, d3: 40000, cpu: 12000 };
  const med = (nombre, v, m, txt) => `<div class="medidor"><span>${nombre}</span><div class="barra"><div class="relleno" style="width:${Math.min(100, Math.round(100 * Math.sqrt(v / m)))}%"></div></div><span class="tenue">${txt}</span></div>`;
  const pruebas = med("2D", r.d2.capacidad, max.d2, Math.round(r.d2.capacidad) + " spr.") +
    (r.d3.sinWebGL2 ? `<p class="tenue">3D: este dispositivo no tiene WebGL 2.</p>` : med("3D", r.d3.capacidad, max.d3, Math.round(r.d3.capacidad) + " obj.")) +
    med("Procesador", r.cpu.capacidad, max.cpu, Math.round(r.cpu.capacidad) + " ent.");
  const porDefecto = { alto: "No hace falta tocar nada.", medio: "Va bien; si notas tirones, cierra otras apps.", bajo: "Puede ir a tirones: cierra otras apps y desactiva el ahorro de batería del teléfono." };
  const juegos = catalogo.filter((j) => soporta(j) && j.bench).map((j) => {
    const f = Bench.estimar(r, j.bench, r.hz);
    const n = Bench.nivel(f);
    const rec = (j.bench.ajustes && j.bench.ajustes[n.id]) || porDefecto[n.id];
    return `<div class="est"><b>${n.icono} ${esc(j.nombre)}</b><span class="fps">~${Math.round(f)} FPS · ${n.txt}</span>` +
      `<span class="rec">${esc(rec)}${j.bench.aprox ? " (estimación aproximada: usa otro motor)" : ""}</span></div>`;
  }).join("");
  const hist = guardado("bench") || [];
  const antes = hist.filter((h) => h.fecha !== r.fecha).slice(0, 4)
    .map((h) => `<li>${fecha(h.fecha)} · ${h.puntos} puntos · ${esc((h.disp && h.disp.modelo) || "")}</li>`).join("");
  abrirModal({
    titulo: "Resultado del benchmark",
    sub: `${fecha(r.fecha)} · <span class="puntos">${r.puntos}</span> puntos <span class="tenue">(1000 ≈ gama media)</span>`,
    cuerpo: ficha + "<h4>Pruebas</h4>" + pruebas + "<h4>Cómo irá cada juego</h4>" + juegos +
      (antes ? "<h4>Pruebas anteriores</h4><ul>" + antes + "</ul>" : "") +
      "<p class='tenue pie-nota'>Son estimaciones: imitan la carga de cada juego, pero la partida real puede variar unos FPS.</p>",
    botones: [{ txt: "Repetir", clase: "sec", fn: lanzarBench }],
  });
}

// ---------- Launcher ----------
let relLauncher = null;
let autoLauncher = false;

async function revisarLauncher(forzar, mostrar) {
  const mia = await Host.version();
  document.getElementById("ver-launcher").textContent = "Launcher " + mia;
  if (Host.plataforma === "web" || !Host.actualizarLauncher) {
    if (mostrar) abrirModal({ titulo: "Port Launcher", sub: "Vista previa", cuerpo: "<p>Abre el launcher en Android o Windows.</p>", botones: [] });
    return;
  }
  relLauncher = await versiones(LAUNCHER_REPO, forzar);
  const nueva = relLauncher && compara(numeros(String(relLauncher.tag).replace(/^v/i, "")), numeros(mia)) > 0;
  const aviso = document.getElementById("aviso-launcher");
  if (nueva && AJUSTES.auto && !cola && !Object.keys(trabajos).length && !autoLauncher) {
    autoLauncher = true;   // como la Play Store: el launcher también se pone al día solo
    Host.actualizarLauncher(relLauncher);
    return;
  }
  if (nueva) {
    aviso.hidden = false;
    aviso.textContent = "";
    const s = document.createElement("span");
    s.textContent = `Hay una versión nueva del launcher: ${relLauncher.tag} (tienes ${mia}).`;
    aviso.appendChild(s);
    boton(aviso, "Ver", "", () => panelLauncher(mia));
  } else {
    aviso.hidden = true;
  }
  if (mostrar) panelLauncher(mia);
}

function panelLauncher(mia) {
  const rel = relLauncher;
  if (!rel) {
    abrirModal({ titulo: "Port Launcher", sub: `Tienes <b>${esc(mia)}</b>`, cuerpo: "<p>No se pudo consultar GitHub (¿sin internet?).</p>", botones: [] });
    return;
  }
  const nueva = compara(numeros(String(rel.tag).replace(/^v/i, "")), numeros(mia)) > 0;
  const hist = (rel.historial || []).filter((h) => !nueva || compara(numeros(h.tag.replace(/^v/i, "")), numeros(mia)) > 0);
  const lista = hist.length ? hist : [{ tag: rel.tag, fecha: rel.fecha, notas: rel.notas }];
  const asset = Host.plataforma === "android" ? buscarAsset(rel, "\\.apk$") : buscarAsset(rel, "Instalador\\.exe$");
  abrirModal({
    titulo: "Port Launcher",
    sub: `Tienes <b>${esc(mia)}</b> · ` + (nueva ? `Nueva <b class="nueva">${esc(rel.tag)}</b>` : "Estás al día"),
    cuerpo: (nueva ? lista : lista.slice(0, 1)).map((h) => `<section class="nota-ver"><h3>${esc(h.tag)} <span>${fecha(h.fecha)}</span></h3>${notasHtml(h.notas)}</section>`).join(""),
    botones: nueva ? [{ txt: "Actualizar el launcher" + (asset ? ` (${mb(asset.size)})` : ""), fn: () => Host.actualizarLauncher(rel) }] : [],
  });
}

function progresoLauncher(ev) {
  const a = document.getElementById("aviso-launcher");
  a.hidden = false;
  a.textContent = `Bajando el launcher nuevo… ${mb(ev.hecho)} de ${mb(ev.total)}`;
}
function finLauncher(ev) {
  const a = document.getElementById("aviso-launcher");
  if (ev.ok) a.textContent = "Launcher actualizado.";
  else a.hidden = true;
}

function revisarPermiso() {
  const a = document.getElementById("aviso-permiso");
  a.hidden = !(Host.plataforma === "android" && !Host.puedeInstalar());
}

document.getElementById("refrescar").onclick = () => refrescar(true);
document.getElementById("todo").onclick = actualizarTodo;
document.getElementById("ajustes").onclick = panelAjustes;
document.getElementById("bench").onclick = () => verBench((guardado("bench") || [])[0]);
document.getElementById("buscar-launcher").onclick = () => revisarLauncher(true, true);
document.getElementById("dar-permiso").onclick = () => Host.pedirPermiso && Host.pedirPermiso();
modal.addEventListener("click", (e) => { if (e.target === modal) modal.close(); });
guardarAjustes();
refrescar(false);
// Primera vez en Android 13+: pedir el permiso de avisos (para saber qué se actualizó en segundo plano)
if (Host.plataforma === "android" && Host.avisosPermitidos && !Host.avisosPermitidos() && !guardado("avisos-pedidos")) {
  guardar("avisos-pedidos", 1);
  setTimeout(() => Host.pedirAvisos(), 1500);
}
