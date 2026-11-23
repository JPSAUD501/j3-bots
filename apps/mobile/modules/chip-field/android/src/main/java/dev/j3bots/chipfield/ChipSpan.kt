// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.chipfield

import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.ReplacementSpan
import kotlin.math.max
import kotlin.math.roundToInt

/** How a chip looks, as the field knows it now: what it shows and the theme's colors. */
internal interface ChipSource {
  fun lookOf(key: String): ChipLook?
  fun imageOf(look: ChipLook): Bitmap?
  val fieldLook: FieldLook
  val density: Float
}

/**
 * A file's chip, drawn over the one mark that stands for it: its image or a
 * page, its name, and a way out. It keeps where it was last drawn, in the
 * text's own coordinates, so a tap can be told to land on it.
 */
internal class ChipSpan(val key: String, private val source: ChipSource) : ReplacementSpan() {
  /** Where the chip was last drawn, and where its way out was. */
  val drawn = RectF()
  val removeArea = RectF()

  private val dp get() = source.density
  private fun height(paint: Paint) = paint.textSize * 1.3f
  private fun labelPaint(paint: Paint) =
    TextPaint(paint).apply {
      textSize = paint.textSize * 0.78f
      isFakeBoldText = false
    }

  private fun label(paint: Paint, look: ChipLook?): CharSequence =
    TextUtils.ellipsize(look?.label ?: "", labelPaint(paint), 150 * dp, TextUtils.TruncateAt.MIDDLE)

  private fun width(paint: Paint, look: ChipLook?): Float {
    val h = height(paint)
    val thumb = h - 6 * dp
    val text = labelPaint(paint).measureText(label(paint, look).toString())
    val remove = if (look?.removable != false) 16 * dp else 0f
    return 3 * dp + thumb + 5 * dp + text + 6 * dp + remove + 2 * dp
  }

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
    return (width(paint, source.lookOf(key)) + 4 * dp).roundToInt()
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
    val look = source.lookOf(key)
    val field = source.fieldLook
    val failed = look?.state == "failed"
    val uploading = look?.state == "uploading"
    val h = height(paint)
    val w = width(paint, look)
    val center = y + (paint.fontMetrics.ascent + paint.fontMetrics.descent) / 2f
    val left = x + 2 * dp
    drawn.set(left, center - h / 2, left + w, center + h / 2)
    val radius = 6 * dp
    val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = argb(if (failed) field.failedBackground else field.chipBackground)
      style = Paint.Style.FILL
    }
    canvas.drawRoundRect(drawn, radius, radius, fill)
    val border = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = argb(if (failed) field.failedText else field.chipBorder)
      // The theme's border may be translucent: a failed chip's is faded further.
      if (failed) alpha = alpha * 2 / 5
      style = Paint.Style.STROKE
      strokeWidth = dp
    }
    canvas.drawRoundRect(drawn, radius, radius, border)

    val ink = argb(if (failed) field.failedText else field.textColor)
    val muted = argb(if (failed) field.failedText else field.mutedColor)
    val thumb = h - 6 * dp
    val box = RectF(left + 3 * dp, center - thumb / 2, left + 3 * dp + thumb, center + thumb / 2)
    val image = look?.let(source::imageOf)
    if (image != null) {
      drawImage(canvas, image, box, 4 * dp, if (uploading) 150 else 255)
    } else {
      drawPage(canvas, box, muted)
    }

    val labelPaint = labelPaint(paint).apply {
      color = ink
      if (uploading) alpha = alpha * 5 / 8
    }
    val shown = label(paint, look).toString()
    val textX = box.right + 5 * dp
    canvas.drawText(shown, textX, center - (labelPaint.ascent() + labelPaint.descent()) / 2, labelPaint)

    if (look?.removable != false) {
      val cx = drawn.right - 2 * dp - 8 * dp
      val arm = 3.5f * dp
      val cross = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = muted
        strokeWidth = 1.5f * dp
        strokeCap = Paint.Cap.ROUND
      }
      canvas.drawLine(cx - arm, center - arm, cx + arm, center + arm, cross)
      canvas.drawLine(cx - arm, center + arm, cx + arm, center - arm, cross)
      removeArea.set(cx - 14 * dp, drawn.top - 6 * dp, drawn.right + 4 * dp, drawn.bottom + 6 * dp)
    } else {
      removeArea.setEmpty()
    }
  }

  /** The image, cropped to fill `box`, with rounded corners. */
  private fun drawImage(canvas: Canvas, image: Bitmap, box: RectF, radius: Float, alpha: Int) {
    val scale = max(box.width() / image.width, box.height() / image.height)
    val matrix = Matrix().apply {
      setScale(scale, scale)
      postTranslate(
        box.left + (box.width() - image.width * scale) / 2,
        box.top + (box.height() - image.height * scale) / 2,
      )
    }
    val shader = BitmapShader(image, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply {
      setLocalMatrix(matrix)
    }
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
      this.shader = shader
      this.alpha = alpha
    }
    canvas.drawRoundRect(box, radius, radius, paint)
  }

  /** A page with a folded corner, for a file with no image. */
  private fun drawPage(canvas: Canvas, box: RectF, color: Int) {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      this.color = color
      style = Paint.Style.STROKE
      strokeWidth = 1.4f * dp
      strokeJoin = Paint.Join.ROUND
    }
    val w = box.width() * 0.62f
    val h = box.height() * 0.78f
    val l = box.centerX() - w / 2
    val t = box.centerY() - h / 2
    val fold = w * 0.38f
    val page = Path().apply {
      moveTo(l, t)
      lineTo(l + w - fold, t)
      lineTo(l + w, t + fold)
      lineTo(l + w, t + h)
      lineTo(l, t + h)
      close()
      moveTo(l + w - fold, t)
      lineTo(l + w - fold, t + fold)
      lineTo(l + w, t + fold)
    }
    canvas.drawPath(page, paint)
  }
}

/** A color React Native's `processColor` gave, as Android's ARGB. */
internal fun argb(value: Double): Int = (value.toLong() and 0xFFFFFFFFL).toInt()
