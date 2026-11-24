/* Benchmark del Port Launcher.
 *
 * Los juegos web corren con el mismo motor que el launcher (WebView en Android, Chromium en Windows), así que se
 * mide aquí mismo y se estima cómo irá cada juego:
 *   1. Pantalla: a cuántos Hz refresca de verdad (el tope de FPS).
 *   2. 2D: sprites moviéndose (como un survivor lleno de enemigos). Se suben hasta que bajan de ~50 FPS.
 *   3. 3D: cubos con luz en WebGL (como PokéBonk). Igual, subiendo hasta que bajan de ~50 FPS.
 *   4. Procesador: enemigos con colisiones (la lógica del juego).
 * Con eso sale la «capacidad» de cada parte (cuánto aguanta a 60 FPS) y, con la carga aproximada de cada juego
 * (catalogo.json → "bench"), sus FPS estimados y los ajustes recomendados.
 */
"use strict";

const Bench = (() => {
  const OBJETIVO = 50;   // FPS por debajo de los que se considera que ya no aguanta más carga
  let cancelado = false;

  const esperarFrame = () => new Promise((r) => requestAnimationFrame(r));
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Ejecuta dibujar() cada frame durante ms y devuelve {fps, bajo1, frames} (bajo1 = FPS del 1 % peor). */
  async function medir(ms, dibujar) {
    const tiempos = [];
    let t0 = await esperarFrame(), ultimo = t0;
    while (!cancelado) {
      const t = await esperarFrame();
      tiempos.push(t - ultimo);
      ultimo = t;
      if (dibujar) dibujar((t - t0) / 1000);
      if (t - t0 >= ms) break;
    }
    const n = tiempos.length || 1;
    const media = tiempos.reduce((a, b) => a + b, 0) / n;
    const peor = tiempos.slice().sort((a, b) => b - a).slice(0, Math.max(1, Math.round(n / 100)));
    return { fps: 1000 / media, bajo1: 1000 / (peor.reduce((a, b) => a + b, 0) / peor.length), frames: n };
  }

  /** Sube la carga mientras aguante OBJETIVO FPS. Devuelve la capacidad a 60 FPS (unidades de carga). */
  async function rampa(fijar, dibujar, ui, nombre, { inicio, factor, max, ventana = 700 }) {
    let n = inicio, ultimoBueno = 0, fpsBueno = 0, mejor = null;
    while (!cancelado && n <= max) {
      fijar(n);
      await medir(250, dibujar);   // dejar que se asiente
      const r = await medir(ventana, dibujar);
      ui(`${nombre}: ${Math.round(n)} objetos · ${Math.round(r.fps)} FPS`, r.fps);
      if (r.fps < OBJETIVO) {
        // capacidad a 60 FPS: interpolada entre el último que aguantó y este
        const cap = ultimoBueno ? ultimoBueno * Math.min(1.2, fpsBueno / 60) : n * (r.fps / 60);
        return { capacidad: Math.max(1, cap), fps: r.fps, bajo1: r.bajo1, tope: false };
      }
      ultimoBueno = n; fpsBueno = r.fps; mejor = r;
      n = Math.ceil(n * factor);
    }
    return { capacidad: ultimoBueno * Math.min(1.2, fpsBueno / 60), fps: fpsBueno, bajo1: mejor ? mejor.bajo1 : 0, tope: true };
  }

  // ---------- 2D ----------
  async function prueba2D(lienzo, ui) {
    const ctx = lienzo.getContext("2d", { alpha: false });
    const W = lienzo.width, H = lienzo.height;
    const ids = ["pokeisaac", "pokedive", "dbz", "pokesurvivor", "pokebonk", "overlord"];
    const imgs = await Promise.all(ids.map((id) => new Promise((ok) => {
      const i = new Image();
      i.onload = () => {   // a 48 px, como un sprite de juego
        const c = document.createElement("canvas"); c.width = c.height = 48;
        c.getContext("2d").drawImage(i, 0, 0, 48, 48);
        ok(c);
      };
      i.onerror = () => { const c = document.createElement("canvas"); c.width = c.height = 48; ok(c); };
      i.src = "iconos/" + id + ".png";
    })));
    const s = [];
    const fijar = (n) => {
      while (s.length < n) s.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * 240, vy: (Math.random() - .5) * 240, i: s.length % imgs.length, vida: Math.random() });
      s.length = n;
    };
    let previo = 0;
    const dibujar = (t) => {
      const dt = Math.min(0.05, t - previo); previo = t;
      ctx.fillStyle = "#16131f"; ctx.fillRect(0, 0, W, H);
      for (let k = 0; k < s.length; k++) {
        const p = s[k];
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < 0 || p.x > W) p.vx = -p.vx;
        if (p.y < 0 || p.y > H) p.vy = -p.vy;
        ctx.drawImage(imgs[p.i], p.x - 24, p.y - 24);
        if ((k & 3) === 0) {   // barra de vida, como los enemigos
          ctx.fillStyle = "#3a0d12"; ctx.fillRect(p.x - 18, p.y - 30, 36, 4);
          ctx.fillStyle = "#6fdc5a"; ctx.fillRect(p.x - 18, p.y - 30, 36 * p.vida, 4);
        }
      }
      ctx.globalCompositeOperation = "lighter";   // efectos (ataques, partículas)
      for (let k = 0; k < s.length; k += 6) {
        const p = s[k];
        ctx.fillStyle = "rgba(255,200,60,.35)";
        ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, 6.283); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    };
    return rampa(fijar, dibujar, ui, "2D", { inicio: 150, factor: 1.35, max: 40000 });
  }

  // ---------- 3D ----------
  function compilar(gl, tipo, src) {
    const sh = gl.createShader(tipo);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  async function prueba3D(lienzo, ui) {
    const gl = lienzo.getContext("webgl2", { antialias: true, powerPreference: "high-performance" });
    if (!gl) return { capacidad: 0, fps: 0, bajo1: 0, sinWebGL2: true };
    const vs = `#version 300 es
      in vec3 pos; in vec3 nor; in vec4 inst;   // inst: x, y, z, fase
      uniform mat4 proy; uniform float t;
      out vec3 vN; out vec3 vP; out float vC;
      mat3 rot(float a, float b) { float ca=cos(a), sa=sin(a), cb=cos(b), sb=sin(b);
        return mat3(cb,0.,-sb, sa*sb,ca,sa*cb, ca*sb,-sa,ca*cb); }
      void main() {
        mat3 r = rot(t * 1.3 + inst.w, t * .7 + inst.w * 2.);
        vec3 p = r * pos * .45 + inst.xyz;
        vN = r * nor; vP = p; vC = fract(inst.w * 7.13);
        gl_Position = proy * vec4(p, 1.);
      }`;
    const fs = `#version 300 es
      precision highp float;
      in vec3 vN; in vec3 vP; in float vC; out vec4 color;
      void main() {
        vec3 n = normalize(vN);
        vec3 base = mix(vec3(.9,.25,.3), vec3(.3,.6,1.), vC);
        vec3 l1 = normalize(vec3(.6,.8,.4)), l2 = normalize(vec3(-.7,.3,-.5));
        vec3 v = normalize(-vP);
        float d = max(dot(n,l1),0.) + .4*max(dot(n,l2),0.);
        float s = pow(max(dot(reflect(-l1,n),v),0.), 32.);
        color = vec4(base * (.2 + d) + vec3(s), 1.);
      }`;
    const prog = gl.createProgram();
    gl.attachShader(prog, compilar(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compilar(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    // cubo con normales
    const caras = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    const datos = [];
    for (const [nx, ny, nz] of caras) {
      const u = [ny, nz, nx], v = [nz, nx, ny];
      const esq = [[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]];
      for (const [a, b] of esq) {
        datos.push(nx + u[0]*a + v[0]*b, ny + u[1]*a + v[1]*b, nz + u[2]*a + v[2]*b, nx, ny, nz);
      }
    }
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(datos), gl.STATIC_DRAW);
    const lp = gl.getAttribLocation(prog, "pos"), ln = gl.getAttribLocation(prog, "nor"), li = gl.getAttribLocation(prog, "inst");
    gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(ln); gl.vertexAttribPointer(ln, 3, gl.FLOAT, false, 24, 12);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    gl.enableVertexAttribArray(li); gl.vertexAttribPointer(li, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(li, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.viewport(0, 0, lienzo.width, lienzo.height);
    const asp = lienzo.width / lienzo.height, f = 1 / Math.tan(0.6);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, "proy"), false,
      new Float32Array([f / asp,0,0,0, 0,f,0,0, 0,0,-1.002,-1, 0,0,-0.2,0]));
    const ut = gl.getUniformLocation(prog, "t");
    let n = 0;
    const fijar = (k) => {
      n = k;
      const a = new Float32Array(k * 4);
      for (let i = 0; i < k; i++) {
        a[i*4] = (Math.random() - .5) * 26; a[i*4+1] = (Math.random() - .5) * 16; a[i*4+2] = -8 - Math.random() * 40; a[i*4+3] = Math.random() * 6.28;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, ib);
      gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
    };
    const dibujar = (t) => {
      gl.clearColor(.08, .07, .12, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform1f(ut, t);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, n);
      gl.flush();
    };
    const r = await rampa(fijar, dibujar, ui, "3D", { inicio: 400, factor: 1.4, max: 400000 });
    const ext = gl.getExtension("WEBGL_lose_context");
    if (ext) ext.loseContext();
    return r;
  }

  // ---------- Procesador ----------
  async function pruebaCPU(ui) {
    const N = 1500, CEL = 40, W = 1600, H = 1000;
    const x = new Float32Array(N), y = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N);
    for (let i = 0; i < N; i++) { x[i] = Math.random() * W; y[i] = Math.random() * H; vx[i] = Math.random() - .5; vy[i] = Math.random() - .5; }
    const cols = Math.ceil(W / CEL), filas = Math.ceil(H / CEL);
    const cabeza = new Int32Array(cols * filas), sig = new Int32Array(N);
    let choques = 0;
    function paso() {   // mover, rejilla y colisiones entre vecinos (lo que hace un survivor cada tick)
      cabeza.fill(-1);
      for (let i = 0; i < N; i++) {
        x[i] += vx[i]; y[i] += vy[i];
        if (x[i] < 0 || x[i] >= W) { vx[i] = -vx[i]; x[i] = Math.min(W - 1, Math.max(0, x[i])); }
        if (y[i] < 0 || y[i] >= H) { vy[i] = -vy[i]; y[i] = Math.min(H - 1, Math.max(0, y[i])); }
        const c = (y[i] / CEL | 0) * cols + (x[i] / CEL | 0);
        sig[i] = cabeza[c]; cabeza[c] = i;
      }
      for (let i = 0; i < N; i++) {
        const cx = x[i] / CEL | 0, cy = y[i] / CEL | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx, yy = cy + dy;
          if (xx < 0 || yy < 0 || xx >= cols || yy >= filas) continue;
          for (let j = cabeza[yy * cols + xx]; j >= 0; j = sig[j]) {
            if (j <= i) continue;
            const ddx = x[i] - x[j], ddy = y[i] - y[j];
            if (ddx * ddx + ddy * ddy < 400) { choques++; vx[i] += ddx * .001; vy[i] += ddy * .001; }
          }
        }
      }
    }
    let pasos = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 2500 && !cancelado) {
      const t1 = performance.now();
      while (performance.now() - t1 < 40) { paso(); pasos++; }
      ui(`Procesador: ${pasos} pasos de juego`, null);
      await dormir(0);
    }
    const ms = (performance.now() - t0) / Math.max(1, pasos);   // ms por paso con 1500 entidades
    // capacidad: entidades que caben en ~6 ms de lógica por frame (el resto es para dibujar)
    return { capacidad: N * (6 / ms), msPaso: ms, choques };
  }

  // ---------- Juntar ----------
  function infoGPU() {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) return { gpu: "Sin WebGL", webgl2: false };
      const e = gl.getExtension("WEBGL_debug_renderer_info");
      const gpu = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      let g = String(gpu);
      const m = g.match(/^ANGLE \((.*)\)$/);   // «ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)» → «Adreno 740»
      if (m) { const partes = m[1].split(/,\s*/); g = partes[1] || partes[0]; }
      g = g.replace(/\((TM|R)\)/gi, "").replace(/,?\s*OpenGL ES.*$/i, "").replace(/\s+/g, " ").trim();
      const r = { gpu: g, webgl2: typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext };
      const l = gl.getExtension("WEBGL_lose_context"); if (l) l.loseContext();
      return r;
    } catch (e) { return { gpu: "?", webgl2: false }; }
  }

  /** FPS estimados de un juego con su carga (unidades de cada prueba a 60 FPS). */
  function estimar(res, carga, hz) {
    const c = carga || {};
    let ms = 0;
    if (c.d2) ms += 16.67 * c.d2 / Math.max(1, res.d2.capacidad);
    if (c.d3) ms += res.d3.capacidad ? 16.67 * c.d3 / res.d3.capacidad : 1000;
    if (c.cpu) ms += 6 * c.cpu / Math.max(1, res.cpu.capacidad);
    const tope = Math.min(hz, c.max || hz);
    return Math.max(1, Math.min(tope, 1000 / Math.max(ms, 1000 / tope)));
  }

  function nivel(fps) {
    if (fps >= 50) return { id: "alto", txt: "Fluido", icono: "✅" };
    if (fps >= 30) return { id: "medio", txt: "Jugable", icono: "🟡" };
    if (fps >= 18) return { id: "bajo", txt: "Justo", icono: "⚠️" };
    return { id: "bajo", txt: "No recomendado", icono: "❌", malo: true };
  }

  async function correr(lienzo, ui) {
    cancelado = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    lienzo.width = Math.round(lienzo.clientWidth * dpr);
    lienzo.height = Math.round(lienzo.clientHeight * dpr);
    ui("Midiendo la pantalla…", null, 0);
    const hzMed = await medir(1500);
    const hz = Math.round(hzMed.fps);
    ui("Prueba 2D…", null, 0.1);
    const d2 = await prueba2D(lienzo, (t, f) => ui(t, f, null));
    if (cancelado) return null;
    // el 3D necesita un lienzo nuevo (el anterior ya es 2D)
    const l3 = lienzo.cloneNode(false);
    lienzo.replaceWith(l3);
    l3.width = lienzo.width; l3.height = lienzo.height;
    ui("Prueba 3D…", null, 0.45);
    const d3 = await prueba3D(l3, (t, f) => ui(t, f, null));
    if (cancelado) return null;
    l3.replaceWith(lienzo);
    ui("Prueba del procesador…", null, 0.8);
    const cpu = await pruebaCPU((t) => ui(t, null, null));
    if (cancelado) return null;
    ui("Listo", null, 1);
    // Puntuación: 1000 = un teléfono de gama media de 2022, aprox.
    const punt = Math.round(1000 * Math.cbrt((d2.capacidad / 1500) * (Math.max(d3.capacidad, 1) / 6000) * (cpu.capacidad / 3000)));
    return { fecha: new Date().toISOString(), hz, d2, d3, cpu, puntos: punt, ...infoGPU() };
  }

  return { correr, cancelar: () => (cancelado = true), estimar, nivel };
})();
