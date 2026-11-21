// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DraftMention } from "@j3-bots/client-runtime";
import {
  type DraggedText,
  type FieldEdit,
  followFieldEdit,
} from "@j3-bots/client-runtime/presentation";

/** An edit of a text field, as its `input` event tells it. */
export interface FieldInput {
  /** The text before the edit: what the composer holds. */
  readonly before: string;
  /** The field's text after it. */
  readonly after: string;
  /** The event's `inputType`, when it has one. */
  readonly inputType: string | null;
  /** The event's `data`: the text typed or pasted, when the browser tells it. */
  readonly data: string | null;
  /** The field's selection as the operator last left it, before the edit. */
  readonly selection: readonly [number, number] | null;
  /** The field's selection after the edit. */
  readonly now: readonly [number, number];
}

/**
 * What a browser's `input` event tells, as the edit the runtime follows, or
 * null when there is nothing left to follow. Only an edit that inserts text
 * writes over the selection the operator left. A move within the field comes
 * as two edits, the text taken out and then dropped in: Chromium tells each as
 * it is made; WebKit tells both once the whole move is made, so its second
 * edit finds the text as it already is. Text dragged out of the field is
 * `dragged` until the drag ends.
 */
function fieldEdit(input: FieldInput, dragged: DraggedText | null): FieldEdit | null {
  const { before, after, inputType, data, selection, now } = input;
  const [, end] = now;
  if (dragged !== null && (inputType === "deleteByDrag" || inputType === "insertFromDrop")) {
    if (inputType === "insertFromDrop" && after === before) return null;
    return { _tag: "move", before, after, end, dragged };
  }
  if (inputType === "insertFromDrop") return { _tag: "drop", before, after, end };
  return {
    _tag: "change",
    before,
    after,
    over: inputType?.startsWith("insert") === true ? selection : null,
    written: data,
    caret: now[0] === now[1] ? now[1] : null,
  };
}

/** The mentions that still stand after the field's `input` event told `input`. */
export function followFieldInput(
  input: FieldInput,
  mentions: ReadonlyArray<DraftMention>,
  dragged: DraggedText | null,
): ReadonlyArray<DraftMention> {
  const edit = fieldEdit(input, dragged);
  return edit === null ? mentions : followFieldEdit(edit, mentions);
}
