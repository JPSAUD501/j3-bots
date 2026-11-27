// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.connectorappview

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.AndroidRuntimeException
import android.util.Base64
import android.view.View
import android.view.ViewGroup
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
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.roundToInt
import org.json.JSONObject

/**
 * The longest message the app may pass to the host, as the page's relay
 * answers a longer one (`CONNECTOR_APP_BRIDGE_MAX_LENGTH`): the most files
 * one download may offer, 16 MiB as base64, with room for the request around them.
 */
private const val MAX_MESSAGE_LENGTH = 24 * 1024 * 1024

/** The most characters of the app's messages that wait for the main thread together; past these, one is dropped. */
private const val MAX_PENDING_LENGTH = 2L * MAX_MESSAGE_LENGTH

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
 * Every app's frame, by the key the app gave it. A frame outlives the view
 * that shows it: a `ConnectorAppView` with its key takes it in, from any
 * other that had it, so the app moves between the reply, full screen and
 * pinned without loading again (decision 0093). Only `close` ends one.
 * Touched on the main thread only.
 */
internal object AppFrames {
  private val frames = HashMap<String, AppFrame>()

  /** The module's `sendEvent`, while there is a module to send through. */
  var events: ((String, Map<String, String>) -> Unit)? = null

  /** Shows the frame of `key` in `holder`, made from `document` if there is none yet. */
  fun show(key: String, document: String, holder: ViewGroup) {
    val frame =
      frames[key]
        ?: try {
          AppFrame(holder.context, key, document).also { frames[key] = it }
        } catch (missing: AndroidRuntimeException) {
          // This phone has no WebView to draw it with.
          send("onPageFailed", mapOf("key" to key, "cause" to "system"))
          return
        }
    frame.moveTo(holder)
  }

  /** Takes the frame of `key` out of `holder`, if it is there; it keeps running until it is closed. */
  fun hide(key: String, holder: ViewGroup) {
    frames[key]?.leave(holder)
  }

  fun deliver(key: String, message: String) {
    frames[key]?.deliver(message)
  }

  fun close(key: String) {
    frames.remove(key)?.destroy()
  }

  fun closeAll() {
    frames.values.forEach { it.destroy() }
    frames.clear()
  }

  fun failed(key: String, cause: String) {
    close(key)
    send("onPageFailed", mapOf("key" to key, "cause" to cause))
  }

  fun send(event: String, body: Map<String, String>) {
    events?.invoke(event, body)
  }
}

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
 *   microphone, no file chooser, no second window, no dialog
 *   over the app, and nothing the page logs reaches the device's log.
 * - The page reaches the app through one method, `postMessage(string)`,
 *   whose messages are passed on in order, up to `MAX_PENDING` at a time,
 *   as `onAppMessage` with the frame's key.
 *
 * It fails without taking the app down, as a visual's view does
 * (`onPageFailed`, with `page` or `system`).
 */
internal class AppFrame(context: Context, private val key: String, document: String) {
  private val view = WebView(context)
  private val main = Handler(Looper.getMainLooper())
  private var closed = false

  /** The app's messages, in order, waiting for the main thread. */
  private val pending = ConcurrentLinkedQueue<String>()
  private val pendingCount = AtomicInteger(0)
  private val pendingLength = AtomicLong(0)

  init {
    configure(view)
    val encoded = Base64.encodeToString(document.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
    view.loadData(encoded, "text/html; charset=utf-8", "base64")
  }

  /** Puts the WebView in `holder`, out of the view that had it. */
  fun moveTo(holder: ViewGroup) {
    val parent = view.parent
    if (parent === holder) return
    (parent as? ViewGroup)?.removeView(view)
    holder.addView(
      view,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  fun leave(holder: ViewGroup) {
    if (view.parent === holder) holder.removeView(view)
  }

  /** Hands the app one message of the host's, as the shell's `deliver` takes it. */
  fun deliver(message: String) {
    if (closed) return
    view.evaluateJavascript("window.deliver&&window.deliver(${JSONObject.quote(message)})", null)
  }

  /** Lets the page go: nothing of it runs once the frame is closed. */
  fun destroy() {
    if (closed) return
    closed = true
    pending.clear()
    view.stopLoading()
    view.removeJavascriptInterface(BRIDGE_NAME)
    (view.parent as? ViewGroup)?.removeView(view)
    view.destroy()
  }

  private fun fail(cause: String) {
    if (closed) return
    AppFrames.failed(key, cause)
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
      textZoom = (view.resources.configuration.fontScale * 100).roundToInt()
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
      fail(if (view.windowVisibility == View.VISIBLE) "page" else "system")
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
      val length = data.length.toLong()
      if (pendingCount.incrementAndGet() > MAX_PENDING) {
        pendingCount.decrementAndGet()
        return
      }
      if (pendingLength.addAndGet(length) > MAX_PENDING_LENGTH) {
        pendingLength.addAndGet(-length)
        pendingCount.decrementAndGet()
        return
      }
      pending.add(data)
      main.post {
        val message = pending.poll() ?: return@post
        pendingCount.decrementAndGet()
        pendingLength.addAndGet(-message.length.toLong())
        if (!closed) AppFrames.send("onAppMessage", mapOf("key" to key, "data" to message))
      }
    }
  }
}
