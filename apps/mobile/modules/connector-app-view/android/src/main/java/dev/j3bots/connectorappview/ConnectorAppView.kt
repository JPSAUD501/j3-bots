// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.connectorappview

import android.annotation.SuppressLint
import android.content.Context
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * Where a connector's app is drawn: it shows the frame of `appKey`
 * (`AppFrames`), made from `document` the first time. Two views with the
 * same key show it in whichever took it last; a view that goes lets the
 * frame go with it, still running, until the app closes it.
 */
@SuppressLint("ViewConstructor")
class ConnectorAppView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  /** The frame's key, which the app gave it. */
  var appKey: String? = null

  /** The page, as `connectorAppShell` built it around `connectorAppDocument`'s. */
  var document: String? = null

  private var shown: String? = null

  /** Shows the frame of `appKey`, once React Native set both props. */
  fun update() {
    val key = appKey ?: return
    val page = document ?: return
    if (key == shown) return
    shown?.let { AppFrames.hide(it, this) }
    shown = key
    AppFrames.show(key, page, this)
  }

  /** The view is gone: its frame is no longer drawn here. */
  fun release() {
    shown?.let { AppFrames.hide(it, this) }
    shown = null
  }
}
