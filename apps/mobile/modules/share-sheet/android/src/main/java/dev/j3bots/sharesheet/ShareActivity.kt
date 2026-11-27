// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.sharesheet

import android.os.Bundle
import androidx.core.view.WindowCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * What another app's share sheet opens: a translucent window over that app,
 * in which the app's JavaScript draws the share sheet (`J3Share`,
 * src/share/ShareSheet.tsx) on the same runtime as the app's own screens.
 *
 * Each sheet has a key of its own, handed to its JavaScript as the root's
 * `sheet` property, by which every call names the sheet it comes from: a
 * sheet left open over one app is still the one its own buttons close after
 * another app opened a second.
 *
 * It reads the share once, when the sheet asks (`take`), copying each file
 * into a folder of its own (ShareIntake), and deletes that folder when it
 * ends, whether the share was sent or let go.
 */
class ShareActivity : ReactActivity() {
  private val key: String = UUID.randomUUID().toString()
  private val lock = Any()
  @Volatile private var intake: ShareIntake? = null
  private var taken: Map<String, Any?>? = null
  @Volatile private var ended = false

  override fun getMainComponentName(): String = "J3Share"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    object : ReactActivityDelegate(this@ShareActivity, this@ShareActivity.mainComponentName) {
      override fun getLaunchOptions(): Bundle = Bundle().apply { putString("sheet", key) }
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    // The sheet draws behind the system bars and keeps its content clear of them.
    WindowCompat.setDecorFitsSystemWindows(window, false)
    // Nothing is restored: a share is read from the intent that opened it.
    super.onCreate(null)
    open[key] = WeakReference(this)
  }

  /**
   * The share, read the first time it is asked for and the same after: its
   * text, the title the sending app gave it, the bot of the Direct Share
   * shortcut it came through, and its first `most` files, each copied, at
   * most `limit` + 1 bytes. Called off the main thread.
   */
  internal fun take(limit: Long, most: Int): Map<String, Any?> {
    synchronized(lock) {
      val known = taken
      if (known != null) return known
      ShareIntake.sweep(this)
      val opened = ShareIntake.open(this)
      intake = opened
      val read = opened.read(this, intent, limit, most)
      // The sheet closed while its files were being copied: they go now.
      if (ended) opened.delete()
      taken = read
      return read
    }
  }

  override fun onDestroy() {
    // The activity keeps itself across configuration changes (AndroidManifest.xml),
    // so it ends only when the sheet closes or the system ends it. It never
    // waits for a copy under way, which a slow provider can hold: `take`
    // deletes what it copied once it sees the sheet ended.
    ended = true
    intake?.delete()
    open.remove(key)
    super.onDestroy()
  }

  companion object {
    /** The sheets open now, by key. */
    private val open = ConcurrentHashMap<String, WeakReference<ShareActivity>>()

    /** The sheet `key` names, while it is open. */
    internal fun byKey(key: String): ShareActivity? = open[key]?.get()
  }
}
