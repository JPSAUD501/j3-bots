// SPDX-License-Identifier: AGPL-3.0-or-later
import { FILE_MARK } from "@j3-bots/client-runtime/presentation";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

/*
 * A text field whose text holds files: an editable element whose text is the
 * draft's, each of its files' marks drawn as the file's chip. The browser
 * edits the element as it would any editable text, so typing, the caret,
 * selection, the keyboard's composition and undo are its own; the field reads
 * the element back after each edit. Only a change made elsewhere, as a file
 * attached or a mention picked, draws the element anew.
 *
 * The element holds text, the chips and line breaks. Chips are not editable:
 * the browser moves the caret over one and deletes one as a single character.
 * Each chip is an element the field keeps by its file's key, so its content
 * stays the same element while the text around it changes.
 */

const CHIP = "data-chip";
// Elements a browser may wrap a line in while editing.
const BLOCKS = new Set(["DIV", "P"]);

const chipKey = (node: Node): string | null =>
  node instanceof HTMLElement ? node.getAttribute(CHIP) : null;

/**
 * The last thing in `root` the text ends with. A line break there draws no
 * line of its own, so it is no line of the text: a browser adds one after a
 * text ending in a new line or a chip, so the caret can stand there.
 */
function lastLeaf(root: HTMLElement): Node | null {
  let node = root.lastChild;
  while (node !== null && chipKey(node) === null && node.lastChild !== null) node = node.lastChild;
  return node;
}

interface Reading {
  readonly text: string;
  /** The chips' keys, in the order they stand. */
  readonly keys: ReadonlyArray<string>;
  /** Where each point asked for stands in the text, or null when it is not in the field. */
  readonly at: ReadonlyArray<number | null>;
  /** The element holds the mark as text, as pasted: it is no file's, and is read as nothing. */
  readonly stray: boolean;
}

