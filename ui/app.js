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
let releases = {};      // repo -> { tag, fecha, notas, assets, historial: [{tag, fecha, notas}] } o null
let estado = {};        // id -> { instalado, version, codigo, actualizable }
const trabajos = {};    // id -> { hecho, total, texto }
const esperas = {};     // id -> resolver de la promesa de instalar (para «Actualizar todo»)
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
    pintar();
    revisarLauncher(forzar, false);
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

function pintarCabecera() {
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
    boton(acc, "Cancelar", "sec", () => Host.cancelar(j.id));
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
    if (nueva) boton(acc, "Actualizar", "nueva", () => verNovedades(j, true));
    if (rel) boton(acc, "Novedades", "sec", () => verNovedades(j, false));
    if (Host.plataforma === "windows") {
      boton(acc, "Acceso directo", "sec", () => accion(j, async () => { await Host.acceso(j); avisoCorto(`Acceso directo de ${j.nombre} en el escritorio.`); }));
      boton(acc, "Carpeta", "sec", () => Host.carpeta(j));
    }
    boton(acc, "Desinstalar", "peligro", () => {
      if (confirm(`¿Desinstalar ${j.nombre}?` + (Host.plataforma === "windows" ? " Tus partidas se conservan." : ""))) accion(j, () => Host.desinstalar(j));
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
  try { await fn(); } catch (e) { alert(e.message || String(e)); }
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
function instalar(j, rel) {
  if (Host.plataforma === "android" && !Host.puedeInstalar()) { revisarPermiso(); return Promise.resolve(false); }
  const tam = tamano(j, rel);
  if (tam > 150e6 && navigator.connection && navigator.connection.type === "cellular" &&
      !confirm(`${j.nombre} ocupa ${mb(tam)}. Estás con datos móviles: ¿seguir?`)) return Promise.resolve(false);
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
      alert(e.message || String(e));
      ok(false);
    }
  });
}

async function actualizarTodo() {
  const pend = catalogo.filter((j) => soporta(j) && hayNueva(j) && !trabajos[j.id]);
  if (!pend.length) return;
  const total = pend.reduce((a, j) => a + tamano(j, releases[j.repo]), 0);
  if (!confirm(`Se actualizarán: ${pend.map((j) => j.nombre).join(", ")}` + (total ? ` (unos ${mb(total)}).` : ".") +
      (Host.plataforma === "android" ? "\n\nAndroid pedirá confirmar cada instalación." : ""))) return;
  for (const j of pend) await instalar(j, releases[j.repo]);
}

Host.onEvento(async (ev) => {
  if (ev.tipo === "progreso") {
    trabajos[ev.id] = { hecho: ev.hecho, total: ev.total, texto: ev.texto || "Descargando" };
    if (ev.id === "_launcher") return progresoLauncher(ev);
    repintar(ev.id);
  } else if (ev.tipo === "fin") {
    delete trabajos[ev.id];
    if (!ev.ok && ev.msg) alert(ev.msg);
    if (esperas[ev.id]) { esperas[ev.id](ev.ok); delete esperas[ev.id]; }
    estado = await Host.estado(catalogo);
    if (ev.id === "_launcher") return finLauncher(ev);
    repintar(ev.id);
    if (ev.ok) avisoCorto(`${(catalogo.find((x) => x.id === ev.id) || {}).nombre || "Juego"} listo.`);
  } else if (ev.tipo === "refrescar") {
    estado = await Host.estado(catalogo);
    pintar();
    revisarPermiso();
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
function abrirModal({ titulo, sub, cuerpo, botones }) {
  modal.querySelector(".m-titulo").textContent = titulo;
  modal.querySelector(".m-sub").innerHTML = sub || "";
  modal.querySelector(".m-cuerpo").innerHTML = cuerpo;
  const acc = modal.querySelector(".m-acciones");
  acc.textContent = "";
  for (const b of botones) boton(acc, b.txt, b.clase || "", () => { modal.close(); b.fn && b.fn(); });
  boton(acc, "Cerrar", "sec", () => modal.close());
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

// ---------- Launcher ----------
let relLauncher = null;

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
document.getElementById("buscar-launcher").onclick = () => revisarLauncher(true, true);
document.getElementById("dar-permiso").onclick = () => Host.pedirPermiso && Host.pedirPermiso();
modal.addEventListener("click", (e) => { if (e.target === modal) modal.close(); });
refrescar(false);
