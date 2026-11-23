# Port Launcher

Un solo lugar para instalar y abrir los ports de moportor6, en **Android** y en **Windows**, sin internet una vez instalados.

| Juego | Android | Windows |
|---|---|---|
| PokéIsaac | ✅ | ✅ |
| PokéDive | ✅ | ✅ |
| DB Survivors | ✅ | ✅ |
| PokéSurvivor | ✅ | ✅ |
| PokéBonk / PokéBonk Lite | ✅ | ✅ |
| Pokémon Overlord | ✅ | ✅ |

## Cómo funciona

- **El catálogo** es `catalogo.json`. El launcher lo lee de este repo cada vez que se abre (y guarda una copia para
  cuando no hay internet), así que para añadir un juego nuevo basta con editarlo: no hace falta otra versión del launcher.
- De cada juego mira la **última versión publicada** en su repo (Releases de GitHub).
- **Android:** baja la APK directamente al instalador de Android (sin ocupar espacio extra) y la instala; Android pide
  confirmar cada instalación y, la primera vez, permitir que el launcher instale apps. Después cada port se actualiza
  solo con su propio actualizador.
- **Windows:**
  - Juegos web (PokéIsaac, PokéDive, DB Survivors, PokéSurvivor): la primera vez baja la APK, que ya trae el juego
    completo, y saca de ella la carpeta del juego. En las siguientes versiones baja **solo los archivos que cambiaron**
    (con su huella SHA-256). Cada juego se abre en su ventana, con sus partidas aparte; F11 = pantalla completa.
  - PokéBonk y Pokémon Overlord: baja su ZIP de Windows, lo descomprime y abre el `.exe`. PokéBonk se actualiza solo; Overlord, desde el launcher.
  - Al desinstalar un juego web se borran sus archivos, pero no sus partidas.
- Nada abre páginas de fuera: ni el launcher ni los juegos.
- **Actualizaciones de los juegos:** cada tarjeta dice qué versión tienes y cuál es la nueva; «Novedades» enseña las
  notas de todas las versiones que te faltan (las de GitHub) y desde ahí se actualiza. Arriba, «Actualizar N juegos»
  los pone todos al día de una vez. En Android, abrir el juego también vale: su actualizador baja solo lo que cambió.
- **Windows:** «Acceso directo» crea en el escritorio un icono que abre ese juego sin pasar por la lista.
- **El launcher se actualiza a sí mismo:** avisa al abrirlo y abajo está «Buscar actualización del launcher», con su
  versión, la nueva y sus novedades.
- Icono: una Poké Ball (los ports de Pokémon) con una Esfera del Dragón de botón (DB Survivors); se genera con
  `tools/icono.py`.

## Añadir un juego al catálogo

```json
{
  "id": "nuevo",
  "nombre": "Nombre",
  "desc": "Una línea.",
  "repo": "moportor6-art/Repo",
  "android": { "paquete": "com.ejemplo.app", "apk": "\\.apk$", "version": "nombre" },
  "windows": { "tipo": "web", "apk": "\\.apk$", "dentro": "assets/www", "raw": "web", "inicio": "index.html" }
}
```

- `apk` / `zip`: expresión para elegir el archivo de la versión publicada.
- `version` (Android): `nombre` si la etiqueta (`v0.7`) es igual al versionName de la app; `codigo` si el número de la
  etiqueta (`build-49`, `v178`) es su versionCode.
- `dentro`: carpeta del juego dentro de la APK; `raw`: la misma carpeta en el repo (para bajar solo lo que cambia,
  con el `contenido.json` de cada versión).
- Para un juego con su propio `.exe`: `"windows": { "tipo": "zip", "zip": "…\\.zip$", "exe": "Juego.exe" }`.
- Sin versión de Windows: `"windows": null`. El icono va en `ui/iconos/<id>.png`.

## Estructura

| Carpeta | Qué hay |
|---|---|
| `ui/` | La interfaz, la misma en Android y Windows |
| `android/` | App de Android (WebView + instalador) |
| `desktop/` | App de Windows (Electron) |
| `.github/workflows/compilar.yml` | Compila las dos y las publica como versión `v<VERSION>` |

## Probar en el PC

```
cd desktop
npm install
npm start
```
