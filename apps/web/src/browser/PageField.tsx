// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserInput } from "@j3-bots/contracts";
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from "react";
import { type KeyLike, keyFrame, LEAVE_PAGE_KEY, textFrames } from "./input";

/**
 * What the text field holds between keys: one character a phone's keyboard
 * can delete, since it sends Backspace on an empty field to nobody.
 */
const SENTINEL = "\u200B";

/**
 * The page's text field, never seen: it holds the focus while the person
 * types into the page, so input methods compose as they would anywhere, and
 * each key and what is typed goes to the page. Shown only while the page
 * can be used. The person's clipboard and files never reach it.
 */
export function PageField({
  ref,
  send,
  label,
  description,
  onLeave,
  onKeyboard,
}: {
  readonly ref: Ref<HTMLTextAreaElement>;
  readonly send: (input: BrowserInput) => void;
  /** What the field is called to assistive technology. */
  readonly label: string;
  readonly description: string;
  /** The person pressed the key that leaves the page. */
  readonly onLeave: () => void;
  /** The field took the focus, which raises a phone's keyboard, or lost it. */
  readonly onKeyboard?: (up: boolean) => void;
}) {
  const keyOf = (event: ReactKeyboardEvent<HTMLTextAreaElement>): KeyLike => ({
    key: event.key,
    code: event.code,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    keyCode: event.keyCode,
    altGraph: event.getModifierState("AltGraph"),
  });
  const onKey = (action: "down" | "up") => (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (
      action === "down" &&
      event.key === LEAVE_PAGE_KEY &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      onLeave();
      return;
    }
    const key = keyFrame(keyOf(event), action);
    if (key === null) return;
    // The page takes the key, the app's own shortcuts and the browser's do not.
    event.preventDefault();
    send(key);
  };
  const typed = (text: string) => {
    for (const frame of textFrames(text.replaceAll(SENTINEL, ""))) send(frame);
  };
  const pressKey = (key: string, code: string, keyCode: number, text?: string) => {
    for (const action of ["down", "up"] as const) {
      send({
        type: "key",
        action,
        key,
        code,
        ...(text !== undefined && action === "down" ? { text } : {}),
        keyCode,
        modifiers: 0,
      });
    }
  };
  const clear = (target: HTMLTextAreaElement) => {
    target.value = SENTINEL;
    target.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };

  return (
    <textarea
      ref={ref}
      data-browser-page=""
      defaultValue={SENTINEL}
      aria-label={label}
      aria-description={description}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      onFocus={() => onKeyboard?.(true)}
      onBlur={() => onKeyboard?.(false)}
      onKeyDown={onKey("down")}
      onKeyUp={onKey("up")}
      onCompositionEnd={(event) => {
        typed(event.data);
        clear(event.currentTarget);
      }}
      onInput={(event) => {
        const { nativeEvent } = event;
        if (!(nativeEvent instanceof InputEvent) || nativeEvent.isComposing) return;
        // A phone's keyboard often types, deletes and breaks lines without a key the page could take.
        switch (nativeEvent.inputType) {
          case "insertText":
          case "insertReplacementText":
            typed(nativeEvent.data ?? event.currentTarget.value);
            break;
          case "deleteContentBackward":
            pressKey("Backspace", "Backspace", 8);
            break;
          case "insertLineBreak":
            pressKey("Enter", "Enter", 13, "\r");
            break;
        }
        clear(event.currentTarget);
      }}
      // The operator's clipboard and files stay theirs: nothing is pasted or dropped into the page.
      onPaste={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()}
      className="pointer-events-none absolute start-0 top-0 size-px resize-none overflow-hidden border-0 p-0 opacity-0"
    />
  );
}
