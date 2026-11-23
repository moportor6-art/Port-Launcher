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
    /** Descargas en curso: id del juego → conexión (para poder cancelar). */
    private final Map<String, Trabajo> trabajos = new ConcurrentHashMap<>();
    /** Sesión del instalador de Android → id del juego. */
    static final Map<Integer, String> sesiones = new ConcurrentHashMap<>();

    static class Trabajo {
        volatile boolean cancelado;
        volatile HttpURLConnection con;
        volatile PackageInstaller.Session sesion;
    }

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
                .addPathHandler("/ui/", new WebViewAssetLoader.AssetsPathHandler(this))
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
        web.addJavascriptInterface(new Puente(), "LauncherAndroid");
        setContentView(web);
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
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
    static void resultado(int sesion, boolean ok, String msg) {
        String id = sesiones.remove(sesion);
        MainActivity a = actual;
        if (id != null && a != null) a.fin(id, ok, msg);
    }

    /** Baja la APK directamente dentro de una sesión del instalador (sin archivo temporal) y la instala. */
    private void instalar(String id, String url, long tamano, String nombre) {
        Trabajo t = new Trabajo();
        if (trabajos.putIfAbsent(id, t) != null) return;
        runOnUiThread(() -> getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        new Thread(() -> {
            PackageInstaller pi = getPackageManager().getPackageInstaller();
            int sid = -1;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                t.con = c;
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                c.setInstanceFollowRedirects(true);
                c.setRequestProperty("User-Agent", "PortLauncher");
                if (c.getResponseCode() / 100 != 2) throw new Exception("GitHub respondió " + c.getResponseCode());
                long total = c.getContentLengthLong() > 0 ? c.getContentLengthLong() : tamano;
                PackageInstaller.SessionParams sp = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                sp.setAppLabel(nombre);
                if (total > 0) sp.setSize(total);
                if (Build.VERSION.SDK_INT >= 31) sp.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                sid = pi.createSession(sp);
                t.sesion = pi.openSession(sid);
                long hecho = 0, ultimo = 0;
                try (InputStream in = c.getInputStream(); OutputStream out = t.sesion.openWrite("app.apk", 0, total > 0 ? total : -1)) {
                    byte[] b = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(b)) > 0) {
                        if (t.cancelado) throw new InterruptedException();
                        out.write(b, 0, n);
                        hecho += n;
                        long ahora = System.currentTimeMillis();
                        if (ahora - ultimo > 250) { ultimo = ahora; progreso(id, hecho, total, "Descargando"); }
                    }
                    t.sesion.fsync(out);
                }
                if (t.cancelado) throw new InterruptedException();
                progreso(id, total, total, "Instalando: confirma en la ventana de Android");
                sesiones.put(sid, id);
                Intent cb = new Intent(this, InstallReceiver.class);
                int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                t.sesion.commit(PendingIntent.getBroadcast(this, sid, cb, fl).getIntentSender());
                t.sesion.close();
            } catch (InterruptedException e) {
                abandonar(pi, sid, t);
                fin(id, false, "");
            } catch (Exception e) {
                abandonar(pi, sid, t);
                fin(id, false, t.cancelado ? "" : "No se pudo descargar " + nombre + ": " + e.getMessage());
            }
        }, "descarga-" + id).start();
    }

    private static void abandonar(PackageInstaller pi, int sid, Trabajo t) {
        try { if (t.sesion != null) t.sesion.abandon(); else if (sid >= 0) pi.abandonSession(sid); } catch (Exception ignored) { }
    }

    /** window.LauncherAndroid */
    class Puente {
        @JavascriptInterface public String version() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
        }

        /** {paquete: {version}} de los que están instalados. */
        @JavascriptInterface public String estado(String paquetesJson) {
            JSONObject out = new JSONObject();
            try {
                JSONArray ps = new JSONArray(paquetesJson);
                PackageManager pm = getPackageManager();
                for (int i = 0; i < ps.length(); i++) {
                    String p = ps.getString(i);
                    try {
                        PackageInfo info = pm.getPackageInfo(p, 0);
                        out.put(p, new JSONObject().put("version", info.versionName == null ? "" : info.versionName));
                    } catch (PackageManager.NameNotFoundException ignored) {
                    }
                }
            } catch (Exception ignored) {
            }
            return out.toString();
        }

        @JavascriptInterface public void instalar(String id, String url, long tamano, String nombre) {
            MainActivity.this.instalar(id, url, tamano, nombre);
        }

        @JavascriptInterface public void cancelar(String id) {
            Trabajo t = trabajos.get(id);
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
