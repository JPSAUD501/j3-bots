// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.homewidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.icu.text.RelativeDateTimeFormatter
import android.icu.util.ULocale
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject

/**
 * The home-screen widget. Each one shows a bot or a routine, as it was set
 * up (WidgetSetupActivity), drawn from what the app last wrote (WidgetStore):
 * Android asks for it again every 30 minutes, and the app asks whenever it
 * writes. Nothing here reaches the server.
 */
class BotWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    val store = WidgetStore(context)
    for (id in ids) manager.updateAppWidget(id, views(context, store, manager, id))
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    manager.updateAppWidget(id, views(context, WidgetStore(context), manager, id))
  }

  override fun onDeleted(context: Context, ids: IntArray) {
    val store = WidgetStore(context)
    for (id in ids) store.forget(id)
  }

  companion object {
    /** How long the app's word that a bot is working holds: Android's refresh, after which it may have ended unseen. */
    private const val WORKING_HOLDS_MS = 30 * 60 * 1000L

    /** Below this height, in dp, a widget shows its name and its first line only. */
    private const val ROOMY_DP = 110

    /** The widgets on home screens now. */
    fun ids(context: Context): IntArray =
      AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, BotWidgetProvider::class.java))

    /** Draws every widget again, from what the app last wrote. */
    fun redraw(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val store = WidgetStore(context)
      for (id in ids(context)) manager.updateAppWidget(id, views(context, store, manager, id))
    }

    internal fun views(context: Context, store: WidgetStore, manager: AppWidgetManager, id: Int): RemoteViews {
      val snapshot = store.snapshot()
      val words = snapshot?.optJSONObject("words") ?: JSONObject()
      val target = store.target(id) ?: return message(context, words.optString("notSetUp"), null, setUp(context, id))
      // Before the app first wrote anything, the widget names the app and opens it.
      if (snapshot == null) return message(context, null, null, openApp(context, id, null))
      if (!snapshot.optBoolean("paired")) {
        return message(context, words.optString("notPaired"), words.optString("openApp"), openApp(context, id, null))
      }
      val roomy = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT) >= ROOMY_DP
      return when (target.optString("kind")) {
        "bot" -> bot(context, store, snapshot, words, target.optString("botId"), id, roomy)
        "routine" -> routine(context, snapshot, words, target.optString("routineId"), id, roomy)
        else -> message(context, null, null, setUp(context, id))
      }
    }

    private fun bot(
      context: Context,
      store: WidgetStore,
      snapshot: JSONObject,
      words: JSONObject,
      botId: String,
      id: Int,
      roomy: Boolean,
    ): RemoteViews {
      val bot =
        snapshot.optJSONObject("bots")?.optJSONObject(botId)
          ?: return message(context, words.optString("notYet"), words.optString("openApp"), openApp(context, id, null))
      if (bot.optBoolean("gone")) {
        return message(context, words.optString("botGone"), words.optString("pickAnother"), setUp(context, id))
      }
      val stale =
        bot.optString("light") == "working" &&
          System.currentTimeMillis() - bot.optLong("learnedAt") > WORKING_HOLDS_MS
      val light = if (stale) "quiet" else bot.optString("light")
      val face = if (stale) "quiet" else "now"
      val name = bot.optString("name")
      val state = words.optString(light)
      return RemoteViews(context.packageName, R.layout.j3_widget_bot).apply {
        store.face(botId, "$face-light")?.let { setImageViewBitmap(R.id.j3_widget_face_day, it) }
        store.face(botId, "$face-dark")?.let { setImageViewBitmap(R.id.j3_widget_face_night, it) }
        setTextViewText(R.id.j3_widget_name, name)
        setTextViewText(R.id.j3_widget_state, state)
        setViewVisibility(R.id.j3_widget_state, if (roomy) View.VISIBLE else View.GONE)
        setContentDescription(R.id.j3_widget_name, "$name, $state")
        setOnClickPendingIntent(android.R.id.background, openApp(context, id, bot.optString("link")))
      }
    }

    private fun routine(
      context: Context,
      snapshot: JSONObject,
      words: JSONObject,
      routineId: String,
      id: Int,
      roomy: Boolean,
    ): RemoteViews {
      val routine =
        snapshot.optJSONObject("routines")?.optJSONObject(routineId)
          ?: return message(context, words.optString("notYet"), words.optString("openApp"), openApp(context, id, null))
      if (routine.optBoolean("gone")) {
        return message(context, words.optString("routineGone"), words.optString("pickAnother"), setUp(context, id))
      }
      val result = routine.optString("result")
      return RemoteViews(context.packageName, R.layout.j3_widget_routine).apply {
        setTextViewText(R.id.j3_widget_name, routine.optString("name"))
        setTextViewText(R.id.j3_widget_when, whenRan(snapshot.optString("language"), words, routine))
        setTextViewText(R.id.j3_widget_result, result)
        setViewVisibility(R.id.j3_widget_result, if (roomy && result.isNotEmpty()) View.VISIBLE else View.GONE)
        setOnClickPendingIntent(android.R.id.background, openApp(context, id, routine.optString("link")))
      }
    }

    /** When a routine last ran, as "Ran 2 hours ago" in the app's language. */
    private fun whenRan(language: String, words: JSONObject, routine: JSONObject): String {
      if (routine.optBoolean("running")) return words.optString("running")
      if (routine.isNull("lastRunAt")) return words.optString("neverRan")
      val formatter = RelativeDateTimeFormatter.getInstance(ULocale.forLanguageTag(language))
      val minutes = (System.currentTimeMillis() - routine.optLong("lastRunAt")) / 60_000
      val ago =
        when {
          minutes < 1 ->
            formatter.format(RelativeDateTimeFormatter.Direction.PLAIN, RelativeDateTimeFormatter.AbsoluteUnit.NOW)
          minutes < 60 ->
            formatter.format(
              minutes.toDouble(),
              RelativeDateTimeFormatter.Direction.LAST,
              RelativeDateTimeFormatter.RelativeUnit.MINUTES,
            )
          minutes < 24 * 60 ->
            formatter.format(
              (minutes / 60).toDouble(),
              RelativeDateTimeFormatter.Direction.LAST,
              RelativeDateTimeFormatter.RelativeUnit.HOURS,
            )
          else ->
            formatter.format(
              (minutes / (24 * 60)).toDouble(),
              RelativeDateTimeFormatter.Direction.LAST,
              RelativeDateTimeFormatter.RelativeUnit.DAYS,
            )
        }
      return words.optString("ran").replace("{when}", ago)
    }

    private fun message(context: Context, text: String?, action: String?, tap: PendingIntent): RemoteViews =
      RemoteViews(context.packageName, R.layout.j3_widget_message).apply {
        if (!text.isNullOrEmpty()) setTextViewText(R.id.j3_widget_message, text)
        setTextViewText(R.id.j3_widget_action, action.orEmpty())
        setViewVisibility(R.id.j3_widget_action, if (action.isNullOrEmpty()) View.GONE else View.VISIBLE)
        setOnClickPendingIntent(android.R.id.background, tap)
      }

    /** Opens the app, on `link` when one is given. */
    private fun openApp(context: Context, id: Int, link: String?): PendingIntent {
      val intent =
        if (link.isNullOrEmpty()) context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()
        else Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(context.packageName)
      return PendingIntent.getActivity(
        context,
        id,
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    }

    /** Opens the widget's setup, to pick what it shows. */
    private fun setUp(context: Context, id: Int): PendingIntent {
      val intent =
        Intent(context, WidgetSetupActivity::class.java)
          .setAction(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE)
          // A distinct data per widget, so each keeps a pending intent of its own.
          .setData(Uri.parse("j3-widget:$id"))
          .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      return PendingIntent.getActivity(
        context,
        id,
        intent,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    }
  }
}
