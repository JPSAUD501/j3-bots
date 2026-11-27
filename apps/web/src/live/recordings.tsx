// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import { useReadable } from "@j3-bots/client-runtime/react";
import type { DeviceId, EntryTarget } from "@j3-bots/contracts";
import type { RecorderFace, RecordingDelivery, RecordingId } from "@j3-bots/desktop-bridge";
import * as DateTime from "effect/DateTime";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";
import { useI18n } from "../app/context";
import { RecordSheet, type RecordSheetFor } from "../record/RecordSheet";
import type { Desktop } from "./desktop";

/** Who a recording is for, as the sheet names them and the control shows them. */
export interface RecordingRecipient {
  readonly name: string;
  /** The bot's face; `null` in a room. */
  readonly face: RecorderFace | null;
}

/** A recording's local start, for its file's name: `2026-11-27 14.05`. */
const fileDate = (startedAt: DateTime.Utc): string => {
  const at = DateTime.toDate(startedAt);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}`;
};

// Recordings this page put in a draft: the app hands each ready one over
// every time a page listens, until the draft releases it, once the server
// holds it or the operator takes it out.
const attached = new Set<RecordingId>();

/**
 * Screen recording in the main window (decision 0098), where the desktop app
 * records and the server takes recordings: the intent that opens the sheet
 * on a conversation or room, the sheet itself, and each recording that ends,
 * put in its draft as a file. A recording for another pairing than this
 * page's waits in the app for that one.
 */
export function useScreenRecordings({
  j3,
  app,
  pairing,
  recipientOf,
  openTarget,
  say,
}: {
  readonly j3: J3Client;
  readonly app: Desktop | null;
  readonly pairing: DeviceId | null;
  readonly recipientOf: (target: EntryTarget) => RecordingRecipient | null;
  readonly openTarget: (target: EntryTarget) => void;
  readonly say: (text: string) => void;
}): {
  /** Opens the sheet on `target`; absent where nothing records. */
  readonly recordScreen: ((target: EntryTarget) => void) | undefined;
  readonly sheet: ReactNode;
} {
  const { t } = useI18n();
  const taken = useReadable(j3.screenRecordings);
  const [sheet, setSheet] = useState<RecordSheetFor | null>(null);

  const open = (target: EntryTarget) => {
    const recipient = recipientOf(target);
    if (pairing === null || recipient === null) return;
    setSheet({ target, pairing, recipient: recipient.name, face: recipient.face });
  };

  const delivered = useEffectEvent((delivery: RecordingDelivery) => {
    switch (delivery._tag) {
      case "ready": {
        if (delivery.pairing !== pairing || attached.has(delivery.id) || app === null) return;
        attached.add(delivery.id);
        const { id, target } = delivery;
        void j3
          .attachRecording(target, {
            name: t("recording.fileName", { date: fileDate(delivery.startedAt) }),
            size: delivery.size,
            read: (start, end) => app.recording.read(id, start, end),
            release: () => app.recording.release(id),
          })
          .then(
            (taken) => taken,
            () => false,
          )
          .then((taken) => {
            // Not taken, it stays in the app, which offers it again.
            if (!taken) {
              attached.delete(id);
              return;
            }
            openTarget(target);
            if (delivery.interrupted) {
              say(t("recording.interrupted", { name: recipientOf(target)?.name ?? "" }));
            }
          });
        return;
      }
      case "failed":
        say(t(`recording.failed.${delivery.reason}`));
        return;
      // The operator threw it away; the window is back, and that says it all.
      case "discarded":
        return;
    }
  });
  // Listening asks the app for every recording it keeps, so only once this
  // page has a pairing and a server that takes them.
  const ready = app !== null && taken && pairing !== null;
  useEffect(() => (ready ? app.recording.onRecording(delivered) : undefined), [app, ready]);

  return {
    recordScreen: ready ? open : undefined,
    sheet:
      app === null ? null : (
        <RecordSheet app={app.recording} recording={sheet} onClose={() => setSheet(null)} />
      ),
  };
}
