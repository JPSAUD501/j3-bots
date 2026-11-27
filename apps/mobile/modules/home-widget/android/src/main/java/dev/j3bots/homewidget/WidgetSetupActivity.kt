// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.homewidget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import androidx.core.view.WindowCompat
import com.facebook.react.ReactActivity
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * Where a widget is given what it shows: Android opens it as the widget is
 * added, the launcher when the operator asks to change it, and the widget
 * itself when what it showed is gone. The app's JavaScript draws the choice
 * (`J3WidgetSetup`, src/widget/WidgetSetup.tsx) in a translucent window.
 *
 * Until a choice is made the result is "cancelled", so a widget being added
 * is not placed when the operator backs out.
 */
class WidgetSetupActivity : ReactActivity() {
  /** The widget being set up, or null when Android named none of the app's widgets. */
  internal var widgetId: Int? = null
    private set

  override fun getMainComponentName(): String = "J3WidgetSetup"

  override fun onCreate(savedInstanceState: Bundle?) {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    super.onCreate(null)
    val given = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    // Only a widget of this app's provider: any app may open this activity.
    val provider = AppWidgetManager.getInstance(this).getAppWidgetInfo(given)?.provider
    widgetId = given.takeIf { provider == ComponentName(this, BotWidgetProvider::class.java) }
    setResult(Activity.RESULT_CANCELED, resultFor(given))
    current = WeakReference(this)
  }

  /**
   * Gives the widget `target` and draws it. The setup stays open until
   * `close`, so the app can first write what the widget shows.
   */
  internal fun choose(target: JSONObject) {
    val id = widgetId ?: return close()
    WidgetStore(this).setTarget(id, target)
    val manager = AppWidgetManager.getInstance(this)
    manager.updateAppWidget(id, BotWidgetProvider.views(this, WidgetStore(this), manager, id))
    runOnUiThread { setResult(Activity.RESULT_OK, resultFor(id)) }
  }

  internal fun close() {
    runOnUiThread { finish() }
  }

  private fun resultFor(id: Int) = Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)

  override fun onDestroy() {
    if (current?.get() === this) current = null
    super.onDestroy()
  }

  companion object {
    /** The setup showing now, if any. */
    @Volatile internal var current: WeakReference<WidgetSetupActivity>? = null
  }
}
