// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.homewidget

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * What the widgets show, as the app last wrote it, and what each widget was
 * set up to show. Kept in the app's own storage: the snapshot in its
 * preferences, the faces as PNG files in a folder of its own.
 *
 * The snapshot is the JSON the app builds (src/widget/snapshot.ts): its
 * language, its words, whether the phone is paired, and, for each bot and
 * routine a widget shows, what to draw or that it is gone. Only what a widget
 * shows is ever written.
 */
internal class WidgetStore(private val context: Context) {
  private val preferences: SharedPreferences =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  private val faces: File
    get() = File(context.filesDir, FACES)

  /** The snapshot, or null before the app first wrote one. */
  fun snapshot(): JSONObject? = parse(preferences.getString(SNAPSHOT, null))

  /**
   * Keeps `snapshot`, and `drawn`, the faces of its bots: for each bot id,
   * each face's name (`now-light`, `quiet-dark`…) to a PNG in base64. Faces of
   * bots no longer given go.
   */
  fun write(snapshot: JSONObject, drawn: JSONObject) {
    val folder = faces
    folder.mkdirs()
    val kept = mutableSetOf<String>()
    for (botId in drawn.keys()) {
      val bot = drawn.getJSONObject(botId)
      for (face in bot.keys()) {
        val file = faceFile(botId, face)
        file.writeBytes(Base64.decode(bot.getString(face), Base64.DEFAULT))
        kept.add(file.name)
      }
    }
    folder.listFiles()?.forEach { if (it.name !in kept) it.delete() }
    preferences.edit().putString(SNAPSHOT, snapshot.toString()).apply()
  }

  /** A bot's face as drawn, `face` naming which, or null when there is none. */
  fun face(botId: String, face: String): Bitmap? {
    val file = faceFile(botId, face)
    return if (file.isFile) BitmapFactory.decodeFile(file.path) else null
  }

  /** What widget `id` was set up to show: `{ kind, botId }` or `{ kind, routineId, botId }`. */
  fun target(id: Int): JSONObject? = parse(preferences.getString(targetKey(id), null))

  fun setTarget(id: Int, target: JSONObject) {
    preferences.edit().putString(targetKey(id), target.toString()).apply()
  }

  fun forget(id: Int) {
    preferences.edit().remove(targetKey(id)).apply()
  }

  /** Forgets every widget's target but those of `ids`, the widgets still on a home screen. */
  fun keepOnly(ids: Set<Int>) {
    val editor = preferences.edit()
    for (key in preferences.all.keys) {
      val id = key.removePrefix(TARGET).toIntOrNull()
      if (key.startsWith(TARGET) && (id == null || id !in ids)) editor.remove(key)
    }
    editor.apply()
  }

  /** A bot's face file, named from its id so no id names a path. */
  private fun faceFile(botId: String, face: String): File {
    val name = UUID.nameUUIDFromBytes("$botId\u0000$face".toByteArray()).toString()
    return File(faces, "$name.png")
  }

  private fun parse(json: String?): JSONObject? =
    try {
      json?.let { JSONObject(it) }
    } catch (error: JSONException) {
      null
    }

  private fun targetKey(id: Int) = "$TARGET$id"

  private companion object {
    const val PREFERENCES = "dev.j3bots.homewidget"
    const val SNAPSHOT = "snapshot"
    const val TARGET = "widget."
    const val FACES = "widget-faces"
  }
}
