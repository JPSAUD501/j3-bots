// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.appnightmode

import android.app.UiModeManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Tells Android the theme the operator chose for the app. Android 12 and
 * later keep it for the app and draw its next splash screen in it, before any
 * of the app's code runs; without it, the splash follows the system's theme.
 * Earlier versions have no such setting, and this does nothing there.
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
  }
}
