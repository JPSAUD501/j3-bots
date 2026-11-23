// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.appnightmode

import android.app.UiModeManager
import android.os.Build
import com.facebook.react.bridge.ReactContext
import com.facebook.react.modules.appearance.AppearanceModule
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The app's side of its theme on Android.
 *
 * `set` tells Android the theme the operator chose for the app. Android 12 and
 * later keep it for the app and draw its next splash screen in it, before any
 * of the app's code runs; without it, the splash follows the system's theme.
 * Earlier versions have no such setting, and it does nothing there.
 *
 * And each time the app comes to the front, it has React Native read the
 * theme again. React Native hears of a change only from a running activity's
 * `onConfigurationChanged`: when Back closed the activity, the system's theme
 * changed, and the app came back in a new activity, nothing told it, and the
 * app stayed in the old theme. `onConfigurationChanged` tells the app only
 * when the theme differs from the one it last told it.
 */
class AppNightModeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppNightMode")

    Function("set") { appearance: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function
      val context = appContext.reactContext ?: return@Function
      val manager = context.getSystemService(UiModeManager::class.java) ?: return@Function
      manager.setApplicationNightMode(
        when (appearance) {
          "light" -> UiModeManager.MODE_NIGHT_NO
          "dark" -> UiModeManager.MODE_NIGHT_YES
          else -> UiModeManager.MODE_NIGHT_AUTO
        }
      )
    }

    OnActivityEntersForeground {
      val activity = appContext.currentActivity ?: return@OnActivityEntersForeground
      val react = appContext.reactContext as? ReactContext ?: return@OnActivityEntersForeground
      react.getNativeModule(AppearanceModule::class.java)?.onConfigurationChanged(activity)
    }
  }
}
