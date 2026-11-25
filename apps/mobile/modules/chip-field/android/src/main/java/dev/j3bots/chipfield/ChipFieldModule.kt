// SPDX-License-Identifier: AGPL-3.0-or-later
package dev.j3bots.chipfield

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * The field's text, with a mark (U+FFFC) where each chip stands, the chips'
 * keys in order, and the runs of it drawn as mentions.
 */
class FieldValue : Record {
  @Field val text: String = ""
  @Field val keys: List<String> = emptyList()
  @Field val mentions: List<MentionLook> = emptyList()
  /** The last change of the field the text answers; an older one is not shown over a newer edit. */
  @Field val eventCount: Int = 0
}

/** A picked mention, drawn as a chip over `[start, end)` of the text while that reads `text`. */
class MentionLook : Record {
  @Field val start: Int = 0
  @Field val end: Int = 0
  @Field val text: String = ""
  /** The bot's still face, a PNG in base64. */
  @Field val face: String = ""
  /** A tint of the bot's color, the chip's fill. */
  @Field val fill: Double = 0.0
}

/** What one chip shows. */
class ChipLook : Record {
  @Field val key: String = ""
  @Field val label: String = ""
  /** A local file of the chip's image, or none: the chip then shows a page. */
  @Field val image: String? = null
  /** "uploading", "ready" or "failed". */
  @Field val state: String = "ready"
  @Field val removable: Boolean = true
}

/** The field's look, from the app's theme. Colors are Android's ARGB, sizes are dp or sp. */
class FieldLook : Record {
  @Field val textColor: Double = 0.0
  @Field val mutedColor: Double = 0.0
  @Field val chipBackground: Double = 0.0
  @Field val chipBorder: Double = 0.0
  @Field val failedBackground: Double = 0.0
  @Field val failedText: Double = 0.0
  /** A mention's text, over its tint. */
  @Field val mentionText: Double = 0.0
  @Field val fontFamily: String = ""
  @Field val fontSize: Double = 18.0
  @Field val paddingHorizontal: Double = 4.0
  @Field val paddingVertical: Double = 10.0
}

/**
 * A multiline field of plain text in which each of a draft's files is a chip
 * where its mark stands, and each picked mention one over its text: React
 * Native's own field cannot hold one.
 */
class ChipFieldModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChipField")

    View(ChipFieldView::class) {
      Events(
        "onChangeText",
        "onSelectionChange",
        "onFocusChange",
        "onContentHeight",
        "onChipPress",
        "onChipRemove",
      )
      Prop("value") { view: ChipFieldView, value: FieldValue -> view.pendingValue = value }
      Prop("chips") { view: ChipFieldView, chips: List<ChipLook> -> view.pendingChips = chips }
      Prop("look") { view: ChipFieldView, look: FieldLook -> view.pendingLook = look }
      Prop("placeholder") { view: ChipFieldView, placeholder: String -> view.placeholder = placeholder }
      Prop("status") { view: ChipFieldView, status: String? -> view.status = status }
      Prop("statusNote") { view: ChipFieldView, note: String? -> view.statusNote = note }
      Prop("editable") { view: ChipFieldView, editable: Boolean -> view.editable = editable }
      Prop("label") { view: ChipFieldView, label: String? -> view.label = label }
      OnViewDidUpdateProps { view: ChipFieldView -> view.applyProps() }

      AsyncFunction("focus") { view: ChipFieldView -> view.focusField() }
      AsyncFunction("blur") { view: ChipFieldView -> view.blurField() }
      AsyncFunction("select") { view: ChipFieldView, start: Int, end: Int -> view.select(start, end) }
    }
  }
}
