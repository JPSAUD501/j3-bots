// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.connectorappview

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Connector apps on Android: each in a WebView shut away from the app's
 * storage and the rest of the device, which reaches the network only as the
 * app's policy allows (`AppFrame`). A frame is keyed by the app and outlives
 * the view that shows it (`ConnectorAppView`, with `appKey` and `document`,
 * the page as `connectorAppShell` wraps it), until `close`. `deliver` hands
 * an app one message of the host's, as JSON; what an app says arrives as
 * `onAppMessage`, and a frame that failed as `onPageFailed`, with its key.
 */
class ConnectorAppViewModule : Module() {
  private val events: (String, Map<String, String>) -> Unit = { name, body -> sendEvent(name, body) }

  override fun definition() = ModuleDefinition {
    Name("ConnectorAppView")

    Events("onAppMessage", "onPageFailed")

    OnCreate { AppFrames.events = events }

    OnDestroy {
      // The frames are the main thread's, as WebViews are.
      Handler(Looper.getMainLooper()).post {
        if (AppFrames.events === events) AppFrames.events = null
        AppFrames.closeAll()
      }
    }

    AsyncFunction("deliver") { key: String, message: String -> AppFrames.deliver(key, message) }
      .runOnQueue(Queues.MAIN)

    AsyncFunction("close") { key: String -> AppFrames.close(key) }.runOnQueue(Queues.MAIN)

    View(ConnectorAppView::class) {
      Prop("appKey") { view: ConnectorAppView, key: String -> view.appKey = key }

      Prop("document") { view: ConnectorAppView, document: String -> view.document = document }

      OnViewDidUpdateProps { view -> view.update() }
      OnViewDestroys { view -> view.release() }
    }
  }
}
