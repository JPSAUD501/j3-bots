// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.sharesheet

import android.os.Bundle
import androidx.core.view.WindowCompat
import com.facebook.react.ReactActivity
import java.lang.ref.WeakReference

/**
 * What another app's share sheet opens: a translucent window over that app,
 * in which the app's JavaScript draws the share sheet (`J3Share`,
 * src/share/ShareSheet.tsx) on the same runtime as the app's own screens.
 *
 * It reads the share once, when the sheet asks (`take`), copying each file
 * into a folder of its own (ShareIntake), and deletes that folder when it
 * ends, whether the share was sent or let go.
 */
class ShareActivity : ReactActivity() {
  private var intake: ShareIntake? = null
  private var taken: Map<String, Any?>? = null

  override fun getMainComponentName(): String = "J3Share"

  override fun onCreate(savedInstanceState: Bundle?) {
    // The sheet draws behind the system bars and keeps its content clear of them.
    WindowCompat.setDecorFitsSystemWindows(window, false)
    // Nothing is restored: a share is read from the intent that opened it.
    super.onCreate(null)
    current = WeakReference(this)
  }

  /**
   * The share, read the first time it is asked for and the same after: its
   * text, the title the sending app gave it, the bot of the Direct Share
   * shortcut it came through, and each file copied, at most `limit` + 1 bytes.
   */
  @Synchronized
  internal fun take(limit: Long): Map<String, Any?> {
    taken?.let {
      return it
    }
    ShareIntake.sweep(this)
    val opened = ShareIntake.open(this)
    intake = opened
    val read = opened.read(this, intent, limit)
    taken = read
    return read
  }

  override fun onDestroy() {
    // The activity keeps itself across configuration changes (AndroidManifest.xml),
    // so it ends only when the sheet closes or the system ends it.
    synchronized(this) { intake?.delete() }
    if (current?.get() === this) current = null
    super.onDestroy()
  }

  companion object {
    /** The share sheet showing now, if any. */
    @Volatile internal var current: WeakReference<ShareActivity>? = null
  }
}
