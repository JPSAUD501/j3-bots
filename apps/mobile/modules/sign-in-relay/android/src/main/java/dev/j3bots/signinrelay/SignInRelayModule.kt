// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.signinrelay

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

/**
 * The app's side of a connector's sign-in on Android: the browser's return,
 * caught on this phone's loopback, and the sign-in page, in a Custom Tab.
 *
 * `listen` opens a listener on 127.0.0.1, on a port the system picks, in
 * place of any before. It reads each request's line and Host header and asks
 * the app what to answer (`onRequest`, answered with `answer`): which request
 * is the sign-in's own return is the app's to say, with the code every client
 * shares. A request the app does not answer in time, or one too long to be a
 * return, is turned away. Nothing it reads is logged or kept.
 *
 * `open` shows an https: page in a Custom Tab, over the app, and
 * `bringForward` brings the app back over it once the return is caught.
 */
class SignInRelayModule : Module() {
  private val lock = Any()
  private var listener: Listener? = null
  private val replies = ConcurrentHashMap<Int, CompletableFuture<Reply>>()
  private val ids = AtomicInteger()

  override fun definition() = ModuleDefinition {
    Name("SignInRelay")

    Events("onRequest")

    AsyncFunction("listen") {
      val opened =
        try {
          Listener(::serve)
        } catch (_: IOException) {
          return@AsyncFunction null
        }
      synchronized(lock) {
        listener?.close()
        listener = opened
      }
      opened.port
    }

    Function("stop") { port: Int ->
      synchronized(lock) {
        val current = listener
        if (current != null && current.port == port) {
          current.close()
          listener = null
        }
      }
    }

    Function("answer") { id: Int, status: Int, headers: Map<String, String>, body: String ->
      replies.remove(id)?.complete(Reply(status, headers, body))
    }

    AsyncFunction("open") { url: String ->
      val uri = Uri.parse(url)
      val activity = appContext.currentActivity
      if (uri.scheme != "https" || activity == null) return@AsyncFunction false
      try {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, uri)
        true
      } catch (_: ActivityNotFoundException) {
        false
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("bringForward") {
      val context = appContext.reactContext ?: return@AsyncFunction
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val component = launch?.component ?: return@AsyncFunction
      // The app's own activity, with no action: it comes back over the Custom Tab, which closes,
      // and nothing that reads the app's intents takes it for a link or a notification.
      val intent =
        Intent()
          .setComponent(component)
          .addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
              Intent.FLAG_ACTIVITY_CLEAR_TOP or
              Intent.FLAG_ACTIVITY_SINGLE_TOP
          )
      try {
        context.startActivity(intent)
      } catch (_: RuntimeException) {
        // The system kept the app in the back; the landing page says to come back to it.
      }
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      synchronized(lock) {
        listener?.close()
        listener = null
      }
      replies.values.forEach { it.complete(REFUSED) }
      replies.clear()
    }
  }

  /** Reads one request on `socket`, asks the app what to answer, and answers it. */
  private fun serve(socket: Socket, port: Int) {
    socket.use {
      it.soTimeout = READ_TIMEOUT_MS
      val head = readHead(it.getInputStream())
      val reply = if (head == null) REFUSED else ask(head, port)
      write(it, reply)
    }
  }

