// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.appupdate

import android.app.ActivityManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.security.MessageDigest

/**
 * The app's side of updating itself on Android (src/update/native.ts).
 *
 * It reads what the app is (its version and who installed it), says whether
 * the operator lets J3 Bots install apps, and installs an APK the app already
 * downloaded into its own cache and checked against the release's signed
 * SHA256SUMS. The install goes through a PackageInstaller session: the bytes
 * are hashed again as they are written into it, and the session is committed
 * only when that digest is the one the release signed, so what Android
 * installs is exactly what was checked. Android then asks the operator to
 * confirm, and itself refuses an APK signed with another key or with a lower
 * version code.
 *
 * Only files in the app's update folder are read, so nothing else on the
 * phone can be handed to the installer through this module.
 *
 * Android does not let an app in the background open an activity, so a
 * confirmation the session asks for while the operator is in another app is
 * kept, and shown once when the app comes back.
 */
class AppUpdateModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  /** Android's confirmation of an install, asked for while the app was in the background. */
  private var waiting: Intent? = null

  /** The folder the app downloads updates into: in its cache, which no backup copies. */
  private fun folder(): File = File(context.cacheDir, FOLDER)

  /** `uri`, a `file:` URI from the JavaScript side, when it names a file in the update folder. */
  private fun updateFile(uri: String): File {
    val path = Uri.parse(uri).path ?: throw OutsideFolderException()
    val file = File(path).canonicalFile
    if (file.parentFile != folder().canonicalFile) throw OutsideFolderException()
    return file
  }

  override fun definition() = ModuleDefinition {
    Name("AppUpdate")

    OnActivityEntersForeground {
      val confirm = waiting
      waiting = null
      if (confirm != null) start(confirm)
    }

    /** The update folder, as a `file:` URI ending in a slash, created when missing. */
    Function("folder") {
      val folder = folder()
      folder.mkdirs()
      Uri.fromFile(folder).toString() + "/"
    }

    Function("installedApp") {
      val manager = context.packageManager
      val name = context.packageName
      val info = packageInfo(manager, name)
      mapOf(
        "packageName" to name,
        "versionName" to info.versionName,
        "versionCode" to versionCode(info).toDouble(),
        "installer" to installer(manager, name),
      )
    }

    /** Whether the operator allows J3 Bots to install apps. Before Android 8 the installer asks itself. */
    Function("canRequestInstalls") {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
    }

    /** Opens the system's page where the operator allows J3 Bots to install apps. */
    Function("openInstallSettings") {
      val intent =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
          Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
        else Intent(Settings.ACTION_SECURITY_SETTINGS)
      start(intent)
    }

    AsyncFunction("sha256") { uri: String -> hex(digest(updateFile(uri))) }

    /** What the APK says it is, or null when Android cannot read it as one. */
    AsyncFunction("inspectApk") { uri: String ->
      val file = updateFile(uri)
      archiveInfo(context.packageManager, file.path)?.let {
        mapOf(
          "packageName" to it.packageName,
          "versionName" to it.versionName,
          "versionCode" to versionCode(it).toDouble(),
        )
      }
    }

    AsyncFunction("install") { uri: String, sha256: String, promise: Promise ->
      install(updateFile(uri), sha256.lowercase(), promise)
    }
  }

  private fun install(file: File, sha256: String, promise: Promise) {
    val context = context
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
    params.setAppPackageName(context.packageName)
    val sessionId = installer.createSession(params)
    val session =
      try {
        installer.openSession(sessionId)
      } catch (error: Exception) {
        installer.abandonSession(sessionId)
        throw error
      }
    var receiver: StatusReceiver? = null
    try {
      val digest = MessageDigest.getInstance("SHA-256")
      // The session sets aside `length` bytes, so exactly that many are
      // written: no byte in it is one that was not hashed.
      val length = file.length()
      var written = 0L
      FileInputStream(file).use { input ->
        session.openWrite("base.apk", 0, length).use { output ->
          val buffer = ByteArray(BUFFER)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
            output.write(buffer, 0, read)
            written += read
          }
          session.fsync(output)
        }
      }
      if (written != length || hex(digest.digest()) != sha256) {
        session.abandon()
        promise.resolve(mapOf("_tag" to "digest-mismatch"))
        return
      }
      val action = "${context.packageName}.appupdate.STATUS.$sessionId"
      receiver = StatusReceiver(promise)
      ContextCompat.registerReceiver(
        context,
        receiver,
        IntentFilter(action),
        ContextCompat.RECEIVER_NOT_EXPORTED,
      )
      // Android fills in the outcome, so the intent is mutable; it names
      // this app, so only the app receives it.
      val mutable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
      val status =
        PendingIntent.getBroadcast(
          context,
          sessionId,
          Intent(action).setPackage(context.packageName),
          PendingIntent.FLAG_UPDATE_CURRENT or mutable,
        )
      session.commit(status.intentSender)
    } catch (error: Exception) {
      // Nothing was committed: the session and its receiver end here.
      if (receiver != null) context.unregisterReceiver(receiver)
      session.abandon()
      val code =
        when (error) {
          is IOException -> "io"
          is SecurityException -> "security"
          else -> "error"
        }
      promise.resolve(mapOf("_tag" to "failed", "code" to code, "message" to error.message))
    } finally {
      session.close()
    }
  }

  /**
   * Follows one session to its end: it shows Android's confirmation when the
   * session asks for the operator, or keeps it for when the app comes back,
   * and resolves `promise` with the outcome. Updating the running app ends
   * its process, so success is seldom heard.
   */
  private inner class StatusReceiver(private val promise: Promise) : BroadcastReceiver() {
    override fun onReceive(receiver: Context, intent: Intent) {
      val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
      if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
        val confirm = userAction(intent)
        if (confirm != null) {
          if (inForeground()) start(confirm) else waiting = confirm
          return
        }
      }
      receiver.unregisterReceiver(this)
      waiting = null
      val tag =
        when (status) {
          PackageInstaller.STATUS_SUCCESS -> "installed"
          PackageInstaller.STATUS_FAILURE_ABORTED -> "cancelled"
          // Signed with another key, or a version code not above the installed one.
          PackageInstaller.STATUS_FAILURE_CONFLICT -> "conflict"
          PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "incompatible"
          PackageInstaller.STATUS_FAILURE_STORAGE -> "storage"
          PackageInstaller.STATUS_FAILURE_BLOCKED -> "blocked"
          else -> "failed"
        }
      promise.resolve(
        mapOf(
          "_tag" to tag,
          "code" to status.toString(),
          "message" to intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE),
        )
      )
    }
  }

  private fun start(intent: Intent) {
    val activity = appContext.currentActivity
    if (activity != null) activity.startActivity(intent)
    else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  private class OutsideFolderException :
    CodedException("ERR_OUTSIDE_UPDATE_FOLDER", "The file is not in the app's update folder.", null)

  private companion object {
    const val FOLDER = "app-updates"
    const val BUFFER = 1 shl 16

    fun digest(file: File): ByteArray {
      val digest = MessageDigest.getInstance("SHA-256")
      FileInputStream(file).use { input ->
        val buffer = ByteArray(BUFFER)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
      return digest.digest()
    }

    /** Whether the operator is in the app, which may then open an activity. */
    fun inForeground(): Boolean {
      val state = ActivityManager.RunningAppProcessInfo()
      ActivityManager.getMyMemoryState(state)
      return state.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun versionCode(info: PackageInfo): Long =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
      else @Suppress("DEPRECATION") info.versionCode.toLong()

    fun packageInfo(manager: PackageManager, name: String): PackageInfo =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        manager.getPackageInfo(name, PackageManager.PackageInfoFlags.of(0))
      else @Suppress("DEPRECATION") manager.getPackageInfo(name, 0)

    fun archiveInfo(manager: PackageManager, path: String): PackageInfo? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        manager.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(0))
      else @Suppress("DEPRECATION") manager.getPackageArchiveInfo(path, 0)

    /**
     * The app that installed `name`: `com.android.vending` for Google Play,
     * a browser's or a file manager's package for an APK opened from it, or
     * null when the system does not say (`adb install`).
     */
    fun installer(manager: PackageManager, name: String): String? =
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
          manager.getInstallSourceInfo(name).installingPackageName
        else @Suppress("DEPRECATION") manager.getInstallerPackageName(name)
      } catch (_: PackageManager.NameNotFoundException) {
        null
      }

    fun userAction(intent: Intent): Intent? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
      else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
  }
}
