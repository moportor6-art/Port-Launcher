// Descargas del launcher de Windows: bajar con progreso, comprobar huellas, descomprimir APK/ZIP y
// poner al día un juego web con el manifiesto de su versión (contenido.json), bajando solo lo que cambió.
"use strict";
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const yauzl = require("yauzl");

const UA = { "User-Agent": "PortLauncher" };

class Cancelado extends Error {
  constructor() { super("cancelado"); this.cancelado = true; }
}

/** Baja url a destino. onBytes(n) por cada trozo. */
async function bajar(url, destino, signal, onBytes) {
  const r = await fetch(url, { headers: UA, redirect: "follow", signal });
  if (!r.ok) throw new Error(`GitHub respondió ${r.status} (${path.basename(new URL(url).pathname)})`);
  await fsp.mkdir(path.dirname(destino), { recursive: true });
  const tmp = destino + ".parte";
  // Se escribe trozo a trozo, en orden (copiando cada trozo: el lector puede reutilizar su memoria)
  const fh = await fsp.open(tmp, "w");
  try {
    for await (const trozo of r.body) {
      if (signal && signal.aborted) throw new Cancelado();
      const b = Buffer.from(trozo);
      await fh.write(b, 0, b.length);
      if (onBytes) onBytes(b.length);
    }
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, destino);
  return destino;
}

async function json(url, signal) {
  const r = await fetch(url, { headers: UA, redirect: "follow", signal });
  if (!r.ok) throw new Error(`GitHub respondió ${r.status}`);
  return r.json();
}

function sha256(archivo) {
  return new Promise((ok, mal) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(archivo).on("data", (d) => h.update(d)).on("error", mal).on("end", () => ok(h.digest("hex")));
  });
}

/** Ruta segura dentro de base (nada de ../). */
function dentroDe(base, rel) {
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error("ruta no válida: " + rel);
  return p;
}

/**
 * Descomprime zip en destino. Solo lo que está bajo prefijo (que se quita); extra: archivos sueltos que también
 * se quieren (rutas completas dentro del zip) → se guardan en destino con su nombre.
 */
function descomprimir(zipPath, destino, { prefijo = "", extra = {}, signal, onEntrada } = {}) {
  const pre = prefijo ? prefijo.replace(/\/+$/, "") + "/" : "";
  return new Promise((ok, mal) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (err, zip) => {
      if (err) return mal(err);
      let total = 0;
      zip.on("error", mal);
      zip.on("end", () => ok(total));
      zip.on("entry", async (e) => {
        try {
          if (signal && signal.aborted) { zip.close(); return mal(new Cancelado()); }
          let salida = null;
          if (extra[e.fileName]) salida = extra[e.fileName];
          else if (!pre || e.fileName.startsWith(pre)) {
            const rel = e.fileName.slice(pre.length);
            if (rel && !rel.endsWith("/")) salida = dentroDe(destino, rel);
          }
          if (!salida || /\/$/.test(e.fileName)) return zip.readEntry();
          await fsp.mkdir(path.dirname(salida), { recursive: true });
          zip.openReadStream(e, async (err2, st) => {
            if (err2) return mal(err2);
            try {
              await pipeline(st, fs.createWriteStream(salida));
              total++;
              if (onEntrada) onEntrada(e.fileName, e.uncompressedSize);
              zip.readEntry();
            } catch (x) { mal(x); }
          });
        } catch (x) { mal(x); }
      });
      zip.readEntry();
    });
  });
}

/** Cuántos archivos a la vez desde raw.githubusercontent.com */
const PARALELO = 8;

function rawUrl(repo, commit, raiz, rel) {
  const r = (raiz ? raiz.replace(/\/+$/, "") + "/" : "") + rel;
  return `https://raw.githubusercontent.com/${repo}/${commit}/` + r.split("/").map(encodeURIComponent).join("/");
}

/**
 * Pone la carpeta del juego igual que el manifiesto nuevo: baja los archivos que faltan o cambiaron (comprobando
 * su huella) y borra los que ya no están. instalado = manifiesto con el que está la carpeta ahora.
 */
async function sincronizar({ repo, raiz, dir, instalado, nuevo, signal, progreso }) {
  const viejos = (instalado && instalado.files) || {};
  const nuevos = nuevo.files || {};
  const bajar1 = Object.keys(nuevos).filter((k) => !viejos[k] || viejos[k].s !== nuevos[k].s);
  const borrar = Object.keys(viejos).filter((k) => !nuevos[k]);
  const total = bajar1.reduce((a, k) => a + (nuevos[k].n || 0), 0);
  let hecho = 0, i = 0;
  progreso(0, total, bajar1.length ? `Actualizando ${bajar1.length} archivos` : "Comprobando");
  async function trabajador() {
    while (i < bajar1.length) {
      if (signal.aborted) throw new Cancelado();
      const k = bajar1[i++];
      const destino = dentroDe(dir, k);
      for (let intento = 1; ; intento++) {
        try {
          await bajar(rawUrl(repo, nuevo.commit, raiz, k), destino, signal);
          const h = await sha256(destino);
          if (h !== nuevos[k].s) throw new Error("huella distinta en " + k);
          break;
        } catch (e) {
          if (e.cancelado || signal.aborted) throw new Cancelado();
          if (intento >= 3) throw e;
          await new Promise((r) => setTimeout(r, 1000 * intento));
        }
      }
      hecho += nuevos[k].n || 0;
      progreso(hecho, total, `Actualizando ${bajar1.length} archivos`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALELO, bajar1.length) }, trabajador));
  for (const k of borrar) await fsp.rm(dentroDe(dir, k), { force: true });
  return { bajados: bajar1.length, borrados: borrar.length };
}

module.exports = { bajar, json, sha256, descomprimir, sincronizar, Cancelado, dentroDe };
