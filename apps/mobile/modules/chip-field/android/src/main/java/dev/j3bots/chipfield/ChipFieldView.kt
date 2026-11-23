// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.chipfield

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.TextUtils
import android.text.TextWatcher
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.util.LruCache
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import com.facebook.react.common.assets.ReactFontManager
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

private const val MARK = '￼'

/** Decodes chip images away from the main thread: one at a time, as they are few and small. */
private val decoder = Executors.newSingleThreadExecutor()

/**
 * The field. Its text is the draft's, each file's mark covered by the file's
 * chip; the operator edits it as any Android text, and a chip deletes as the
 * one character it stands on. It tells each edit with the whole text, the
 * chips' order and an event count; a value from React that answers an older
 * edit than the field has made is not shown over it. A status, as dictation's
 * "Listening…", is drawn where the text goes, after what the field holds, and
 * never changes its height.
 */
@SuppressLint("ViewConstructor")
class ChipFieldView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), ChipSource {

  override val shouldUseAndroidLayout = true

  private val onChangeText by EventDispatcher()
  private val onSelectionChange by EventDispatcher()
  private val onFocusChange by EventDispatcher()
  private val onContentHeight by EventDispatcher()
  private val onChipPress by EventDispatcher()
  private val onChipRemove by EventDispatcher()

  var pendingValue: FieldValue? = null
  var pendingChips: List<ChipLook>? = null
  var pendingLook: FieldLook? = null
  var placeholder: String = ""
  var status: String? = null
  var statusNote: String? = null
  var editable: Boolean = true
  var label: String? = null

  /**
   * A selection asked for in a text the field does not hold yet: React may
   * send a command before the value it answers, so the selection waits for a
   * value long enough to take it. An edit of the operator's drops it.
   */
  private var waitingSelection: Pair<Int, Int>? = null

  override var fieldLook = FieldLook()
    private set
  override val density: Float = resources.displayMetrics.density
  private var chips: Map<String, ChipLook> = emptyMap()
  private val images = LruCache<String, Bitmap>(24)
  private val loading = mutableSetOf<String>()
  private val main = Handler(Looper.getMainLooper())

  /** The edits the field has told, so a value answering an older one is set aside. */
  private var eventCount = 0
  /** The field's text is being set from React: that is no edit of the operator's. */
  private var applying = false
  private var lastHeight = -1

  private val field = object : EditText(context) {
    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
      super.onSelectionChanged(selStart, selEnd)
      if (!applying && isAttachedToWindow) {
        onSelectionChange(mapOf("start" to selStart, "end" to selEnd))
      }
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      drawStatus(this, canvas)
    }

