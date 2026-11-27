// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryTarget } from "@j3-bots/contracts";
import { MonitorDotIcon } from "lucide-react";
import { useI18n } from "../app/context";
import { Button } from "./ui/button";

/**
 * Where a bot's offer to record the screen leads (decision 0098): `here`, the
 * desktop app's recorder; `elsewhere`, where there is none, as in a browser,
 * to the app on the operator's computer.
 */
export type RecordScreen =
  | { readonly _tag: "here"; readonly record: () => void }
  | { readonly _tag: "elsewhere" };

/** Where an offer in `target` leads, with the shell's recorder when it has one. */
export const recordScreenIn = (
  record: ((target: EntryTarget) => void) | undefined,
  target: EntryTarget,
): RecordScreen =>
  record === undefined ? { _tag: "elsewhere" } : { _tag: "here", record: () => record(target) };

/**
 * A bot's offer to record the screen, under its message: Record your screen
 * where this app records, and where it does not, a quiet line saying where
 * it can be done instead of a button that cannot.
 */
export function RecordOffer({ recording }: { readonly recording: RecordScreen }) {
  const { t } = useI18n();
  if (recording._tag === "here") {
    return (
      <Button variant="outline" size="sm" onClick={recording.record}>
        <MonitorDotIcon aria-hidden />
        {t("message.offer.recordScreen")}
      </Button>
    );
  }
  return (
    <p className="flex max-w-(--layout-bubble-width) items-start gap-1.5 ps-1 text-xs text-muted-foreground">
      <MonitorDotIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      {t("message.offer.recordScreen.elsewhere")}
    </p>
  );
}
