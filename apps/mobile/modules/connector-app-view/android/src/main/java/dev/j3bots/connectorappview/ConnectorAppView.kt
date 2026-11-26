// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.connectorappview

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Message
import android.util.AndroidRuntimeException
import android.util.Base64
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.roundToInt
import org.json.JSONObject

/**
 * The longest message the app may pass to the host: a tool call's arguments,
 * at most 2 MiB as JSON (`MAX_CONNECTOR_APP_DATA_BYTES`), with room for the
 * request around them.
 */
private const val MAX_MESSAGE_LENGTH = 3 * 1024 * 1024

/** The most messages of the app's that wait for the main thread; any past these are dropped. */
private const val MAX_PENDING = 64

/**
 * The name `connectorAppShell` passes the app's messages to on `window`:
 * `CONNECTOR_APP_BRIDGE` in `@j3-bots/client-runtime/presentation`, which this
 * must match. It is the only thing of the app a page can reach, and it takes
 * one string, which the host reads as a message of the MCP Apps protocol or
 * drops. The WebView puts it in every frame, the app's own included, so the
 * app can call it directly too: what it passes either way is the app's.
 */
private const val BRIDGE_NAME = "J3App"

/**
 * A connector's app, in a WebView of its own that keeps it away from
 * everything else (docs/architecture/security.md, "Connector apps"):
 *
 * - The page is `connectorAppShell`'s, loaded as a `data:` URL, so it has an
 *   opaque origin of its own: no cookie, no storage, nothing of another
 *   page. The app runs in its frame, sandboxed with scripts and forms, under
 *   its own policy, which allows of the network only what its server
 *   declared, over `https:` and `wss:`.
 * - A navigation the policy cannot stop (a link, `location`, `window.open`,
 *   a refresh) is refused here, every time: the page stays the one the app
 *   loaded, and no URL leaves for the system browser except through the
 *   host's own line, which the operator presses.
 * - No files, no content URIs, no DOM storage, no database, no cache, no
 *   third-party cookies, no saved form data, no geolocation, no camera or
 *   microphone, no file chooser, no second window, no dialog over the app,
 *   and nothing the page logs reaches the device's log.
 * - The page reaches the app through one method, `postMessage(string)`,
 *   whose messages are passed on in order, up to `MAX_PENDING` at a time.
 *
 * It fails without taking the app down, as a visual's view does
 * (`onPageFailed`, with `page` or `system`).
 */
@SuppressLint("ViewConstructor")
class ConnectorAppView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onAppMessage by EventDispatcher<Map<String, String>>()
  private val onPageFailed by EventDispatcher<Map<String, String>>()

  override val shouldUseAndroidLayout = true

  /** The page, as `connectorAppShell` built it around `connectorAppDocument`'s. */
  var document: String? = null

  private var webView: WebView? = null
  private var loaded: String? = null
  private var failed = false

  /** The app's messages, in order, waiting for the main thread. */
  private val pending = ConcurrentLinkedQueue<String>()
  private val pendingCount = AtomicInteger(0)

  init {
    try {
      val view = WebView(context)
      configure(view)
      webView = view
      addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    } catch (missing: AndroidRuntimeException) {
      failed = true
      post { onPageFailed(mapOf("cause" to "system")) }
    }
  }

  /** Loads a new page, when React Native set one. */
  fun update() {
    val view = webView ?: return
    val next = document ?: return
    if (next == loaded || failed) return
    loaded = next
    val encoded = Base64.encodeToString(next.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
    view.loadData(encoded, "text/html; charset=utf-8", "base64")
  }

  /** Hands the app one message of the host's, as the shell's `deliver` takes it. */
  fun deliver(message: String) {
    val view = webView ?: return
    view.evaluateJavascript("window.deliver&&window.deliver(${JSONObject.quote(message)})", null)
  }

  /** Lets the page go: nothing of it runs once the view is gone. */
  fun destroy() {
    val view = webView ?: return
    webView = null
    pending.clear()
    view.stopLoading()
    view.removeJavascriptInterface(BRIDGE_NAME)
    removeView(view)
    view.destroy()
  }

  private fun fail(cause: String) {
    if (failed) return
    failed = true
    destroy()
    onPageFailed(mapOf("cause" to cause))
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun configure(view: WebView) {
    with(view.settings) {
      javaScriptEnabled = true
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      // The app's policy says which addresses it may reach; nothing else does here.
      blockNetworkLoads = false
      blockNetworkImage = false
      allowFileAccess = false
      allowContentAccess = false
      @Suppress("DEPRECATION")
      allowFileAccessFromFileURLs = false
      @Suppress("DEPRECATION")
      allowUniversalAccessFromFileURLs = false
      domStorageEnabled = false
      @Suppress("DEPRECATION")
      databaseEnabled = false
      @Suppress("DEPRECATION")
      saveFormData = false
      cacheMode = WebSettings.LOAD_NO_CACHE
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      setGeolocationEnabled(false)
      mediaPlaybackRequiresUserGesture = true
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
      textZoom = (resources.configuration.fontScale * 100).roundToInt()
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
    view.setBackgroundColor(Color.TRANSPARENT)
    view.overScrollMode = View.OVER_SCROLL_NEVER
    view.webViewClient = Client()
    view.webChromeClient = Chrome()
    view.addJavascriptInterface(Bridge(), BRIDGE_NAME)
  }

  private inner class Client : WebViewClient() {
    // The page the app loaded is the only one this view shows.
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

    override fun onReceivedError(
      view: WebView,
      request: WebResourceRequest,
      error: WebResourceError,
    ) {
      if (request.isForMainFrame) fail("page")
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      fail(if (windowVisibility == View.VISIBLE) "page" else "system")
      return true
    }
  }

  private inner class Chrome : WebChromeClient() {
    override fun onCreateWindow(
      view: WebView,
      isDialog: Boolean,
      isUserGesture: Boolean,
      resultMsg: Message,
    ) = false

    override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
      result.cancel()
      return true
    }

    override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
      result.cancel()
      return true
    }

    override fun onJsPrompt(
      view: WebView,
      url: String?,
      message: String?,
      defaultValue: String?,
      result: JsPromptResult,
    ): Boolean {
      result.cancel()
      return true
    }

    override fun onJsBeforeUnload(
      view: WebView,
      url: String?,
      message: String?,
      result: JsResult,
    ): Boolean {
      result.cancel()
      return true
    }

    override fun onPermissionRequest(request: PermissionRequest) = request.deny()

    override fun onGeolocationPermissionsShowPrompt(
      origin: String?,
      callback: GeolocationPermissions.Callback,
    ) = callback.invoke(origin, false, false)

    override fun onShowFileChooser(
      view: WebView,
      filePathCallback: ValueCallback<Array<android.net.Uri>>,
      fileChooserParams: FileChooserParams,
    ) = false

    override fun onConsoleMessage(consoleMessage: ConsoleMessage) = true
  }

  private inner class Bridge {
    /** Called on the WebView's own thread: passed to the app on the main one, in order. */
    @JavascriptInterface
    fun postMessage(data: String?) {
      if (data == null || data.length > MAX_MESSAGE_LENGTH) return
      if (pendingCount.incrementAndGet() > MAX_PENDING) {
        pendingCount.decrementAndGet()
        return
      }
      pending.add(data)
      post {
        val message = pending.poll() ?: return@post
        pendingCount.decrementAndGet()
        if (webView != null) onAppMessage(mapOf("data" to message))
      }
    }
  }
}
