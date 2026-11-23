package mx.moportor.launcher;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/**
 * Respuesta del instalador de Android. Con el launcher a la vista pide confirmar si hace falta y avisa a la pantalla;
 * en segundo plano deja una notificación (actualizado, o «toca para terminar» si Android pide confirmar).
 */
public class InstallReceiver extends BroadcastReceiver {
    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context ctx, Intent intent) {
        int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        int sesion = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        Instalador.Info info = Instalador.sesiones.get(sesion);
        String nombre = info == null ? "El juego" : info.nombre;
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {   // Android pide confirmar la instalación
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm == null) return;
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (MainActivity.visible) ctx.startActivity(confirm);
            else Avisos.mostrar(ctx, sesion, "Actualización lista: " + nombre,
                    "Toca para terminar de instalar " + nombre + (info != null && info.tag != null ? " " + info.tag : "") + ".", confirm);
            return;
        }
        Instalador.sesiones.remove(sesion);
        if (st == PackageInstaller.STATUS_SUCCESS) {
            if (info != null && info.fondo)
                Avisos.mostrar(ctx, sesion, nombre + " actualizado" + (info.tag != null ? " a " + info.tag : ""),
                        "Abre el launcher para ver las novedades.", null);
            MainActivity.resultado(info, true, "");
        } else if (st == PackageInstaller.STATUS_FAILURE_ABORTED) {
            MainActivity.resultado(info, false, "");
        } else {
            String m = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            String extra = st == PackageInstaller.STATUS_FAILURE_CONFLICT
                    ? " Si ya lo tenías instalado de otra forma (otra firma), desinstálalo primero." : "";
            MainActivity.resultado(info, false, "No se pudo instalar " + nombre + (m == null ? "." : ": " + m + ".") + extra);
        }
    }
}
