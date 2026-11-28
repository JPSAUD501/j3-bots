// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DesktopBrowserCommand, DesktopBrowserTab } from "@j3-bots/desktop-bridge";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/context";
import type { DesktopBrowserBridge } from "../../live/desktop";
import { useFoundIn } from "./state";

/**
 * Finding in the page: the word, which match of how many, the one before
 * and after, and closing. Enter goes to the next, Escape closes. It sits at
 * the top of the page's area, in its strip, which the page leaves for it.
 */
export function FindBar({
  bridge,
  tab,
  command,
  onClose,
}: {
  readonly bridge: DesktopBrowserBridge;
  readonly tab: DesktopBrowserTab;
  readonly command: (command: DesktopBrowserCommand) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const found = useFoundIn(bridge, tab.ref);
  const find = (forward: boolean, looking = text) => {
    if (looking !== "") command({ _tag: "find", tab: tab.ref, text: looking, forward });
  };
  const close = () => {
    command({ _tag: "stopFinding", tab: tab.ref });
    onClose();
  };
  const control =
    "pressable-round inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 [&_svg]:size-4";
  return (
    <div className="flex h-11 shrink-0 items-center justify-end px-2">
      <div className="flex h-9 items-center gap-1 rounded-full border border-border bg-surface ps-3 pe-1 shadow-raised">
        <input
          autoFocus
          aria-label={t("desktopBrowser.find")}
          placeholder={t("desktopBrowser.find")}
          value={text}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setText(next);
            if (next === "") command({ _tag: "stopFinding", tab: tab.ref });
            else find(true, next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              find(!event.shiftKey);
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          className="w-40 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {text !== "" && found !== null && (
          <span className="px-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {found.matches === 0
              ? t("desktopBrowser.find.none")
              : t("desktopBrowser.find.count", {
                  active: String(found.active),
                  matches: String(found.matches),
                })}
          </span>
        )}
        <button
          type="button"
          className={control}
          aria-label={t("desktopBrowser.find.previous")}
          disabled={text === ""}
          onClick={() => find(false)}
        >
          <ChevronUpIcon />
        </button>
        <button
          type="button"
          className={control}
          aria-label={t("desktopBrowser.find.next")}
          disabled={text === ""}
          onClick={() => find(true)}
        >
          <ChevronDownIcon />
        </button>
        <button
          type="button"
          className={control}
          aria-label={t("desktopBrowser.find.close")}
          onClick={close}
        >
          <XIcon />
        </button>
      </div>
    </div>
  );
}
