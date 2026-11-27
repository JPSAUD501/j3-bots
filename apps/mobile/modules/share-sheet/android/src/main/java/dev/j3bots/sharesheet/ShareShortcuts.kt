// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.sharesheet

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray

/**
 * The bots Android's share sheet offers as Direct Share targets: long-lived
 * dynamic shortcuts in the category the app's share target declares
 * (res/xml/share_targets.xml), so a share through one opens the share sheet
 * with that bot picked. Tapped from the launcher, a shortcut opens the bot's
 * conversation through its link.
 */
internal object ShareShortcuts {
  /** The category of res/xml/share_targets.xml. */
  private const val CATEGORY = "dev.j3bots.sharesheet.BOT"

  private const val PREFIX = "bot:"

  /** The bot a Direct Share shortcut's id names, or null for any other id. */
  fun botOf(shortcutId: String?): String? = shortcutId?.takeIf { it.startsWith(PREFIX) }?.removePrefix(PREFIX)

  /**
   * Makes `bots` the shortcuts, in their order, as many as Android takes:
   * each `{ id, name, icon, link }`, its icon a PNG in base64, drawn full
   * bleed for an adaptive icon. Shortcuts of bots no longer given go, from
   * the share sheet and from the conversations Android cached them for.
   */
  fun set(context: Context, bots: JSONArray) {
    val most = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context)
    val shortcuts =
      (0 until minOf(bots.length(), most)).map { rank ->
        val bot = bots.getJSONObject(rank)
        val id = PREFIX + bot.getString("id")
        val name = bot.getString("name")
        val link = Intent(Intent.ACTION_VIEW, Uri.parse(bot.getString("link"))).setPackage(context.packageName)
        val builder =
          ShortcutInfoCompat.Builder(context, id)
            .setShortLabel(name)
            .setLongLived(true)
            .setRank(rank)
            .setCategories(setOf(CATEGORY))
            .setIntent(link)
            .setPerson(Person.Builder().setName(name).setKey(id).setBot(true).build())
        val png = Base64.decode(bot.getString("icon"), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(png, 0, png.size)?.let { builder.setIcon(IconCompat.createWithAdaptiveBitmap(it)) }
        builder.build()
      }
    val kept = shortcuts.map { it.id }.toSet()
    val gone = ShortcutManagerCompat.getDynamicShortcuts(context).map { it.id }.filter { it !in kept }
    if (gone.isNotEmpty()) ShortcutManagerCompat.removeLongLivedShortcuts(context, gone)
    ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts)
  }

  /** Tells Android the operator shared to `botId`, which ranks its shortcut higher. */
  fun used(context: Context, botId: String) {
    ShortcutManagerCompat.reportShortcutUsed(context, PREFIX + botId)
  }
}
