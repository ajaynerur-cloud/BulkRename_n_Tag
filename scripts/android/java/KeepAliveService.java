package app.nametag;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Foreground service that runs while a rename or tag save is in progress. It does no work itself: its only
 * job is to tell Android "this app is busy for the user", so the process (and the web view's JavaScript) is
 * not suspended when the app is in the background. It also holds a partial wake lock so the CPU stays awake
 * with the screen off, and shows a progress notification. Started and stopped from JavaScript through
 * FoldersPlugin (startKeepAlive / updateKeepAlive / stopKeepAlive).
 */
public class KeepAliveService extends Service {
    static final String CHANNEL = "nametag_jobs";
    static final int NOTE_ID = 4711;
    static final String EXTRA_TITLE = "title", EXTRA_TEXT = "text", EXTRA_DONE = "done", EXTRA_TOTAL = "total";

    private PowerManager.WakeLock wake;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null && intent.getStringExtra(EXTRA_TITLE) != null ? intent.getStringExtra(EXTRA_TITLE) : "NameTag";
        String text = intent != null && intent.getStringExtra(EXTRA_TEXT) != null ? intent.getStringExtra(EXTRA_TEXT) : "Working…";
        int done = intent != null ? intent.getIntExtra(EXTRA_DONE, 0) : 0;
        int total = intent != null ? intent.getIntExtra(EXTRA_TOTAL, 0) : 0;
        Notification n = build(this, title, text, done, total);
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTE_ID, n);
        } catch (Exception e) { stopSelf(); return START_NOT_STICKY; }
        if (wake == null) {
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nametag:job");
                wake.setReferenceCounted(false);
                wake.acquire(4 * 60 * 60 * 1000L); // safety net: released by stopKeepAlive long before this
            } catch (Exception ignored) { wake = null; }
        }
        // If Android kills the process, do not restart an empty service: the undo file lets the person Resume.
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignored) { }
        wake = null;
        super.onDestroy();
    }

    static Notification build(Context c, String title, String text, int done, int total) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Renames and tag saves", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
        b.setContentTitle(title).setContentText(text).setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_PROGRESS);
        if (total > 0) b.setProgress(total, Math.min(done, total), false);
        else b.setProgress(0, 0, true);
        Intent open = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (open != null) {
            int fl = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
            b.setContentIntent(PendingIntent.getActivity(c, 0, open, fl));
        }
        return b.build();
    }
}