/** `root`'s text as its marks stand for chips, and where `points` stand in it. */
function read(
  root: HTMLElement,
  points: ReadonlyArray<{ readonly node: Node; readonly offset: number }> = [],
): Reading {
  let text = "";
  const keys: Array<string> = [];
  const at: Array<number | null> = points.map(() => null);
  let stray = false;
  const last = lastLeaf(root);
  const mark = (node: Node, child: number | null) => {
    for (const [index, point] of points.entries()) {
      if (point.node === node && (child === null || point.offset === child))
        at[index] = text.length;
    }
  };
  const visit = (node: Node) => {
    if (node instanceof Text) {
      for (const [index, point] of points.entries()) {
        if (point.node === node) {
          at[index] =
            text.length + node.data.slice(0, point.offset).replaceAll(FILE_MARK, "").length;
        }
      }
      if (node.data.includes(FILE_MARK)) stray = true;
      text += node.data.replaceAll(FILE_MARK, "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const key = chipKey(node);
    if (key !== null) {
      // A point inside a chip stands after it.
      for (const [index, point] of points.entries()) {
        if (node.contains(point.node)) at[index] = text.length + 1;
      }
      text += FILE_MARK;
      keys.push(key);
      return;
    }
    if (node.tagName === "BR") {
      if (node !== last) text += "\n";
      return;
    }
    if (node !== root && BLOCKS.has(node.tagName) && text !== "" && !text.endsWith("\n")) {
      text += "\n";
    }
    for (const [index, child] of node.childNodes.entries()) {
      mark(node, index);
      visit(child);
    }
    mark(node, node.childNodes.length);
  };
  visit(root);
  return { text, keys, at, stray };
}

/** The field's text, each chip as its mark. */
export const fieldText = (element: HTMLElement): string => read(element).text;

/** The field's selection, start first, or null when it is not in the field. */
export function fieldSelection(element: HTMLElement): readonly [number, number] | null {
  const selection = element.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const [start, end] = read(element, [
    { node: range.startContainer, offset: range.startOffset },
    { node: range.endContainer, offset: range.endOffset },
  ]).at;
  return start === null || start === undefined || end === null || end === undefined
    ? null
    : [start, end];
}

/** The point in `root` that stands at `offset` in its text, as the field draws it. */
function pointAt(root: HTMLElement, offset: number): { node: Node; index: number } {
  let length = 0;
  for (const [index, child] of root.childNodes.entries()) {
    if (child instanceof Text) {
      if (length + child.data.length >= offset) return { node: child, index: offset - length };
      length += child.data.length;
    } else if (chipKey(child) !== null) {
      if (length >= offset) return { node: root, index };
      length += 1;
    }
  }
  return { node: root, index: root.childNodes.length };
}

/** Selects from `start` to `end` in the field's text, as the field draws it. */
export function selectInField(element: HTMLElement, start: number, end: number = start) {
  const selection = element.ownerDocument.getSelection();
  if (selection === null) return;
  const from = pointAt(element, start);
  const to = pointAt(element, end);
  selection.setBaseAndExtent(from.node, from.index, to.node, to.index);
}

/** An edit of the field, as its `input` event and the field tell it. */
export interface FieldChange {
  /** The field's text after it, each chip as its mark. */
  readonly text: string;
  /** The chips' keys, in the order they stand after it. */
  readonly order: ReadonlyArray<string>;
  /** The field's selection after it. */
  readonly selection: readonly [number, number];
  readonly inputType: string | null;
  readonly data: string | null;
}

/** A file's chip in the field: its key, and what it shows. */
export interface FieldChip {
  readonly key: string;
  readonly content: ReactNode;
}

type ChipFieldProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "onChange" | "onInput" | "onBeforeInput" | "contentEditable" | "placeholder"
> & {
  readonly ref: RefObject<HTMLDivElement | null>;
  /** The text, with a mark where each chip stands. */
  readonly value: string;
  /** The chips, in the order of their marks. */
  readonly chips: ReadonlyArray<FieldChip>;
  /** The field keeps its focus and caret, and takes no edit. */
  readonly readOnly: boolean;
  /** Shown while the field holds nothing. */
  readonly placeholder: string;
  readonly onChange: (change: FieldChange) => void;
};

/**
 * A field of plain text, with each of a draft's files drawn as a chip where its
 * mark stands. Pasted text arrives as plain text; a new line is the text's own.
 */
export function ChipField({
  ref,
  value,
  chips,
  readOnly,
  placeholder,
  onChange,
  className,
  onPaste,
  onDrop,
  ...rest
}: ChipFieldProps) {
  // Each chip's element, by its file's key, kept while the file is in the draft.
  const [hosts, setHosts] = useState<ReadonlyMap<string, HTMLElement>>(new Map());
  const order = chips.map((chip) => chip.key);
  // Draws the field anew when its text or chips changed elsewhere than in it.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const kept = new Map(
      order.map((key) => {
        const host = hosts.get(key) ?? element.ownerDocument.createElement("span");
        host.setAttribute(CHIP, key);
        host.contentEditable = "false";
        return [key, host] as const;
      }),
    );
    if (kept.size !== hosts.size || order.some((key) => kept.get(key) !== hosts.get(key))) {
      setHosts(kept);
    }
    const shown = read(element);
    if (
      !shown.stray &&
      shown.text === value &&
      shown.keys.length === order.length &&
      shown.keys.every((key, index) => key === order[index])
    ) {
      return;
    }
    const focused = element.ownerDocument.activeElement === element;
    const selection = focused ? fieldSelection(element) : null;
    const nodes: Array<Node> = [];
    for (const [index, part] of value.split(FILE_MARK).entries()) {
      const host = index === 0 ? undefined : kept.get(order[index - 1] ?? "");
      if (host !== undefined) nodes.push(host);
      if (part !== "") nodes.push(element.ownerDocument.createTextNode(part));
    }
    // The caret can then stand on the last line, or after the last chip.
    if (value.endsWith("\n") || value.endsWith(FILE_MARK)) {
      nodes.push(element.ownerDocument.createElement("br"));
    }
    element.replaceChildren(...nodes);
    if (selection !== null) {
      const [start, end] = selection;
      selectInField(element, Math.min(start, value.length), Math.min(end, value.length));
    }
  });

  const follow = (event: FormEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const told = event.nativeEvent instanceof InputEvent ? event.nativeEvent : null;
    const reading = read(element);
    const selection = fieldSelection(element) ?? [reading.text.length, reading.text.length];
    onChange({
      text: reading.text,
      order: reading.keys,
      selection,
      inputType: told?.inputType ?? null,
      data: told?.data ?? null,
    });
  };

  return (
    <div className="relative flex min-w-0 flex-1">
      <div
        ref={ref}
        role="textbox"
        aria-multiline
        aria-readonly={readOnly || undefined}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck
        onBeforeInput={(event) => {
          if (readOnly) event.preventDefault();
        }}
        onInput={follow}
        onPaste={(event: ClipboardEvent<HTMLDivElement>) => {
          onPaste?.(event);
          if (readOnly && !event.defaultPrevented) event.preventDefault();
        }}
        onDrop={(event: DragEvent<HTMLDivElement>) => {
          onDrop?.(event);
          if (readOnly && !event.defaultPrevented) event.preventDefault();
        }}
        {...rest}
        className={cn("whitespace-pre-wrap break-words outline-none", className)}
      />
      {value === "" && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 truncate text-muted-foreground",
            className,
          )}
        >
          {placeholder}
        </span>
      )}
      {chips.map((chip) => {
        const host = hosts.get(chip.key);
        return host === undefined ? null : createPortal(chip.content, host, chip.key);
      })}
    </div>
  );
}

/** Where a drop at (`x`, `y`) lands in the field's text, or null when it lands outside it. */
export function dropOffset(element: HTMLElement, x: number, y: number): number | null {
  const document = element.ownerDocument;
  const position =
    "caretPositionFromPoint" in document ? document.caretPositionFromPoint(x, y) : null;
  if (position === null || !element.contains(position.offsetNode)) return null;
  return read(element, [{ node: position.offsetNode, offset: position.offset }]).at[0] ?? null;
}
