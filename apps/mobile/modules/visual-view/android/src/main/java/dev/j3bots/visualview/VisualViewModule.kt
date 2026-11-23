// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.visualview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The view a bot's visual is drawn in on Android: a WebView shut away from
 * the network, the app's storage and the rest of the device (`VisualView`).
 * `document` is the page as `visualDocument` wraps it; `interactive` lets the
 * operator touch, scroll and pinch-zoom it, as the full-screen view does.
 */
class VisualViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VisualView")

    View(VisualView::class) {
      Events("onPageMessage", "onPageLoaded", "onPageFailed")

      Prop("document") { view: VisualView, document: String -> view.document = document }
      Prop("interactive") { view: VisualView, interactive: Boolean ->
        view.interactive = interactive
      }

      OnViewDidUpdateProps { view -> view.update() }
      OnViewDestroys { view -> view.destroy() }
    }
  }
}
