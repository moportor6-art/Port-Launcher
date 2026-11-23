package mx.moportor.launcher;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/** Respuesta del instalador de Android: pide confirmar si hace falta y avisa a la interfaz al terminar. */
public class InstallReceiver extends BroadcastReceiver {
    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context ctx, Intent intent) {
        int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        int sesion = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {   // Android pide confirmar la instalación
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(confirm);
            }
        } else if (st == PackageInstaller.STATUS_SUCCESS) {
            MainActivity.resultado(sesion, true, "");
        } else if (st == PackageInstaller.STATUS_FAILURE_ABORTED) {
            MainActivity.resultado(sesion, false, "");
        } else {
            String m = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            String extra = st == PackageInstaller.STATUS_FAILURE_CONFLICT
                    ? " Si ya lo tenías instalado de otra forma (otra firma), desinstálalo primero." : "";
            MainActivity.resultado(sesion, false, "No se pudo instalar" + (m == null ? "." : ": " + m + ".") + extra);
        }
    }
}
