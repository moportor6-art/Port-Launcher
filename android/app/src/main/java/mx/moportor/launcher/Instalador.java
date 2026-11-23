package mx.moportor.launcher;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Baja una APK directamente dentro de una sesión del instalador de Android (sin archivo temporal) y la instala.
 * Lo usan la pantalla (MainActivity) y las actualizaciones automáticas en segundo plano (AutoActualizador).
 * Si el launcher ya instaló antes ese juego, en Android 12+ la actualización no pide confirmar (como la Play Store).
 */
final class Instalador {
    interface Oyente {
        void progreso(String id, long hecho, long total, String texto);
        void error(String id, String msg);
    }

    static final class Trabajo {
        volatile boolean cancelado;
        volatile HttpURLConnection con;
        volatile PackageInstaller.Session sesion;
    }

    /** Lo que hay detrás de cada sesión del instalador (para InstallReceiver). */
    static final class Info {
        final String id, nombre, tag;
        final boolean fondo;
        Info(String id, String nombre, String tag, boolean fondo) { this.id = id; this.nombre = nombre; this.tag = tag; this.fondo = fondo; }
    }

    static final Map<Integer, Info> sesiones = new ConcurrentHashMap<>();

    private Instalador() { }

    /** Bloquea hasta que la APK está bajada y entregada a Android. Devuelve false si falló o se canceló. */
    static boolean instalar(Context ctx, String id, String url, long tamano, String nombre, String tag, boolean fondo,
                            Trabajo t, Oyente o) {
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
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
            // Sin preguntar cuando Android lo permite (el launcher ya instaló ese juego antes)
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
                    if (o != null && ahora - ultimo > 250) { ultimo = ahora; o.progreso(id, hecho, total, "Descargando"); }
                }
                t.sesion.fsync(out);
            }
            if (t.cancelado) throw new InterruptedException();
            if (o != null) o.progreso(id, total, total, "Instalando");
            sesiones.put(sid, new Info(id, nombre, tag, fondo));
            Intent cb = new Intent(ctx, InstallReceiver.class);
            int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            t.sesion.commit(PendingIntent.getBroadcast(ctx, sid, cb, fl).getIntentSender());
            t.sesion.close();
            return true;
        } catch (InterruptedException e) {
            abandonar(pi, sid, t);
            if (o != null) o.error(id, "");
            return false;
        } catch (Exception e) {
            abandonar(pi, sid, t);
            if (o != null) o.error(id, t.cancelado ? "" : "No se pudo descargar " + nombre + ": " + e.getMessage());
            return false;
        }
    }

    private static void abandonar(PackageInstaller pi, int sid, Trabajo t) {
        try { if (t.sesion != null) t.sesion.abandon(); else if (sid >= 0) pi.abandonSession(sid); } catch (Exception ignored) { }
    }
}
