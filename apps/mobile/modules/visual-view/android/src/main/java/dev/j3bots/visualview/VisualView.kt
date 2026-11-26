// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.visualview

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
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToInt

/** The longest message a page may pass to the app: a height report is about 40 characters. */
private const val MAX_MESSAGE_LENGTH = 256

/**
 * The name `visualShell` passes the visual's height to on `window`:
 * `VISUAL_BRIDGE` in `@j3-bots/client-runtime/presentation`, which this must
 * match. It is the only thing of the app a page can reach, and it takes one
 * string. The WebView puts it in every frame, the visual's own included.
 */
private const val BRIDGE_NAME = "J3Visual"

/**
 * A bot's visual, in a WebView of its own that keeps it away from everything
 * else (docs/architecture/security.md, "Visuals"):
 *
 * - The page is `visualShell`'s, loaded as a `data:` URL, so it has an opaque
 *   origin of its own: no cookie, no storage, nothing of another page. The
 *   visual runs in its frame, sandboxed with scripts only, so a frame the
 *   visual adds has an origin of its own too, and lends it nothing.
 * - No network at all (`blockNetworkLoads`), under the page's own policy,
 *   which already allows none. A navigation the policy cannot stop (a link,
 *   `location`, `window.open`, a refresh) is refused here, on the WebView's
 *   own thread, every time: the page stays the one the app loaded, and no URL
 *   ever leaves for the system browser.
 * - No files, no content URIs, no DOM storage, no database, no cache, no
 *   third-party cookies, no saved form data, no geolocation, no camera or
 *   microphone, no file chooser, no second window, no dialog over the app,
 *   and nothing the page logs reaches the device's log.
 * - The page reaches the app through one method, `postMessage(string)`,
 *   which takes a short string, and passes on at most one at a time: the app
 *   reads only a height from it, or that the visual left its frame
 *   (`readVisualReport`).
 *
 * The WebView is drawn on a clear background, so the placeholder behind it
 * shows until the page has painted its own.
 *
 * It fails without taking the app down: when the device has no WebView, or
 * the one it has is being updated, when the page's renderer dies, or when the
 * page cannot load. `onPageFailed` says whether the page itself was the cause
 * (`page`), and so would fail again, or the system was (`system`), and a later
 * try may work.
 */
@SuppressLint("ViewConstructor")
class VisualView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onPageMessage by EventDispatcher<Map<String, String>>()
  private val onPageLoaded by EventDispatcher<Unit>()
  private val onPageFailed by EventDispatcher<Map<String, String>>()

  override val shouldUseAndroidLayout = true

  /** The page, as `visualShell` built it around `visualDocument`'s. */
  var document: String? = null

  /** Whether the operator can touch, scroll and zoom it; inline, it is only drawn. */
  var interactive = false

  private var webView: WebView? = null
  private var loaded: String? = null
  private var failed = false

  /** The page's latest message, waiting for the main thread; at most one at a time. */
  private val pending = AtomicReference<String?>(null)

  init {
    try {
      val view = WebView(context)
      configure(view)
      webView = view
      addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    } catch (missing: AndroidRuntimeException) {
      // No WebView provider: none is installed, or the system is updating it.
      // Said once the view is attached, when the app can hear it.
      failed = true
      post { onPageFailed(mapOf("cause" to "system")) }
    }
  }

  /** Applies the props React Native set: the zoom and scroll of `interactive`, and a new page. */
  fun update() {
    val view = webView ?: return
    view.settings.setSupportZoom(interactive)
    view.settings.builtInZoomControls = interactive
    view.isVerticalScrollBarEnabled = interactive
    view.isHorizontalScrollBarEnabled = interactive
    view.overScrollMode = if (interactive) View.OVER_SCROLL_IF_CONTENT_SCROLLS else View.OVER_SCROLL_NEVER
    // Only drawn, it takes no focus, and a screen reader reads the card's title instead of the page.
    view.isFocusable = interactive
    view.isFocusableInTouchMode = interactive
    view.importantForAccessibility =
      if (interactive) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
      else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    val next = document ?: return
    if (next == loaded || failed) return
    loaded = next
    val encoded = Base64.encodeToString(next.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
    view.loadData(encoded, "text/html; charset=utf-8", "base64")
  }

  /** Lets the page go: nothing of it runs once the view is gone. */
  fun destroy() {
    val view = webView ?: return
    webView = null
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
      // The page's own scripts draw its charts; the page's policy allows only inline ones.
      javaScriptEnabled = true
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      blockNetworkLoads = true
      blockNetworkImage = true
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
      displayZoomControls = false
      // Text follows the size the operator chose for the system, as the app's own does.
      textZoom = (resources.configuration.fontScale * 100).roundToInt()
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
    view.setBackgroundColor(Color.TRANSPARENT)
    view.webViewClient = Client()
    view.webChromeClient = Chrome()
    view.addJavascriptInterface(Bridge(), BRIDGE_NAME)
  }

  private inner class Client : WebViewClient() {
    // The page the app loaded is the only one this view shows.
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

    override fun onPageFinished(view: WebView, url: String?) {
      if (!failed) onPageLoaded(Unit)
    }

    override fun onReceivedError(
      view: WebView,
      request: WebResourceRequest,
      error: WebResourceError,
    ) {
      if (request.isForMainFrame) fail("page")
    }

    // The renderer, which every WebView of the app shares, is gone: this
    // visual says it could not be shown, and the app goes on. On screen, a
    // page drawn there took it down; out of sight, the system reclaimed it.
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
    /** Called on the WebView's own thread: passed to the app on the main one, the latest only. */
    @JavascriptInterface
    fun postMessage(data: String?) {
      if (data == null || data.length > MAX_MESSAGE_LENGTH) return
      if (pending.getAndSet(data) != null) return
      post {
        val message = pending.getAndSet(null)
        if (message != null && webView != null) onPageMessage(mapOf("data" to message))
      }
    }
  }
}