  private fun ask(head: Head, port: Int): Reply {
    val id = ids.incrementAndGet()
    val reply = CompletableFuture<Reply>()
    replies[id] = reply
    try {
      sendEvent(
        "onRequest",
        mapOf(
          "id" to id,
          "port" to port,
          "method" to head.method,
          "target" to head.target,
          "host" to head.host,
        ),
      )
      return reply.get(ANSWER_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    } catch (_: TimeoutException) {
      return REFUSED
    } catch (_: InterruptedException) {
      return REFUSED
    } finally {
      replies.remove(id)
    }
  }

  /** A listener on 127.0.0.1 alone, which serves a few requests at a time and turns the rest away. */
  private class Listener(private val serve: (Socket, Int) -> Unit) {
    private val server = ServerSocket(0, BACKLOG, InetAddress.getByAddress(LOOPBACK))
    val port: Int = server.localPort
    private val workers =
      ThreadPoolExecutor(0, WORKERS, 30, TimeUnit.SECONDS, ArrayBlockingQueue(QUEUED))

    init {
      Thread({ accept() }, "sign-in-relay").apply { isDaemon = true }.start()
    }

    private fun accept() {
      while (!server.isClosed) {
        val socket =
          try {
            server.accept()
          } catch (_: IOException) {
            break
          }
        try {
          workers.execute {
            try {
              serve(socket, port)
            } catch (_: Exception) {
              // The browser went away mid-request, or the request was cut short: no one waits on it.
            }
          }
        } catch (_: RejectedExecutionException) {
          socket.close()
        }
      }
    }

    fun close() {
      try {
        server.close()
      } catch (_: IOException) {
        // Already closed.
      }
      // A request already read still gets its answer; none is taken after.
      workers.shutdown()
    }
  }

  /** What a request says that the app needs: its method, its target, and the one Host it names. */
  private class Head(val method: String, val target: String, val host: String?)

  private class Reply(val status: Int, val headers: Map<String, String>, val body: String)

  private companion object {
    val LOOPBACK = byteArrayOf(127, 0, 0, 1)
    const val BACKLOG = 8
    const val WORKERS = 4
    const val QUEUED = 8
    const val READ_TIMEOUT_MS = 5_000
    const val ANSWER_TIMEOUT_MS = 10_000L

    /** The longest request head read: the return's address and a browser's headers. */
    const val HEAD_MAX = 16 * 1024

    val REFUSED = Reply(400, emptyMap(), "")

    val END = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())

    /**
     * The request's head, up to the blank line that ends it, or null when it
     * is longer than `HEAD_MAX`, ends early, or is not a request line and
     * headers. A second Host header leaves it with none.
     */
    fun readHead(input: InputStream): Head? {
      val bytes = ByteArrayOutputStream()
      var matched = 0
      while (matched < END.size) {
        val next = input.read()
        if (next < 0 || bytes.size() >= HEAD_MAX) return null
        bytes.write(next)
        matched = if (next.toByte() == END[matched]) matched + 1 else if (next.toByte() == END[0]) 1 else 0
      }
      val lines = bytes.toString(Charsets.ISO_8859_1.name()).split("\r\n")
      val request = lines.first().split(' ')
      if (request.size != 3 || !request[2].startsWith("HTTP/")) return null
      val hosts =
        lines
          .drop(1)
          .filter { it.isNotEmpty() }
          .mapNotNull { line ->
            val colon = line.indexOf(':')
            if (colon <= 0) null
            else if (line.substring(0, colon).trim().equals("host", ignoreCase = true)) {
              line.substring(colon + 1).trim()
            } else null
          }
      return Head(request[0], request[1], hosts.singleOrNull())
    }

    fun write(socket: Socket, reply: Reply) {
      val body = reply.body.toByteArray(Charsets.UTF_8)
      val head = StringBuilder()
      head.append("HTTP/1.1 ").append(reply.status).append(' ').append(reason(reply.status)).append("\r\n")
      for ((name, value) in reply.headers) {
        // Only the app's own constant headers come here; a line break would start another.
        if (name.any { it == '\r' || it == '\n' } || value.any { it == '\r' || it == '\n' }) continue
        head.append(name).append(": ").append(value).append("\r\n")
      }
      head.append("content-length: ").append(body.size).append("\r\n")
      head.append("connection: close\r\n\r\n")
      val output = socket.getOutputStream()
      output.write(head.toString().toByteArray(Charsets.ISO_8859_1))
      output.write(body)
      output.flush()
    }

    fun reason(status: Int): String =
      when (status) {
        200 -> "OK"
        400 -> "Bad Request"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        else -> "Error"
      }
  }
}
