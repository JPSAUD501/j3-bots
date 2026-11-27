// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.sharesheet

import android.content.ClipData
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.IntentCompat
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID

/**
 * One share's files, copied into a folder of the app's cache of their own.
 *
 * A file is taken only through a `content:` URI the sending app granted the
 * share sheet, read once, and copied: the app never keeps the URI or reads a
 * path another app names. A `file:` URI, which would name one, is refused,
 * and so is a URI of one of the app's own providers, which another app could
 * otherwise use to have the app send its own files. Only as many files as
 * one message takes are copied; the rest are counted. A copy stops one byte
 * past `limit`, the largest file the server takes, so a file over it is said
 * to be too large without being read whole, and that copy is deleted at once:
 * what the share holds on the phone is at most what one message can carry.
 * The folder goes when the sheet closes (ShareActivity), and a folder an
 * ended process left behind goes with the next share (`sweep`).
 */
internal class ShareIntake private constructor(private val folder: File) {
  fun delete() {
    folder.deleteRecursively()
    synchronized(live) { live.remove(folder.name) }
  }

  /** The share `intent` carries, for the JavaScript side (src/share/native.ts). */
  fun read(context: Context, intent: Intent, limit: Long, most: Int): Map<String, Any?> {
    var unreadable = 0
    val streams = streamsOf(intent)
    val files =
      streams.take(most).mapIndexedNotNull { index, uri ->
        val copy = copy(context, uri, intent.type, index, limit)
        if (copy == null) unreadable += 1
        copy
      }
    return mapOf(
      "text" to textOf(intent),
      "title" to
        (intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)
            ?: intent.getCharSequenceExtra(Intent.EXTRA_TITLE))
          ?.toString(),
      "botId" to ShareShortcuts.botOf(intent.getStringExtra(EXTRA_SHORTCUT_ID)),
      "files" to files,
      "unreadable" to unreadable,
      "beyond" to (streams.size - most).coerceAtLeast(0),
    )
  }

  private fun textOf(intent: Intent): String? {
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      val texts = intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)
      if (texts != null) return texts.joinToString("\n\n").ifEmpty { null }
    }
    return intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
  }

  /** The files the share names: its streams, or, when it names none, its clip's URIs. */
  private fun streamsOf(intent: Intent): List<Uri> {
    val streams =
      when (intent.action) {
        Intent.ACTION_SEND ->
          listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
        Intent.ACTION_SEND_MULTIPLE ->
          IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            ?.filterNotNull()
            .orEmpty()
        else -> emptyList()
      }
    return streams.ifEmpty { clipUris(intent.clipData) }.distinct()
  }

  private fun clipUris(clip: ClipData?): List<Uri> {
    if (clip == null) return emptyList()
    return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
  }

  /** Copies one file, or null when it cannot or must not be read. */
  private fun copy(context: Context, uri: Uri, sharedType: String?, index: Int, limit: Long): Map<String, Any?>? {
    if (uri.scheme != ContentResolver.SCHEME_CONTENT || ownProvider(context, uri)) return null
    val resolver = context.contentResolver
    val name = safeName(displayName(resolver, uri) ?: uri.lastPathSegment)
    // Each file in a folder of its own, so two of the same name both keep it.
    val target = File(File(folder, index.toString()).apply { mkdirs() }, name)
    val size =
      try {
        resolver.openInputStream(uri)?.use { input -> target.outputStream().use { output -> copyAtMost(input, output, limit + 1) } }
      } catch (error: IOException) {
        null
      } catch (error: SecurityException) {
        null
      } catch (error: IllegalArgumentException) {
        null
      }
    if (size == null) {
      target.delete()
      return null
    }
    // Too large to send: only its size is kept, to say so.
    if (size > limit) target.delete()
    val type = resolver.getType(uri) ?: sharedType?.takeUnless { it.contains('*') }
    return mapOf(
      "uri" to Uri.fromFile(target).toString(),
      "name" to name,
      "mediaType" to (type ?: ""),
      "size" to size.toDouble(),
    )
  }

  /**
   * Whether `uri` is one of the app's own providers' (or names none). An
   * authority may carry a user, as `10@authority`, which the resolver drops
   * before it opens the provider, so it is dropped here before the lookup.
   */
  private fun ownProvider(context: Context, uri: Uri): Boolean {
    val authority = uri.authority?.substringAfterLast('@') ?: return true
    return context.packageManager.resolveContentProvider(authority, 0)?.packageName == context.packageName
  }

  private fun displayName(resolver: ContentResolver, uri: Uri): String? =
    try {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (column >= 0 && cursor.moveToFirst()) cursor.getString(column) else null
      }
    } catch (error: RuntimeException) {
      null
    }

  companion object {
    private const val FOLDER = "shares"

    /** The Direct Share shortcut a share came through (`Intent.EXTRA_SHORTCUT_ID`, Android 10 and later). */
    private const val EXTRA_SHORTCUT_ID = "android.intent.extra.shortcut.ID"

    /** The folders of the shares open in this process, which `sweep` leaves. */
    private val live = mutableSetOf<String>()

    private fun root(context: Context) = File(context.cacheDir, FOLDER)

    fun open(context: Context): ShareIntake {
      val name = UUID.randomUUID().toString()
      synchronized(live) { live.add(name) }
      val folder = File(root(context), name)
      folder.mkdirs()
      return ShareIntake(folder)
    }

    /** Deletes the folders of shares no sheet holds, as one whose process ended leaves. */
    fun sweep(context: Context) {
      synchronized(live) {
        root(context).listFiles()?.forEach { if (it.name !in live) it.deleteRecursively() }
      }
    }

    /** The longest name a copy keeps, in characters: well inside what a file system takes. */
    private const val NAME_LENGTH = 120

    /** The longest ending kept as an extension when a name is shortened. */
    private const val EXTENSION_LENGTH = 16

    /**
     * The last part of a name, without what would make it a path or hide it,
     * shortened to `NAME_LENGTH` with its extension kept.
     */
    internal fun safeName(given: String?): String {
      val last = given.orEmpty().substringAfterLast('/').substringAfterLast('\\')
      val clean = last.filter { !it.isISOControl() }.trim().trimStart('.').ifEmpty { "file" }
      if (clean.length <= NAME_LENGTH) return clean
      val dot = clean.lastIndexOf('.')
      val extension = if (dot > 0 && clean.length - dot <= EXTENSION_LENGTH) clean.substring(dot) else ""
      return clean.take(NAME_LENGTH - extension.length) + extension
    }

    /** Copies at most `most` bytes and says how many it copied. */
    internal fun copyAtMost(input: InputStream, output: OutputStream, most: Long): Long {
      val buffer = ByteArray(64 * 1024)
      var copied = 0L
      while (copied < most) {
        val read = input.read(buffer, 0, minOf(buffer.size.toLong(), most - copied).toInt())
        if (read < 0) break
        output.write(buffer, 0, read)
        copied += read
      }
      return copied
    }
  }
}
