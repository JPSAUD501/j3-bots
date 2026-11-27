// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.documentpages

import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import android.os.ParcelFileDescriptor
import android.os.Process
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Reads PDFs with Android's own renderer, in the isolated process the
 * manifest gives it: it opens no file and reaches no network, and works only
 * on the files the app hands it, as descriptors, through its binder.
 *
 * Two calls, each on a PDF of its own (`PdfPages`):
 *
 * - `SHAPE`: the PDF; answers its page count, or -1 when it cannot be read,
 *   then the width and height of each of its first pages, in points.
 * - `DRAW`: the PDF, a page, a width in pixels and the file to write;
 *   draws the page that wide, on white, and writes it there as a PNG.
 *   Answers 1 when it did, 0 when it could not.
 *
 * One call runs at a time. One that takes longer than `LIMIT_SECONDS` ends
 * this process: a file that hangs the renderer stops there, and the app
 * hears that the call failed.
 */
class PdfPageService : Service() {
  private val watchdog = Executors.newSingleThreadScheduledExecutor()
  private val lock = Any()

  private val binder =
    object : Binder() {
      override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code != PdfPages.SHAPE && code != PdfPages.DRAW) {
          return super.onTransact(code, data, reply, flags)
        }
        data.enforceInterface(PdfPages.DESCRIPTOR)
        synchronized(lock) {
          val deadline =
            watchdog.schedule(
              { Process.killProcess(Process.myPid()) },
              LIMIT_SECONDS,
              TimeUnit.SECONDS,
            )
          try {
            if (code == PdfPages.SHAPE) shape(data, reply) else draw(data, reply)
          } finally {
            deadline.cancel(false)
          }
        }
        return true
      }
    }

  override fun onBind(intent: Intent): IBinder = binder

  override fun onDestroy() {
    watchdog.shutdownNow()
    super.onDestroy()
  }

  private fun shape(data: Parcel, reply: Parcel?) {
    val pdf = data.readFileDescriptor()
    val most = data.readInt()
    val pages = ArrayList<Pair<Int, Int>>()
    var count = -1
    try {
      if (pdf != null) {
        PdfRenderer(pdf).use { renderer ->
          count = renderer.pageCount
          for (index in 0 until min(count, most)) {
            renderer.openPage(index).use { page -> pages.add(page.width to page.height) }
          }
        }
      }
    } catch (_: Exception) {
      // Not a PDF, a damaged one, or one locked with a password: unreadable.
      count = -1
      pages.clear()
    } finally {
      closeQuietly(pdf)
    }
    reply?.writeNoException()
    reply?.writeInt(count)
    reply?.writeInt(pages.size)
    for ((width, height) in pages) {
      reply?.writeInt(width)
      reply?.writeInt(height)
    }
  }

  private fun draw(data: Parcel, reply: Parcel?) {
    val pdf = data.readFileDescriptor()
    val index = data.readInt()
    val width = data.readInt()
    val out = data.readFileDescriptor()
    var drawn = false
    try {
      if (pdf != null && out != null && width in 1..MAX_WIDTH) {
        PdfRenderer(pdf).use { renderer ->
          if (index in 0 until renderer.pageCount) {
            renderer.openPage(index).use { page ->
              val scale = width.toFloat() / max(page.width, 1)
              val height = min((page.height * scale).roundToInt(), width * MAX_TALLNESS).coerceAtLeast(1)
              val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
              try {
                bitmap.eraseColor(Color.WHITE)
                page.render(
                  bitmap,
                  null,
                  Matrix().apply { setScale(scale, scale) },
                  PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY,
                )
                ParcelFileDescriptor.AutoCloseOutputStream(out).use { stream ->
                  drawn = bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
                }
              } finally {
                bitmap.recycle()
              }
            }
          }
        }
      }
    } catch (_: Exception) {
      drawn = false
    } catch (_: OutOfMemoryError) {
      // A page too large to hold: it stays undrawn, and the process lives on.
      drawn = false
    } finally {
      closeQuietly(pdf)
      closeQuietly(out)
    }
    reply?.writeNoException()
    reply?.writeInt(if (drawn) 1 else 0)
  }

  private fun closeQuietly(descriptor: ParcelFileDescriptor?) {
    try {
      descriptor?.close()
    } catch (_: Exception) {
      // Already closed, by the renderer or the stream that owned it.
    }
  }

  private companion object {
    /** The longest one call may take before this process ends. */
    const val LIMIT_SECONDS = 20L
    /** The widest a page is drawn, in pixels. */
    const val MAX_WIDTH = 2400
    /** The tallest a page is drawn, as a multiple of its width. */
    const val MAX_TALLNESS = 4
  }
}

/** What the app and `PdfPageService` say to each other. */
internal object PdfPages {
  const val DESCRIPTOR = "dev.j3bots.documentpages.PdfPages"
  const val SHAPE = IBinder.FIRST_CALL_TRANSACTION
  const val DRAW = IBinder.FIRST_CALL_TRANSACTION + 1
}
