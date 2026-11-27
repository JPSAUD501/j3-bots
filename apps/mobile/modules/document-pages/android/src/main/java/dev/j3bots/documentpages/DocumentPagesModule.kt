// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.documentpages

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.IBinder
import android.os.Parcel
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The app's side of drawing a PDF's pages on Android (src/platform/documents.ts).
 *
 * The app writes a PDF it downloaded into its document folder, in its cache,
 * and asks for the PDF's shape (how many pages, and how large each is) and
 * then for each page it shows, drawn as wide as it shows it. The drawing
 * itself happens in `PdfPageService`, Android's own PDF renderer in a process
 * Android isolates; this module hands it the PDF and the file to draw into,
 * and answers where the drawing is. A drawing is kept in the folder's
 * `pages/` and given again when asked for again.
 *
 * Only files in the document folder are read, and only `pages/` is written,
 * so nothing else on the phone reaches the renderer through this module. The
 * calls run one at a time, on a thread of their own.
 */
class DocumentPagesModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val worker: ExecutorService = Executors.newSingleThreadExecutor()

  /** The renderer's binder, while its process runs. */
  @Volatile private var service: IBinder? = null
  private var connection: ServiceConnection? = null

  /** The folder the app writes PDFs into: in its cache, which no backup copies. */
  private fun folder(): File = File(context.cacheDir, FOLDER)

  private fun pagesFolder(): File = File(folder(), PAGES)

  /** `uri`, a `file:` URI from the JavaScript side, when it names a file in the document folder. */
  private fun documentFile(uri: String): File? {
    val path = Uri.parse(uri).path ?: return null
    val file = File(path).canonicalFile
    return if (file.parentFile == folder().canonicalFile && file.isFile) file else null
  }

  override fun definition() = ModuleDefinition {
    Name("DocumentPages")

    /** The document folder, as a `file:` URI ending in a slash, created when missing. */
    Function("folder") {
      val folder = folder()
      folder.mkdirs()
      Uri.fromFile(folder).toString().trimEnd('/') + "/"
    }

    /** The page count of the PDF at `uri` and the size of its first `most` pages; null when unreadable. */
    AsyncFunction("shape") { uri: String, most: Int, promise: Promise ->
      worker.execute { promise.resolve(shape(uri, most)) }
    }

    /** The page `index` of the PDF at `uri`, drawn `width` pixels wide, as a PNG's `file:` URI; null when it cannot be drawn. */
    AsyncFunction("draw") { uri: String, index: Int, width: Int, promise: Promise ->
      worker.execute { promise.resolve(draw(uri, index, width)) }
    }

    OnDestroy {
      worker.execute { unbind() }
      worker.shutdown()
    }
  }

  private fun shape(uri: String, most: Int): Map<String, Any>? {
    val file = documentFile(uri) ?: return null
    return call(PdfPages.SHAPE) { data, held ->
      writeFile(data, held, file, ParcelFileDescriptor.MODE_READ_ONLY)
      data.writeInt(most)
    }?.let { reply ->
      try {
        val count = reply.readInt()
        if (count < 0) return@let null
        val pages = (0 until reply.readInt()).map {
          mapOf("width" to reply.readInt(), "height" to reply.readInt())
        }
        mapOf("count" to count, "pages" to pages)
      } finally {
        reply.recycle()
      }
    }
  }

  private fun draw(uri: String, index: Int, width: Int): String? {
    val file = documentFile(uri) ?: return null
    val pages = pagesFolder()
    pages.mkdirs()
    val drawing = File(pages, "${file.nameWithoutExtension}-$index-$width.png")
    if (drawing.isFile) return Uri.fromFile(drawing).toString()
    val part = File(pages, "${drawing.name}.part")
    val drawn = call(PdfPages.DRAW) { data, held ->
      writeFile(data, held, file, ParcelFileDescriptor.MODE_READ_ONLY)
      data.writeInt(index)
      data.writeInt(width)
      writeFile(
        data,
        held,
        part,
        ParcelFileDescriptor.MODE_WRITE_ONLY or
          ParcelFileDescriptor.MODE_CREATE or
          ParcelFileDescriptor.MODE_TRUNCATE,
      )
    }?.let { reply ->
      try {
        reply.readInt() == 1
      } finally {
        reply.recycle()
      }
    } ?: false
    // Written whole before it is named, so a drawing cut short is never shown.
    if (drawn && part.renameTo(drawing)) return Uri.fromFile(drawing).toString()
    part.delete()
    return null
  }

  /**
   * Opens `file` and writes its descriptor into `data`, holding it in `held`
   * until the call ends; the binder gives the renderer its own copy.
   */
  private fun writeFile(
    data: Parcel,
    held: MutableList<ParcelFileDescriptor>,
    file: File,
    mode: Int,
  ) {
    val descriptor = ParcelFileDescriptor.open(file, mode)
    held.add(descriptor)
    data.writeFileDescriptor(descriptor.fileDescriptor)
  }

  /**
   * Calls the renderer with what `write` puts in the call, and gives its
   * answer to read; null when the call could not be made, or its process
   * ended under it (a file that crashed or hung the renderer).
   */
  private fun call(
    code: Int,
    write: (Parcel, MutableList<ParcelFileDescriptor>) -> Unit,
  ): Parcel? {
    val data = Parcel.obtain()
    val reply = Parcel.obtain()
    val held = ArrayList<ParcelFileDescriptor>()
    return try {
      data.writeInterfaceToken(PdfPages.DESCRIPTOR)
      write(data, held)
      val binder = binder() ?: throw IllegalStateException("The renderer did not start.")
      binder.transact(code, data, reply, 0)
      reply.readException()
      reply
    } catch (_: Exception) {
      reply.recycle()
      null
    } finally {
      data.recycle()
      for (descriptor in held) {
        try {
          descriptor.close()
        } catch (_: Exception) {
          // Closed already.
        }
      }
    }
  }

  /** The renderer's binder, starting its process when it is not running. */
  private fun binder(): IBinder? {
    service?.let { if (it.isBinderAlive) return it }
    unbind()
    val started = CountDownLatch(1)
    val connection =
      object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
          service = binder
          started.countDown()
        }

        // Its process ended; Android starts it again for the next call.
        override fun onServiceDisconnected(name: ComponentName) {
          service = null
        }
      }
    val intent = Intent(context, PdfPageService::class.java)
    if (!context.bindService(intent, connection, Context.BIND_AUTO_CREATE)) {
      context.unbindService(connection)
      return null
    }
    this.connection = connection
    started.await(START_SECONDS, TimeUnit.SECONDS)
    return service
  }

  private fun unbind() {
    val bound = connection ?: return
    connection = null
    service = null
    try {
      context.unbindService(bound)
    } catch (_: Exception) {
      // Already unbound, or the app is going away.
    }
  }

  private companion object {
    const val FOLDER = "documents"
    const val PAGES = "pages"
    /** The longest the renderer's process may take to start. */
    const val START_SECONDS = 10L
  }
}
