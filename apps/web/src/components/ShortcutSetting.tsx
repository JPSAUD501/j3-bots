// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Accelerator, DEFAULT_SHORTCUT } from "@j3-bots/desktop-bridge";
import { type KeyboardEvent, useId, useState } from "react";
import { useI18n } from "../app/context";
import { pressedShortcut, shortcutLabel } from "../lib/accelerator";
import type { DesktopShortcut } from "../shell/data";
import { isMac } from "../shell/shortcuts";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

/** What the last change, or the last key pressed while choosing, ended in. */
type Outcome =
  | { readonly _tag: "refused"; readonly accelerator: Accelerator }
  | { readonly _tag: "notSaved" }
  | { readonly _tag: "needsModifier" };

/**
 * The desktop app's global shortcut: what it is, whether it works on this
 * desktop, and a way to choose another by pressing it. A shortcut the system
 * or another app holds is never taken in place of one that works.
 */
export function ShortcutSetting({ shortcut }: { shortcut: DesktopShortcut }) {
  const { t } = useI18n();
  const mac = isMac();
  const labelId = useId();
  const [recording, setRecording] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [changing, setChanging] = useState(false);
  const { accelerator, state } = shortcut.status;
  const current = shortcutLabel(accelerator, mac);

  const change = (next: Accelerator) => {
    setRecording(false);
    setChanging(true);
    void shortcut.change(next).then((result) => {
      setChanging(false);
      if (result === null || result.outcome === "not-saved") setOutcome({ _tag: "notSaved" });
      else if (result.outcome === "taken") setOutcome({ _tag: "refused", accelerator: next });
      else setOutcome(null);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Tab") return;
    // The keys pressed here are the shortcut's: neither the shell nor the dialog acts on them.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      setRecording(false);
      return;
    }
    const pressed = pressedShortcut(event, mac);
    if (pressed._tag === "shortcut") change(pressed.accelerator);
    else if (pressed._tag === "refused") setOutcome({ _tag: "needsModifier" });
  };

  const line = (() => {
    if (recording) {
      return outcome?._tag === "needsModifier"
        ? t("settings.shortcut.needsModifier")
        : t("settings.shortcut.recording", { shortcut: current });
    }
    if (outcome?._tag === "refused") {
      return t("settings.shortcut.refused", {
        refused: shortcutLabel(outcome.accelerator, mac),
        shortcut: current,
      });
    }
    if (outcome?._tag === "notSaved") return t("settings.shortcut.notSaved", { shortcut: current });
    return t(`settings.shortcut.${state}`, { shortcut: current });
  })();

  return (
    <div className="flex flex-col gap-1.5">
      <p id={labelId} className="text-xs">
        {t("settings.shortcut")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Kbd aria-labelledby={labelId} className="h-7 px-2 text-sm text-foreground">
          {current}
        </Kbd>
        <Button
          size="sm"
          aria-pressed={recording}
          aria-disabled={changing || undefined}
          onClick={() => {
            if (changing) return;
            setOutcome(null);
            setRecording((on) => !on);
          }}
          onKeyDown={recording ? onKeyDown : undefined}
          onBlur={() => setRecording(false)}
        >
          {t("settings.shortcut.change")}
        </Button>
        {accelerator !== DEFAULT_SHORTCUT && !recording && (
          <Button
            size="sm"
            variant="ghost"
            aria-disabled={changing || undefined}
            onClick={() => {
              if (!changing) change(DEFAULT_SHORTCUT);
            }}
          >
            {t("settings.shortcut.reset", { shortcut: shortcutLabel(DEFAULT_SHORTCUT, mac) })}
          </Button>
        )}
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {line}
      </p>
    </div>
  );
}
