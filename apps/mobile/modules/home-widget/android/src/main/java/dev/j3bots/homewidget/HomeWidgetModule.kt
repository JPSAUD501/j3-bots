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

  private val back: (String) -> Unit = { setup -> sendEvent("onBack", mapOf("setup" to setup)) }

  override fun definition() = ModuleDefinition {
    Name("HomeWidget")

    /** Back was pressed in widget setup `setup`. */
    Events("onBack")

    OnCreate { WidgetSetupActivity.back = back }

    OnDestroy { if (WidgetSetupActivity.back === back) WidgetSetupActivity.back = null }

    /**
     * What the widgets on home screens show: for each, `{ kind, botId }` or
     * `{ kind, routineId, botId }`. Widgets not set up are left out, and the
     * targets of widgets no longer on a home screen are forgotten.
     */
    AsyncFunction("targets") {
      val store = WidgetStore(context)
      val ids = BotWidgetProvider.ids(context)
      store.keepOnly(ids.toSet())
      ids.asList().mapNotNull { id ->
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

    /** Gives the widget setup `setup` is for `target` (JSON `{ kind, botId, routineId? }`); the setup stays open. */
    AsyncFunction("choose") { setup: String, target: String -> WidgetSetupActivity.byKey(setup)?.choose(JSONObject(target)) }

    /** Closes setup `setup`: without a choice, the widget is not placed. */
    Function("close") { setup: String -> WidgetSetupActivity.byKey(setup)?.close() }

    /** Opens the app, on `link` when one is given, then closes setup `setup`. */
    Function("openApp") { setup: String, link: String? ->
      val app = context
      val intent =
        if (link == null) app.packageManager.getLaunchIntentForPackage(app.packageName)
        else Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(app.packageName)
      if (intent != null) app.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      WidgetSetupActivity.byKey(setup)?.close()
    }
  }
}
