// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.homewidget

import android.content.Context
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * The widgets' side in Kotlin (src/widget/native.ts): what each widget was
 * set up to show, writing what they show, and the setup's choice.
 */
class HomeWidgetModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun setup(): WidgetSetupActivity? = WidgetSetupActivity.current?.get()

  override fun definition() = ModuleDefinition {
    Name("HomeWidget")

    /**
     * What the widgets on home screens show: for each, `{ kind, botId }` or
     * `{ kind, routineId, botId }`. Widgets not set up are left out, and the
     * targets of widgets no longer on a home screen are forgotten.
     */
    AsyncFunction("targets") {
      val store = WidgetStore(context)
      val ids = BotWidgetProvider.ids(context)
      store.keepOnly(ids.toSet())
      ids.mapNotNull { id ->
        store.target(id)?.let { target ->
          val kind = target.optString("kind")
          val botId = target.optString("botId")
          if (kind == "routine") {
            mapOf("kind" to kind, "botId" to botId, "routineId" to target.optString("routineId"))
          } else {
            mapOf("kind" to kind, "botId" to botId)
          }
        }
      }
    }

    /**
     * Keeps what the widgets show, `snapshot` and the faces `faces` (both
     * JSON, src/widget/snapshot.ts), and draws every widget again.
     */
    AsyncFunction("write") { snapshot: String, faces: String ->
      WidgetStore(context).write(JSONObject(snapshot), JSONObject(faces))
      BotWidgetProvider.redraw(context)
    }

    /** Whether a setup is open for one of the app's widgets. */
    Function("settingUp") { setup()?.widgetId != null }

    /** Gives the widget being set up `target` (JSON `{ kind, botId, routineId? }`); its setup stays open. */
    AsyncFunction("choose") { target: String -> setup()?.choose(JSONObject(target)) }

    /** Closes the setup: without a choice, the widget is not placed. */
    Function("close") { setup()?.close() }

    /** Opens the app, on `link` when one is given, then closes the setup. */
    Function("openApp") { link: String? ->
      val app = context
      val intent =
        if (link == null) app.packageManager.getLaunchIntentForPackage(app.packageName)
        else Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(app.packageName)
      if (intent != null) app.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      setup()?.close()
    }
  }
}
