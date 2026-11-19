package space.odelserver.prism.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

// fork: a permanent notification while the app is open, so Android does not freeze it in
// the background and its link to the PC stays up: a turn's answer keeps arriving, and coming back shows no "resumed"
// conversation. Turned off in the settings (Lier un téléphone); copied into the generated project by scripts/build.sh.
class LinkService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, getString(R.string.link_channel), NotificationManager.IMPORTANCE_LOW)
      )
    }
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val notification: Notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_link)
      .setContentTitle(getString(R.string.link_title))
      .setContentText(getString(R.string.link_text))
      .setContentIntent(open)
      .setOngoing(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
    } else 0
    ServiceCompat.startForeground(this, ID, notification, type)
    // Not started again by Android on its own: without the app's window there is no link to keep.
    return START_NOT_STICKY
  }

  companion object {
    const val CHANNEL = "link"
    const val ID = 1
  }
}
