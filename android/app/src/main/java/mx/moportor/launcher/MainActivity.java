package mx.moportor.launcher;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Port Launcher para Android: la interfaz (ui/, la misma que en Windows) va en un WebView y llama a
 * window.LauncherAndroid para saber qué juegos hay instalados, bajar e instalar sus APK, abrirlos y desinstalarlos.
 * Cada port se actualiza solo después con su propio actualizador; el launcher solo instala.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + HOST + "/ui/index.html";
    static volatile MainActivity actual;

    private WebView web;
    /** ¿Se ve el launcher? (las actualizaciones en segundo plano esperan y los avisos van por notificación) */
    static volatile boolean visible;
    /** Descargas en curso: id del juego → conexión (para poder cancelar). */
    private final Map<String, Instalador.Trabajo> trabajos = new ConcurrentHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        actual = this;
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))   // /ui/index.html → assets/ui/index.html
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return HOST.equals(r.getUrl().getHost()) ? loader.shouldInterceptRequest(r.getUrl()) : null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !HOST.equals(r.getUrl().getHost());   // nada de navegar fuera del launcher
            }
        });
        web.setWebChromeClient(new android.webkit.WebChromeClient());   // diálogos y consola del WebView
        web.addJavascriptInterface(new Puente(), "LauncherAndroid");
        setContentView(web);
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
        AutoActualizador.programar(this);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        visible = false;
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        js("window.Launcher&&Launcher.refrescar()");   // al volver de instalar, desinstalar o de un juego
    }

    @Override
    protected void onDestroy() {
        if (actual == this) actual = null;
        super.onDestroy();
    }

    void js(String code) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    static String q(String s) { return JSONObject.quote(s == null ? "" : s); }

    void progreso(String id, long hecho, long total, String texto) {
        js("window.Launcher&&Launcher.progreso(" + q(id) + "," + hecho + "," + total + "," + q(texto) + ")");
    }

    void fin(String id, boolean ok, String msg) {
        trabajos.remove(id);
        if (trabajos.isEmpty()) runOnUiThread(() -> getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        js("window.Launcher&&Launcher.fin(" + q(id) + "," + ok + "," + q(msg) + ")");
    }

    /** La respuesta del instalador de Android (InstallReceiver). */
    static void resultado(Instalador.Info info, boolean ok, String msg) {
        MainActivity a = actual;
        if (info != null && a != null) {
            if (info.fondo) a.js("window.Launcher&&Launcher.refrescar()");
            else a.fin(info.id, ok, msg);
        }
    }

    private void instalar(String id, String url, long tamano, String nombre, String tag) {
        Instalador.Trabajo t = new Instalador.Trabajo();
        if (trabajos.putIfAbsent(id, t) != null) return;
        runOnUiThread(() -> getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        new Thread(() -> Instalador.instalar(this, id, url, tamano, nombre, tag, false, t, new Instalador.Oyente() {
            @Override public void progreso(String i, long h, long tot, String txt) {
                MainActivity.this.progreso(i, h, tot, "Instalando".equals(txt) ? "Instalando…" : txt);
            }
            @Override public void error(String i, String msg) { MainActivity.this.fin(i, false, msg); }
        }), "descarga-" + id).start();
    }

    /** window.LauncherAndroid */
    class Puente {
        @JavascriptInterface public String version() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
        }

        /** {paquete: {version, codigo, fecha}} de los que están instalados. */
        @SuppressWarnings("deprecation")
        @JavascriptInterface public String estado(String paquetesJson) {
            JSONObject out = new JSONObject();
            try {
                JSONArray ps = new JSONArray(paquetesJson);
                PackageManager pm = getPackageManager();
                for (int i = 0; i < ps.length(); i++) {
                    String p = ps.getString(i);
                    try {
                        PackageInfo info = pm.getPackageInfo(p, 0);
                        long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
                        out.put(p, new JSONObject().put("version", info.versionName == null ? "" : info.versionName)
                                .put("codigo", code).put("fecha", info.lastUpdateTime));
                    } catch (PackageManager.NameNotFoundException ignored) {
                    }
                }
            } catch (Exception ignored) {
            }
            return out.toString();
        }

        @JavascriptInterface public void instalar(String id, String url, long tamano, String nombre) {
            MainActivity.this.instalar(id, url, tamano, nombre, null);
        }

        @JavascriptInterface public void instalarVersion(String id, String url, long tamano, String nombre, String tag) {
            MainActivity.this.instalar(id, url, tamano, nombre, tag);
        }

        /** Ajustes de la pantalla (auto, soloWifi) → para las actualizaciones en segundo plano. */
        @JavascriptInterface public void ajustes(String json) {
            try {
                JSONObject o = new JSONObject(json);
                AutoActualizador.prefs(MainActivity.this).edit()
                        .putBoolean("auto", o.optBoolean("auto", true))
                        .putBoolean("soloWifi", o.optBoolean("soloWifi", true)).apply();
                AutoActualizador.programar(MainActivity.this);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface public void guardarCatalogo(String juegosJson) {
            AutoActualizador.prefs(MainActivity.this).edit().putString("catalogo", juegosJson).apply();
        }

        @JavascriptInterface public boolean avisosPermitidos() { return Avisos.permitidos(MainActivity.this); }

        @JavascriptInterface public void pedirAvisos() {
            if (Build.VERSION.SDK_INT >= 33)
                runOnUiThread(() -> requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 7));
        }

        /** ¿Puede actualizarlo sin preguntar? (Android 12+ y lo instaló el launcher) */
        @JavascriptInterface public boolean sinPreguntar(String paquete) {
            if (Build.VERSION.SDK_INT < 31) return false;
            try {
                String de = getPackageManager().getInstallSourceInfo(paquete).getInstallingPackageName();
                return getPackageName().equals(de);
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface public boolean conWifi() {
            android.net.ConnectivityManager cm = getSystemService(android.net.ConnectivityManager.class);
            return cm == null || !cm.isActiveNetworkMetered();
        }

        @JavascriptInterface public void cancelar(String id) {
            Instalador.Trabajo t = trabajos.get(id);
            if (t == null) return;
            t.cancelado = true;
            HttpURLConnection c = t.con;
            if (c != null) new Thread(c::disconnect).start();
        }

        @JavascriptInterface public boolean abrir(String paquete) {
            Intent i = getPackageManager().getLaunchIntentForPackage(paquete);
            if (i == null) return false;
            startActivity(i);
            return true;
        }

        @JavascriptInterface public void desinstalar(String paquete) {
            runOnUiThread(() -> startActivity(new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + paquete))));
        }

        @JavascriptInterface public boolean puedeInstalar() {
            return Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls();
        }

        @JavascriptInterface public void pedirPermiso() {
            if (Build.VERSION.SDK_INT < 26) return;
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName()))));
        }
    }
}
