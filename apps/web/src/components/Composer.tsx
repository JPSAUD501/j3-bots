// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowUpIcon, MicIcon, PlusIcon } from "lucide-react";
import type { Ref } from "react";
import { useI18n } from "../app/context";
import { Button } from "./ui/button";

interface ComposerProps {
  /** Who the message goes to: a bot's or a room's name. */
  readonly recipient: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onAttach: () => void;
  readonly onDictate: () => void;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
}

/**
 * The pill at the bottom of a conversation. Enter sends, Shift+Enter starts a
 * new line. With nothing typed, the trailing button dictates; with text, it sends.
 */
export function Composer({
  recipient,
  value,
  onValueChange,
  onSend,
  onAttach,
  onDictate,
  inputRef,
}: ComposerProps) {
  const { t } = useI18n();
  const label = t("composer.label", { name: recipient });
  const empty = value.trim() === "";
  return (
    <form
      className="flex items-end gap-1 rounded-[1.25rem] border border-input bg-surface p-1 shadow-xs focus-within:border-foreground/30"
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty) onSend();
      }}
    >
      <Button
        variant="ghost-muted"
        size="icon-pill"
        onClick={onAttach}
        aria-label={t("composer.attach")}
      >
        <PlusIcon />
      </Button>
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!empty) onSend();
          }
        }}
        placeholder={label}
        aria-label={label}
        data-composer=""
        className="field-sizing-content max-h-[40vh] min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground pointer-coarse:text-lg"
      />
      {empty ? (
        <Button
          variant="ghost-muted"
          size="icon-pill"
          onClick={onDictate}
          aria-label={t("composer.dictate")}
        >
          <MicIcon />
        </Button>
      ) : (
        <Button type="submit" variant="primary" size="icon-pill" aria-label={t("composer.send")}>
          <ArrowUpIcon />
        </Button>
      )}
    </form>
  );
}
