// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.connectorappview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The view a connector's app is drawn in on Android: a WebView shut away from
 * the app's storage and the rest of the device, which reaches the network
 * only as the app's policy allows (`ConnectorAppView`). `document` is the
 * page as `connectorAppShell` wraps it; `deliver` hands the app one message
 * of the host's, as JSON.
 */
class ConnectorAppViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ConnectorAppView")

    View(ConnectorAppView::class) {
      Events("onAppMessage", "onPageFailed")

      Prop("document") { view: ConnectorAppView, document: String -> view.document = document }

      AsyncFunction("deliver") { view: ConnectorAppView, message: String -> view.deliver(message) }

      OnViewDidUpdateProps { view -> view.update() }
      OnViewDestroys { view -> view.destroy() }
    }
  }
}
