// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.sharesheet

import android.content.Context
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray

/**
 * The share sheet's side in Kotlin (src/share/native.ts): the share the
 * sheet shows, closing it, opening the app from it, and the bots Direct
 * Share offers.
 */
class ShareSheetModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val back: (String) -> Unit = { sheet -> sendEvent("onBack", mapOf("sheet" to sheet)) }

  override fun definition() = ModuleDefinition {
    Name("ShareSheet")

    /** Back was pressed in share sheet `sheet`. */
    Events("onBack")

    OnCreate { ShareActivity.back = back }

    OnDestroy { if (ShareActivity.back === back) ShareActivity.back = null }

    /**
     * The share sheet `sheet` was opened with, read and copied once
     * (ShareIntake): its first `most` files, each at most `limit` + 1 bytes;
     * null when that sheet is no longer open.
     */
    AsyncFunction("take") { sheet: String, limit: Double, most: Int ->
      ShareActivity.byKey(sheet)?.take(limit.toLong(), most)
    }

    /** Closes share sheet `sheet`, deleting its share's copies. */
    Function("close") { sheet: String ->
      ShareActivity.byKey(sheet)?.let { activity -> activity.runOnUiThread { activity.finish() } }
    }

    /**
     * Opens the app, on `link` when one is given, as a new task over the app
     * that shared, then closes share sheet `sheet`.
     */
    Function("openApp") { sheet: String, link: String? ->
      val app = context
      val intent =
        if (link == null) app.packageManager.getLaunchIntentForPackage(app.packageName)
        else Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(app.packageName)
      val activity = ShareActivity.byKey(sheet)
      if (intent != null) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        (activity ?: app).startActivity(intent)
      }
      activity?.let { shown -> shown.runOnUiThread { shown.finish() } }
    }

    /** The bots Direct Share offers, in order: a JSON array of `{ id, name, icon, link }`. */
    AsyncFunction("setShortcuts") { bots: String -> ShareShortcuts.set(context, JSONArray(bots)) }

    /** Tells Android the operator shared to `botId`. */
    AsyncFunction("reportShared") { botId: String -> ShareShortcuts.used(context, botId) }
  }
}
