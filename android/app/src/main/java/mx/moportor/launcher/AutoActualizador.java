package mx.moportor.launcher;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Actualizaciones automáticas en segundo plano, como la Play Store: cada pocas horas (con wifi si así está ajustado)
 * mira la última versión de cada juego instalado y, si hay una nueva, la baja y la instala. Si Android pide confirmar
 * (juegos que no instaló el launcher, o Android 11 o anterior) deja un aviso para terminarla con un toque.
 */
public class AutoActualizador extends JobService {
    static final int JOB = 4242;
    static final String CATALOGO_URL = "https://raw.githubusercontent.com/moportor6-art/Port-Launcher/main/catalogo.json";

    private volatile Instalador.Trabajo actual;
    private volatile boolean parar;

    static SharedPreferences prefs(Context ctx) { return ctx.getSharedPreferences("ajustes", MODE_PRIVATE); }

    /** Programa (o quita) la revisión periódica según los ajustes. */
    static void programar(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        if (js == null) return;
        SharedPreferences p = prefs(ctx);
        if (!p.getBoolean("auto", true)) { js.cancel(JOB); return; }
        JobInfo.Builder b = new JobInfo.Builder(JOB, new ComponentName(ctx, AutoActualizador.class))
                .setPeriodic(6 * 60 * 60 * 1000L)
                .setRequiredNetworkType(p.getBoolean("soloWifi", true) ? JobInfo.NETWORK_TYPE_UNMETERED : JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true);
        if (Build.VERSION.SDK_INT >= 26) b.setRequiresBatteryNotLow(true).setRequiresStorageNotLow(true);
        js.schedule(b.build());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        parar = false;
        new Thread(() -> {
            try { revisar(); } catch (Exception ignored) { }
            jobFinished(params, false);
        }, "auto-actualizar").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        parar = true;
        Instalador.Trabajo t = actual;
        if (t != null) {
            t.cancelado = true;
            HttpURLConnection c = t.con;
            if (c != null) new Thread(c::disconnect).start();
        }
        return true;   // que lo vuelva a intentar más tarde
    }

    private void revisar() throws Exception {
        if (!prefs(this).getBoolean("auto", true)) return;
        if (MainActivity.visible) return;   // con el launcher abierto, ya actualiza la pantalla
        JSONArray juegos;
        try {
            juegos = new JSONObject(leer(CATALOGO_URL, false)).getJSONArray("juegos");
            prefs(this).edit().putString("catalogo", juegos.toString()).apply();
        } catch (Exception e) {
            juegos = new JSONArray(prefs(this).getString("catalogo", "[]"));
        }
        PackageManager pm = getPackageManager();
        for (int i = 0; i < juegos.length() && !parar; i++) {
            JSONObject j = juegos.getJSONObject(i);
            JSONObject a = j.optJSONObject("android");
            if (a == null) continue;
            PackageInfo info;
            try { info = pm.getPackageInfo(a.getString("paquete"), 0); } catch (PackageManager.NameNotFoundException e) { continue; }
            JSONObject rel;
            try { rel = new JSONObject(leer("https://api.github.com/repos/" + j.getString("repo") + "/releases/latest", true)); } catch (Exception e) { continue; }
            String tag = rel.optString("tag_name");
            if (!esNueva(a.optString("version", "nombre"), tag, info)) continue;
            Pattern re = Pattern.compile(a.optString("apk", "\\.apk$"), Pattern.CASE_INSENSITIVE);
            JSONArray assets = rel.optJSONArray("assets");
            String url = null;
            long tam = 0;
            for (int k = 0; assets != null && k < assets.length(); k++) {
                JSONObject as = assets.getJSONObject(k);
                if (re.matcher(as.optString("name")).find()) { url = as.optString("browser_download_url"); tam = as.optLong("size"); break; }
            }
            if (url == null) continue;
            actual = new Instalador.Trabajo();
            Instalador.instalar(this, j.getString("id"), url, tam, j.optString("nombre"), tag, true, actual, null);
            actual = null;
        }
    }

    /** ¿La etiqueta publicada es más nueva que lo instalado? (misma regla que ui/app.js) */
    @SuppressWarnings("deprecation")
    static boolean esNueva(String modo, String tag, PackageInfo info) {
        long[] t = numeros(tag.replaceFirst("^[vV]", ""));
        if ("codigo".equals(modo)) {
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            return t.length > 0 && t[t.length - 1] > code;
        }
        long[] v = numeros(info.versionName == null ? "" : info.versionName);
        for (int i = 0; i < Math.max(t.length, v.length); i++) {
            long a = i < t.length ? t[i] : 0, b = i < v.length ? v[i] : 0;
            if (a != b) return a > b;
        }
        return false;
    }

    static long[] numeros(String s) {
        List<Long> l = new ArrayList<>();
        Matcher m = Pattern.compile("[0-9]+").matcher(s);
        while (m.find()) { try { l.add(Long.parseLong(m.group())); } catch (NumberFormatException ignored) { } }
        long[] r = new long[l.size()];
        for (int i = 0; i < r.length; i++) r[i] = l.get(i);
        return r;
    }

    private static String leer(String url, boolean api) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "PortLauncher");
        if (api) c.setRequestProperty("Accept", "application/vnd.github+json");
        if (c.getResponseCode() / 100 != 2) throw new Exception("HTTP " + c.getResponseCode());
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] b = new byte[16384];
            int n;
            while ((n = in.read(b)) > 0) o.write(b, 0, n);
            return o.toString("UTF-8");
        }
    }
}
