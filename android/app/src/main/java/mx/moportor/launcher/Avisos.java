package mx.moportor.launcher;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/** Notificaciones del launcher: juego actualizado, o «toca para terminar de actualizar» si Android pide confirmar. */
final class Avisos {
    static final String CANAL = "actualizaciones";

    private Avisos() { }

    static boolean permitidos(Context ctx) {
        return Build.VERSION.SDK_INT < 33
                || ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private static NotificationManager nm(Context ctx) {
        NotificationManager m = ctx.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && m.getNotificationChannel(CANAL) == null) {
            NotificationChannel c = new NotificationChannel(CANAL, "Actualizaciones de los juegos", NotificationManager.IMPORTANCE_DEFAULT);
            c.setDescription("Cuando el launcher actualiza un juego en segundo plano");
            m.createNotificationChannel(c);
        }
        return m;
    }

    @SuppressWarnings("deprecation")
    static void mostrar(Context ctx, int idAviso, String titulo, String texto, Intent alTocar) {
        if (!permitidos(ctx)) return;
        if (alTocar == null) alTocar = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(ctx, idAviso, alTocar, fl);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CANAL) : new Notification.Builder(ctx);
        b.setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(titulo)
                .setContentText(texto)
                .setStyle(new Notification.BigTextStyle().bigText(texto))
                .setContentIntent(pi)
                .setAutoCancel(true);
        try { nm(ctx).notify(idAviso, b.build()); } catch (SecurityException ignored) { }
    }
}
