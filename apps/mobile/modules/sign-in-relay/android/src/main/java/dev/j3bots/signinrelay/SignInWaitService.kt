// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.signinrelay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Keeps the app running while a sign-in's browser is in front. Android
 * freezes an app it caches, and an app behind a Custom Tab is cached: its
 * loopback listener would take the browser's return only once the operator
 * came back to the app. A short foreground service, for as long as the
 * listener waits, keeps it awake; Android ends it after a few minutes, and a
 * return that arrives later is still taken when the app is opened again.
 */
class SignInWaitService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty()
    val channelName = intent?.getStringExtra(EXTRA_CHANNEL).orEmpty()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(NOTIFICATION_ID, notice(title, channelName), ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE)
      } else {
        startForeground(NOTIFICATION_ID, notice(title, channelName))
      }
    } catch (_: RuntimeException) {
      // Android refused it (the app was no longer in front): the return waits for the app instead.
      stopSelf()
    }
    return START_NOT_STICKY
  }

  // A short service ends when Android says its time is up.
  override fun onTimeout(startId: Int) = stopSelf()

  override fun onTimeout(startId: Int, fgsType: Int) = stopSelf()

  private fun notice(title: String, channelName: String): Notification {
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        Notification.Builder(this, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(this)
      }
    return builder
      .setContentTitle(title)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val CHANNEL_ID = "sign-in"
    private const val NOTIFICATION_ID = 4_401
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_CHANNEL = "channel"

    /** Starts the service; it is asked while the app is in front, as a foreground service must be. */
    fun start(context: Context, title: String, channelName: String) {
      val intent =
        Intent(context, SignInWaitService::class.java)
          .putExtra(EXTRA_TITLE, title)
          .putExtra(EXTRA_CHANNEL, channelName)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      } catch (_: RuntimeException) {
        // Not allowed now: the listener still answers once the app is opened again.
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, SignInWaitService::class.java))
    }
  }
}