    private var downX = 0f
    private var downY = 0f
    private var downChip: ChipSpan? = null

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.x
          downY = event.y
          downChip = chipAt(this, event.x, event.y)
          if (downChip != null) return true
        }
        MotionEvent.ACTION_UP -> {
          val chip = downChip
          downChip = null
          if (chip != null) {
            val slop = ViewConfiguration.get(context).scaledTouchSlop
            if (abs(event.x - downX) < slop && abs(event.y - downY) < slop) {
              val (x, y) = textPoint(this, event.x, event.y)
              val look = chips[chip.key]
              if (look?.removable != false && editable && chip.removeArea.contains(x, y)) {
                onChipRemove(mapOf("key" to chip.key))
              } else {
                onChipPress(mapOf("key" to chip.key))
              }
            }
            return true
          }
        }
        MotionEvent.ACTION_CANCEL -> downChip = null
        MotionEvent.ACTION_MOVE -> if (downChip != null) return true
      }
      return super.onTouchEvent(event)
    }
  }

  init {
    field.background = null
    field.inputType =
      InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
        InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    field.gravity = Gravity.TOP or Gravity.START
    field.isVerticalScrollBarEnabled = true
    field.setHorizontallyScrolling(false)
    field.maxLines = Int.MAX_VALUE
    field.includeFontPadding = false
    field.setOnFocusChangeListener { _, focused -> onFocusChange(mapOf("focused" to focused)) }
    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(text: Editable) {
        if (applying) return
        waitingSelection = null
        tidy(text)
        eventCount += 1
        val (shown, keys) = read(text)
        onChangeText(
          mapOf(
            "text" to shown,
            "keys" to keys,
            "start" to field.selectionStart,
            "end" to field.selectionEnd,
            "eventCount" to eventCount,
          ),
        )
        reportHeight()
      }
    })
    addView(field, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun lookOf(key: String): ChipLook? = chips[key]

  override fun imageOf(look: ChipLook): Bitmap? {
    val path = look.image ?: return null
    images.get(path)?.let { return it }
    if (loading.add(path)) {
      val size = (field.textSize * 2).roundToInt()
      decoder.execute {
        val bitmap = decodeThumbnail(path.removePrefix("file://"), size)
        main.post {
          loading.remove(path)
          if (bitmap != null) {
            images.put(path, bitmap)
            // The editor keeps each block of text it drew; only a change to
            // the chips' spans makes it draw them again.
            relayoutChips()
          }
        }
      }
    }
    return null
  }

  /**
   * Takes out what the operator's edit left that no chip covers: a mark typed
   * or pasted, which is no file's, and a chip whose mark was deleted.
   */
  private fun tidy(text: Editable) {
    applying = true
    try {
      for (span in text.getSpans(0, text.length, ChipSpan::class.java)) {
        val start = text.getSpanStart(span)
        val end = text.getSpanEnd(span)
        if (end - start != 1 || text[start] != MARK) text.removeSpan(span)
      }
      var index = text.length - 1
      while (index >= 0) {
        if (text[index] == MARK && text.getSpans(index, index + 1, ChipSpan::class.java).isEmpty()) {
          text.delete(index, index + 1)
        }
        index -= 1
      }
    } finally {
      applying = false
    }
  }

  /** The text as React holds it, each chip as its mark, and the chips' keys in order. */
  private fun read(text: Spanned): Pair<String, List<String>> {
    val spans = text.getSpans(0, text.length, ChipSpan::class.java)
      .sortedBy { text.getSpanStart(it) }
    return text.toString() to spans.map { it.key }
  }

  fun applyProps() {
    pendingLook?.let {
      fieldLook = it
      pendingLook = null
      applyLook(it)
    }
    pendingChips?.let { list ->
      chips = list.associateBy { it.key }
      pendingChips = null
      relayoutChips()
    }
    pendingValue?.let { value ->
      pendingValue = null
      if (value.eventCount >= eventCount) show(value)
    }
    field.isFocusable = true
    field.isFocusableInTouchMode = true
    field.showSoftInputOnFocus = editable
    field.isCursorVisible = editable
    field.keyListener = if (editable) editKeys else null
    field.contentDescription = label
    field.hint = if (status == null) placeholder else null
    field.invalidate()
    reportHeight()
  }

  private val editKeys = field.keyListener

  private fun applyLook(look: FieldLook) {
    field.setTextColor(argb(look.textColor))
    field.setHintTextColor(argb(look.mutedColor))
    field.setTextSize(TypedValue.COMPLEX_UNIT_SP, look.fontSize.toFloat())
    if (look.fontFamily.isNotEmpty()) {
      field.typeface =
        ReactFontManager.getInstance().getTypeface(look.fontFamily, Typeface.NORMAL, context.assets)
    }
    val h = (look.paddingHorizontal * density).roundToInt()
    val v = (look.paddingVertical * density).roundToInt()
    field.setPadding(h, v, h, v)
  }

  /** Has the text lay its chips out again, as their looks may have changed their widths. */
  private fun relayoutChips() {
    val text = field.text ?: return
    applying = true
    try {
      for (span in text.getSpans(0, text.length, ChipSpan::class.java)) {
        val start = text.getSpanStart(span)
        val end = text.getSpanEnd(span)
        text.removeSpan(span)
        text.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
    } finally {
      applying = false
    }
  }

  /** Shows `value`, unless the field already holds it. */
  private fun show(value: FieldValue) {
    val current = field.text ?: return
    val (text, keys) = read(current)
    if (text == value.text && keys == value.keys) return
    val waiting = waitingSelection?.takeIf { (from, to) -> maxOf(from, to) <= value.text.length }
    if (waiting != null) waitingSelection = null
    val start = waiting?.first ?: field.selectionStart
    val end = waiting?.second ?: field.selectionEnd
    val next = SpannableStringBuilder(value.text)
    var chip = 0
    for (index in value.text.indices) {
      if (value.text[index] != MARK) continue
      val key = value.keys.getOrNull(chip) ?: break
      chip += 1
      next.setSpan(ChipSpan(key, this), index, index + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    applying = true
    try {
      field.setText(next)
      val length = next.length
      field.setSelection(start.coerceIn(0, length), end.coerceIn(0, length))
    } finally {
      applying = false
    }
  }

  fun focusField() {
    field.requestFocus()
    if (editable) {
      val keyboard = context.getSystemService(InputMethodManager::class.java)
      keyboard?.showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
    }
  }

  fun blurField() {
    field.clearFocus()
    val keyboard = context.getSystemService(InputMethodManager::class.java)
    keyboard?.hideSoftInputFromWindow(field.windowToken, 0)
  }

  fun select(start: Int, end: Int) {
    val length = field.text?.length ?: 0
    waitingSelection = if (maxOf(start, end) > length) start to end else null
    field.setSelection(start.coerceIn(0, length), end.coerceIn(0, length))
  }

  /** Tells React how tall the text is, in dp, so the field grows with it. */
  private fun reportHeight() {
    val width = field.width
    if (width <= 0) {
      post { if (field.width > 0) reportHeight() }
      return
    }
    field.measure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
    )
    val height = field.layout?.height?.let { it + field.paddingTop + field.paddingBottom }
      ?: field.measuredHeight
    if (height != lastHeight) {
      lastHeight = height
      onContentHeight(mapOf("height" to height / density))
    }
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w != oldw) post { reportHeight() }
  }

  /** The point of a touch in the text's own coordinates, where chips keep where they were drawn. */
  private fun textPoint(view: EditText, x: Float, y: Float): Pair<Float, Float> =
    (x - view.totalPaddingLeft + view.scrollX) to (y - view.totalPaddingTop + view.scrollY)

  private fun chipAt(view: EditText, x: Float, y: Float): ChipSpan? {
    val text = view.text ?: return null
    val (tx, ty) = textPoint(view, x, y)
    return text.getSpans(0, text.length, ChipSpan::class.java).firstOrNull { span ->
      span.drawn.contains(tx, ty)
    }
  }

  /**
   * The status where the text goes: alone, it stands where the placeholder
   * would; after text or chips, it follows them on their last line, as far as
   * it fits there. Its note follows it, quieter and smaller.
   */
  private fun drawStatus(view: EditText, canvas: Canvas) {
    val primary = status ?: return
    val layout = view.layout ?: return
    val text = view.text ?: return
    val last = max(layout.lineCount - 1, 0)
    val empty = text.isEmpty()
    val startX = if (empty) 0f else layout.getLineRight(last) + 6 * density
    val room = layout.width - startX
    if (room < 32 * density) return
    val line = SpannableStringBuilder(primary)
    statusNote?.let { note ->
      val from = line.length
      line.append("  ").append(note)
      line.setSpan(
        AbsoluteSizeSpan((view.textSize * 0.72f).roundToInt()),
        from,
        line.length,
        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
      )
      line.setSpan(
        ForegroundColorSpan(withAlpha(argb(fieldLook.mutedColor), 190)),
        from,
        line.length,
        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
      )
    }
    val paint = TextPaint(view.paint).apply { color = argb(fieldLook.mutedColor) }
    val shown = TextUtils.ellipsize(line, paint, room, TextUtils.TruncateAt.END)
    val baseline = layout.getLineBaseline(last).toFloat()
    canvas.save()
    canvas.translate(
      view.totalPaddingLeft.toFloat() - view.scrollX + startX,
      view.totalPaddingTop.toFloat() - view.scrollY,
    )
    val drawn = android.text.StaticLayout.Builder
      .obtain(shown, 0, shown.length, paint, room.roundToInt())
      .setMaxLines(1)
      .setIncludePad(false)
      .build()
    canvas.translate(0f, baseline - drawn.getLineBaseline(0))
    drawn.draw(canvas)
    canvas.restore()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    main.removeCallbacksAndMessages(null)
  }
}

private fun withAlpha(color: Int, alpha: Int): Int = (color and 0x00FFFFFF) or (alpha shl 24)

/** `path`'s image, decoded at about `size` pixels on its shorter side; null when it cannot be read. */
private fun decodeThumbnail(path: String, size: Int): Bitmap? {
  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  BitmapFactory.decodeFile(path, bounds)
  if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
  var sample = 1
  while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= size) sample *= 2
  return BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
}
