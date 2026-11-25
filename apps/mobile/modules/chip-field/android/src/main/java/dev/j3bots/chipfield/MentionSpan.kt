// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.chipfield

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import android.text.style.ReplacementSpan
import kotlin.math.roundToInt

/** What a mention's chip draws with, as the field knows it now. */
internal interface MentionSource {
  /** The face a mention shows, from its PNG in base64; null while it cannot be read. */
  fun faceOf(face: String): Bitmap?
  val fieldLook: FieldLook
  val density: Float
}

/**
 * A picked mention, drawn over its text as a chip: the bot's still face and
 * the text, `@` and the name, in the field's mention color on a tint of the
 * bot's color (`fill`). The text stays the field's own, edited a character at
 * a time; once it no longer reads `token`, the field takes the chip away.
 */
internal class MentionSpan(
  val token: String,
  val face: String,
  val fill: Int,
  private val source: MentionSource,
) : ReplacementSpan() {
  private val dp get() = source.density
  private fun height(paint: Paint) = paint.textSize * 1.3f
  private fun faceSize() = MENTION_FACE * dp

  private fun labelPaint(paint: Paint) =
    TextPaint(paint).apply {
      textSize = paint.textSize * 0.9f
      typeface = Typeface.create(paint.typeface, Typeface.BOLD)
      isFakeBoldText = false
    }

  private fun shown(text: CharSequence?, start: Int, end: Int): String =
    text?.subSequence(start, end)?.toString() ?: token

  private fun width(paint: Paint, label: String): Float =
    3 * dp + faceSize() + 4 * dp + labelPaint(paint).measureText(label) + 8 * dp

  override fun getSize(
    paint: Paint,
    text: CharSequence?,
    start: Int,
    end: Int,
    fm: Paint.FontMetricsInt?,
  ): Int {
    if (fm != null) {
      // Room for the chip on its line, centered on the text around it.
      val metrics = paint.fontMetricsInt
      val h = height(paint)
      val center = (metrics.ascent + metrics.descent) / 2f
      fm.ascent = minOf(metrics.ascent, (center - h / 2 - dp).roundToInt())
      fm.descent = maxOf(metrics.descent, (center + h / 2 + dp).roundToInt())
      fm.top = minOf(metrics.top, fm.ascent)
      fm.bottom = maxOf(metrics.bottom, fm.descent)
    }
    return (width(paint, shown(text, start, end)) + 2 * dp).roundToInt()
  }

  override fun draw(
    canvas: Canvas,
    text: CharSequence?,
    start: Int,
    end: Int,
    x: Float,
    top: Int,
    y: Int,
    bottom: Int,
    paint: Paint,
  ) {
    val label = shown(text, start, end)
    val h = height(paint)
    val w = width(paint, label)
    val center = y + (paint.fontMetrics.ascent + paint.fontMetrics.descent) / 2f
    val left = x + dp
    val pill = RectF(left, center - h / 2, left + w, center + h / 2)
    val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = fill
      style = Paint.Style.FILL
    }
    canvas.drawRoundRect(pill, h / 2, h / 2, fillPaint)

    val size = faceSize()
    val box = RectF(left + 3 * dp, center - size / 2, left + 3 * dp + size, center + size / 2)
    source.faceOf(face)?.let { bitmap ->
      canvas.drawBitmap(bitmap, null, box, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
    }

    val labelPaint = labelPaint(paint).apply { color = argb(source.fieldLook.mentionText) }
    canvas.drawText(
      label,
      box.right + 4 * dp,
      center - (labelPaint.ascent() + labelPaint.descent()) / 2,
      labelPaint,
    )
  }

  private companion object {
    /** The face's side in dp, as a mention's in a message's text. */
    const val MENTION_FACE = 16f
  }
}
